import { describe, expect, it } from 'vitest';
import { JevClient } from '../../jev/client';
import { alternateHistoricalFactCheck, runInvestigation, selectDeepReadPlan, type SearchProvider } from '../run';
import type { InvestigationEvent } from '../contracts/events';
import type { PageReadOutcome } from '../report';
import { parseDeepReadSelectionAudit } from '../deep-read-audit';
import { makeCandidate, makeExact, makeJudgment } from './testkit';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localResearchService } from '../../research/service';
import { parseResearchCaseView } from '../../research/client';
import { parseSavedVideoReport, savedVideoView } from '../../research/saved-video';

const factUrl = 'https://fact.example/article';
const alternateUrl = 'https://alternate.example/article';
const coreUrls = ['https://anchor.example/post', 'https://recovery.example/post', 'https://last.example/post'];
const reportingUrl = 'https://reporting.example/article';
const originalUrl = 'https://original.example/video?id=2015';
const prose = 'Retrieved alternate passage describes a historical video without verifying the submitted media. '.repeat(25);
const article = (url: string, linked = false) => `<html><head><title>Retrieved source</title><script type="application/ld+json">${JSON.stringify({ '@type': 'Article', url, datePublished: '2015-02-01' })}</script></head><body><article><p>${prose}</p>${linked ? `<p>The original video appeared in 2015. <a href="${originalUrl}">Earlier post</a></p>` : ''}</article></body></html>`;

async function investigate(outcome: 'empty' | 'failed' | 'rejected' | 'usable', options: { link?: boolean; deadline?: boolean; abort?: boolean; weaker?: boolean } = {}) {
  let now = Date.parse('2026-10-03T00:00:00Z');
  const controller = new AbortController();
  const searches: string[] = [], fetches: string[] = [], asks: string[] = [];
  const serpapi: SearchProvider = {
    uploadImage: async () => 'offline-image',
    search: async params => {
      searches.push(`${params.engine}:${params.type ?? ''}`);
      if (params.type === 'exact_matches') return { exact_matches: coreUrls.map((link, index) => ({ position: index + 1, title: `Core ${index}`, link })) };
      if (params.type === 'all') return { visual_matches: [
        { position: 1, title: 'Frozen fact-check: old video in 2015', link: factUrl },
        { position: 2, title: 'Alternate fact-check: earlier video in 2015', link: alternateUrl },
      ] };
      if (params.engine === 'google_news') return { news_results: [{ position: 1, title: 'Current reporting', link: reportingUrl }] };
      return {};
    },
  };
  const jev = new JevClient({ apiKey: 'offline-only', fetchImpl: async (_url, init) => {
    const input = String(init?.body); asks.push(input);
    const alternate = input.includes('Alternate fact-check');
    const frozen = input.includes('Frozen fact-check');
    const refined = alternate && input.includes('Retrieved alternate passage');
    const fact = frozen ? 1 : alternate && !refined ? options.weaker ? .99 : 1 : 0;
    const reporting = input.includes('Current reporting') ? 1 : 0;
    const core = coreUrls.findIndex((_url, index) => input.includes(`Core ${index}`));
    const relevance = alternate ? refined ? .95 : .68 : frozen ? .79 : reporting ? .95 : .9 - Math.max(0, core) * .05;
    return Response.json({ model: 'jev-1.13.0', answers: {
      relevance: { type: 'noul', noul: relevance },
      page_role: { type: 'choice', choice: fact ? 'FACT_CHECK' : reporting ? 'REPORTING' : 'OTHER', probabilities: { REPORTING: reporting, FACT_CHECK: fact, SOCIAL_REPOST: 0, AGGREGATOR: 0, COMMENTARY: 0, OTHER: 1 - fact - reporting } },
    } });
  } });
  const events: InvestigationEvent[] = [];
  await runInvestigation({ media: new Uint8Array([1]), claim: 'This video shows a current event', timezone: 'UTC', locale: 'en' }, event => events.push(event), {
    serpapi, jev, now: () => now, signal: controller.signal,
    fetchPage: async url => {
      fetches.push(url);
      if (url === factUrl) {
        if (options.deadline) now += 55_001;
        if (options.abort) controller.abort();
        if (outcome === 'failed') throw new Error('Controlled unavailable source');
        if (outcome === 'rejected') return { url: 'https://other.example/article', html: article(url) };
        if (outcome === 'usable') return { url, html: article(url) };
      }
      if (url === alternateUrl) return { url, html: article(url, true) };
      if (url === reportingUrl) return { url, html: article(url, options.link) };
      return { url, html: '<html><body></body></html>' };
    },
  });
  const terminal = events.find(event => event.type === 'investigation.completed');
  return { terminal, fetches, searches, asks, events };
}

describe('bounded adaptive final fact-check read (synthetic offline sources)', () => {
  it.each(['empty', 'failed', 'rejected'] as const)('uses the tied-role historical alternative after a %s frozen fact-check read', async outcome => {
    const { terminal, fetches, searches, events } = await investigate(outcome);
    expect(fetches).toHaveLength(5);
    expect(fetches.at(-1)).toBe(alternateUrl);
    expect(fetches).not.toContain(coreUrls[2]);
    expect(fetches).not.toContain(originalUrl);
    expect(searches.length).toBeLessThanOrEqual(6);
    expect(new Set(events.flatMap(event => event.type === 'evidence.classified' ? [event.id] : [])).size).toBeLessThanOrEqual(24);
    if (terminal?.type !== 'investigation.completed' || terminal.result.mode !== 'claim_check') throw new Error('Missing completed claim result');
    expect(terminal.result.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(terminal.result.earliestObservedOccurrence).toBeNull();
    const read = terminal.result.sourceLinkedReport?.pageReads.find(item => item.requestedUrl === alternateUrl);
    expect(read).toMatchObject({ selection: 'selected', fetch: 'succeeded', extraction: 'usable_text', sourceBinding: 'same_resource' });
    expect(read?.sourceLinks?.[0]).toMatchObject({ url: originalUrl, followup: 'page_limit' });
    expect(terminal.result.sourceLinkedReport?.provenanceCompleteness.originalPublication.status).toBe('unknown');
    const all = [...terminal.result.timeline, ...terminal.result.undatedEvidence, ...terminal.result.supportingEvidence, ...terminal.result.contextualEvidence];
    const audit = parseDeepReadSelectionAudit(terminal.result.sourceLinkedReport?.readSelectionAudit, all);
    const frozen = audit?.candidates.find(row => row.sourceUrl === alternateUrl);
    expect(frozen).toMatchObject({ judgment: { kind: 'assessed', relevance: .68, factCheck: 1 }, historicalMediaCue: true, plan: { kind: 'not_selected' } });
    expect(audit?.finalDecision).toMatchObject({ kind: 'alternate_fact_check', evidenceId: read?.evidenceId });
    expect(all.find(item => item.sourceUrl === alternateUrl)?.jevDistributions).toMatchObject({ relevance: .95, pageRole: { factCheck: 0 } });
  });

  it('preserves the original recovery read after usable fact-check text or a weaker alternative role', async () => {
    for (const input of [{ outcome: 'usable', weaker: false }, { outcome: 'empty', weaker: true }] as const) {
      const { fetches } = await investigate(input.outcome, { weaker: input.weaker });
      expect(fetches.at(-1)).toBe(coreUrls[2]);
      expect(fetches).not.toContain(alternateUrl);
    }
  });
  it('gives an inspected source link priority over the alternate article', async () => {
    const { fetches } = await investigate('empty', { link: true });
    expect(fetches.at(-1)).toBe(originalUrl);
    expect(fetches).not.toContain(alternateUrl);
    expect(fetches).toHaveLength(5);
  });
  it.each(['deadline', 'abort'] as const)('starts no alternate request after %s', async stop => {
    const { fetches } = await investigate('empty', { [stop]: true });
    expect(fetches.length).toBeLessThanOrEqual(4);
    expect(fetches).not.toContain(alternateUrl);
    expect(fetches).not.toContain(coreUrls[2]);
  });
  it('preserves the original selection trace through save/reopen, edits and revert; old/malformed traces remain readable', async () => {
    const { terminal, asks, fetches } = await investigate('empty');
    if (terminal?.type !== 'investigation.completed' || !terminal.result.caseRecord) throw new Error('Missing completed case');
    const result = { kind: 'video', question: 'Claim: This video shows a current event', caseRecord: terminal.result.caseRecord,
      frames: [{ timestampMs: 0, imageResult: terminal.result }], limitations: [], assessments: [] };
    const report = parseSavedVideoReport({ schemaVersion: 'contexttrail-video-report-v1', result });
    const originalAudit = savedVideoView(report).frames[0].imageResult.readSelectionAudit;
    expect(originalAudit?.finalDecision.kind).toBe('alternate_fact_check');
    const networkCounts = [asks.length, fetches.length];
    const directory = await mkdtemp(join(tmpdir(), 'ct-frozen-read-save-'));
    try {
      const service = localResearchService(directory);
      await service.apply({ kind: 'import_case', operationId: 'save', question: result.question, createdAt: result.caseRecord.createdAt, caseRecord: result.caseRecord, videoReport: report });
      const reopened = parseResearchCaseView(await localResearchService(directory).get(result.caseRecord.id));
      expect(reopened.videoReportStatus).toBe('current');
      expect(reopened.videoReport?.result).toEqual(result);
      const evidence = result.caseRecord.evidence[0];
      await service.apply({ kind: 'update', caseId: result.caseRecord.id, operationId: 'edit', expectedRevision: 1, change: { kind: 'evidence', value: { ...evidence, title: 'User correction' }, assets: [] } });
      const edited = parseResearchCaseView(await localResearchService(directory).get(result.caseRecord.id));
      expect(edited.videoReportStatus).toBe('stale');
      if (!edited.videoReport) throw new Error('Lost original report');
      expect(savedVideoView(edited.videoReport).frames[0].imageResult.readSelectionAudit).toEqual(originalAudit);
      await service.apply({ kind: 'update', caseId: result.caseRecord.id, operationId: 'revert', expectedRevision: 2, change: { kind: 'evidence', value: evidence, assets: [] } });
      const reverted = parseResearchCaseView(await localResearchService(directory).get(result.caseRecord.id));
      expect(reverted.videoReportStatus).toBe('stale');
      expect(reverted.videoReport?.result).toEqual(result);
      expect([asks.length, fetches.length]).toEqual(networkCounts);
    } finally { await rm(directory, { recursive: true, force: true }); }
    const legacy = structuredClone(result);
    if (legacy.frames[0].imageResult.sourceLinkedReport) delete legacy.frames[0].imageResult.sourceLinkedReport.readSelectionAudit;
    expect(savedVideoView(parseSavedVideoReport({ schemaVersion: 'contexttrail-video-report-v1', result: legacy })).frames[0].imageResult.readSelectionAudit).toBeNull();
    const malformed = { ...result, frames: [{ ...result.frames[0], imageResult: { ...terminal.result, sourceLinkedReport: { ...terminal.result.sourceLinkedReport, readSelectionAudit: { schemaVersion: 'future', candidates: [] } } } }] };
    const retained = parseSavedVideoReport({ schemaVersion: 'contexttrail-video-report-v1', result: malformed });
    expect(savedVideoView(retained).frames[0].imageResult.readSelectionAudit).toBeNull();
    expect(retained.result).toEqual(malformed);
    expect(savedVideoView(retained).frames[0].imageResult.captionComparison?.status).toBe('INSUFFICIENT_EVIDENCE');
  });
});

const pureJudgment = (relevance: number, factCheck = 0, reporting = 0) => makeJudgment({ relevance, contextRelation: null, claimRelation: null,
  pageRole: { factCheck, reporting, socialRepost: 0, aggregator: 0, commentary: 0, other: 1 - factCheck - reporting } });
function pool() {
  return [
    makeExact({ id: 'anchor', sourceUrl: coreUrls[0], judgment: pureJudgment(.9) }),
    makeCandidate({ id: 'fact', sourceUrl: factUrl, title: 'Old video in 2015', judgment: pureJudgment(.79, 1) }),
    makeCandidate({ id: 'reporting', sourceUrl: reportingUrl, judgment: pureJudgment(.95, 0, 1) }),
    makeExact({ id: 'recovery', sourceUrl: coreUrls[1], judgment: pureJudgment(.85) }),
    makeExact({ id: 'last', sourceUrl: coreUrls[2], judgment: pureJudgment(.8) }),
    makeCandidate({ id: 'alternate', sourceUrl: alternateUrl, title: 'Earlier video posted in 2015', judgment: pureJudgment(.68, 1) }),
  ];
}
function firstReads(plan: ReturnType<typeof selectDeepReadPlan>): PageReadOutcome[] {
  return plan.slice(0, 4).map(({ candidate }) => ({ evidenceId: candidate.id, requestedUrl: candidate.sourceUrl, finalUrl: candidate.sourceUrl,
    sourceBinding: 'same_resource', selection: 'selected', fetch: 'succeeded', extraction: candidate.id === 'fact' ? 'empty_text' : 'usable_text', failureCode: null, httpStatus: null }));
}
describe('adaptive acquisition guards and deterministic ordering', () => {
  it.each([
    ['weaker role', { judgment: pureJudgment(.99, .99) }],
    ['unassessed', { judgment: null }],
    ['no historical cue', { title: 'Current video report' }],
    ['oversized cue', { title: 'Earlier video in 2015 ' + 'x'.repeat(1200) }],
    ['private URL', { sourceUrl: 'http://127.0.0.1/a' }],
    ['credentials', { sourceUrl: 'https://user:secret@alternate.example/a' }],
    ['secret parameter', { sourceUrl: 'https://alternate.example/a?token=secret' }],
    ['normalized already requested', { sourceUrl: `${factUrl}?utm_source=repeat#article` }],
  ])('keeps the original final page for %s', (_label, changes) => {
    const candidates = pool(), plan = selectDeepReadPlan(candidates), reads = firstReads(plan);
    candidates[5] = makeCandidate({ ...candidates[5], ...changes });
    expect(alternateHistoricalFactCheck({ plan, candidates, reads })).toBeNull();
  });
  it('retains query-addressed distinct resources and sorts tied alternatives by relevance, rank and ID', () => {
    const candidates = pool(), plan = selectDeepReadPlan(candidates), reads = firstReads(plan);
    const first = makeCandidate({ ...candidates[5], id: 'a', sourceUrl: `${factUrl}?id=other`, serpPosition: 20 });
    const second = makeCandidate({ ...first, id: 'b', sourceUrl: 'https://second.example/article' });
    expect(alternateHistoricalFactCheck({ plan, candidates: [...candidates.slice(0, 5), second, first], reads })?.id).toBe('a');
    expect(alternateHistoricalFactCheck({ plan, candidates: [...candidates.slice(0, 5), first, second], reads })?.id).toBe('a');
    expect(alternateHistoricalFactCheck({ plan, candidates: [...candidates.slice(0, 5), first, { ...second, serpPosition: 1 }], reads })?.id).toBe('b');
    expect(alternateHistoricalFactCheck({ plan, candidates: [...candidates.slice(0, 5), first, { ...second, judgment: pureJudgment(.69, 1) }], reads })?.id).toBe('b');
  });
  it('never displaces a protected fifth role', () => {
    const candidates = pool();
    candidates[0].judgment = pureJudgment(.99);
    const conflict = makeExact({ id: 'conflict', judgment: makeJudgment({ relevance: .95, contextRelation: { sameContext: 0, differentContext: 1, historicalReference: 0, unclear: 0 }, claimRelation: { supports: 0, contradicts: 1, neutral: 0, insufficient: 0 } }) });
    const support = makeExact({ id: 'support', judgment: makeJudgment({ relevance: .94, claimRelation: { supports: 1, contradicts: 0, neutral: 0, insufficient: 0 } }) });
    const protectedPool = [candidates[0], conflict, support, candidates[1], candidates[2], candidates[5]];
    const plan = selectDeepReadPlan(protectedPool);
    expect(plan[4].reason).toBe('current_reporting');
    expect(alternateHistoricalFactCheck({ plan, candidates: protectedPool, reads: firstReads(plan) })).toBeNull();
  });
  it('does not react to an unattempted, aborted or extraction-failed fact-check', () => {
    const candidates = pool(), plan = selectDeepReadPlan(candidates), reads = firstReads(plan);
    for (const changes of [{ selection: 'not_selected', fetch: 'not_attempted', extraction: 'not_attempted' },
      { fetch: 'failed', failureCode: 'aborted' }, { extraction: 'failed' }] as const) {
      expect(alternateHistoricalFactCheck({ plan, candidates, reads: reads.map(read => read.evidenceId === 'fact' ? { ...read, ...changes } : read) })).toBeNull();
    }
  });
  it('recognizes a fact-check winner that also occupied the core-anchor role', () => {
    const candidates = pool(); candidates[0].judgment = pureJudgment(.9, 1);
    candidates.push(makeExact({ id: 'extra-core', sourceUrl: 'https://extra.example/post', judgment: pureJudgment(.7) }));
    const plan = selectDeepReadPlan(candidates), reads = firstReads(plan).map(read => read.evidenceId === 'anchor' ? { ...read, extraction: 'empty_text' as const } : read);
    expect(plan[0].reason).toBe('core_anchor');
    expect(alternateHistoricalFactCheck({ plan, candidates, reads })?.id).toBe('fact');
  });
});
