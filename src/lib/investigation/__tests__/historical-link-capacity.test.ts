import { describe, expect, it } from 'vitest';
import { JevClient } from '../../jev/client';
import { runInvestigation, type SearchProvider } from '../run';
import type { InvestigationEvent } from '../contracts/events';
import { parseDeepReadSelectionAudit } from '../deep-read-audit';
import { mkdir, writeFile } from 'node:fs/promises';
import { parseAutomaticResearchResult } from '../../research/automatic-client';
import { parseSavedVideoReport, savedVideoView } from '../../research/saved-video';

const parentUrl = 'https://history.example/article';
const linkedUrl = 'https://archive.example/video?id=earlier';
const prose = 'This controlled source describes an earlier video but does not establish the identity of the submitted media. '.repeat(25);
const article = (url: string, link: boolean) => `<html><head><title>Controlled source</title></head><body><article><p>${prose}</p>${link ? `<p>The original video was posted in 2017. <a href="${linkedUrl}">Earlier source</a></p>` : ''}</article></body></html>`;

async function saturatedRun(options: { cue?: boolean; link?: boolean; existingUnadmitted?: boolean; failLinked?: boolean; emptyLinked?: boolean; failModel?: boolean; deadline?: boolean; rejectedBinding?: boolean; datedExact?: boolean } = {}) {
  const fetches: string[] = [], searches: string[] = [], asks: { domain: string; questions: number; refined: boolean }[] = [];
  const admissionsAtFetch: number[] = [];
  let now = Date.parse('2026-10-04T00:00:00Z');
  let uploads = 0;
  const serpapi: SearchProvider = {
    uploadImage: async () => { uploads++; return 'offline-image'; },
    search: async params => {
      searches.push(`${params.engine}:${params.type ?? ''}`);
      const rows = (kind: string, count: number) => Array.from({ length: count }, (_, i) => ({ position: i + 1, title: `${kind} ${i}`, link: `https://${kind}${i}.example/post` }));
      if (params.type === 'exact_matches') return { exact_matches: rows('exact', 8) };
      if (params.type === 'all') return { visual_matches: [{ position: 1, title: options.cue === false ? 'Current fact check' : 'Fact check: old video posted in 2017', link: parentUrl }, ...rows('visual', 7).map(row => options.existingUnadmitted && row.position === 7 ? { position: 8, title: 'Archive reference', link: linkedUrl } : { ...row, position: row.position + 1 })] };
      if (params.engine === 'google_news') return { news_results: rows('news', 5) };
      if (params.engine === 'google') return { organic_results: options.datedExact ? [...rows('context', 4), { position: 5, title: 'Exact 7', link: 'https://exact7.example/post', date: '2020-01-01' }] : rows('context', 5) };
      return {};
    },
  };
  const jev = new JevClient({ apiKey: 'offline-only', fetchImpl: async (_url, init) => {
    const input: unknown = JSON.parse(String(init?.body));
    if (!input || typeof input !== 'object' || !('state' in input) || !('questions' in input)) throw new Error('Missing request');
    const state = input.state;
    if (!state || typeof state !== 'object' || !('result' in state)) throw new Error('Missing candidate');
    const result = state.result;
    if (!result || typeof result !== 'object' || !('domain' in result) || typeof result.domain !== 'string') throw new Error('Missing domain');
    if (!input.questions || typeof input.questions !== 'object') throw new Error('Missing questions');
    const refined = 'page_excerpt' in result && typeof result.page_excerpt === 'string' && result.page_excerpt.includes('controlled source');
    asks.push({ domain: result.domain, questions: Object.keys(input.questions).length, refined });
    if (options.failModel && !refined && result.domain === 'visual0.example') throw new Error('Controlled failed classification');
    const fact = result.domain === 'history.example' ? 1 : 0;
    const reporting = result.domain.startsWith('news') ? 1 : 0;
    return Response.json({ model: 'jev-1.13.0', answers: {
      relevance: { type: 'noul', noul: fact ? .69 : reporting ? .9 : result.domain === 'archive.example' ? .2 : .8 },
      page_role: { type: 'choice', choice: fact ? 'FACT_CHECK' : reporting ? 'REPORTING' : 'OTHER', probabilities: { REPORTING: reporting, FACT_CHECK: fact, SOCIAL_REPOST: 0, AGGREGATOR: 0, COMMENTARY: 0, OTHER: 1 - fact - reporting } },
    } });
  } });
  const events: InvestigationEvent[] = [];
  await runInvestigation({ media: new Uint8Array([1]), claim: 'This video shows a current event', timezone: 'UTC', locale: 'en' }, event => events.push(event), {
    serpapi, jev, now: () => now, fetchPage: async url => {
      fetches.push(url); admissionsAtFetch.push(new Set(asks.map(ask => ask.domain)).size);
      if (url === parentUrl && options.deadline) now += 55_001;
      if (url === linkedUrl && options.failLinked) throw new Error('Controlled source failure');
      return { url: url === linkedUrl && options.rejectedBinding ? 'https://different.example/post' : url, html: url === linkedUrl && options.emptyLinked ? '<html><body></body></html>' : article(url, url === parentUrl && options.link !== false) };
    },
  });
  const completed = events.find(event => event.type === 'investigation.completed');
  if (completed?.type !== 'investigation.completed') throw new Error('Missing completion');
  return { result: completed.result, fetches, searches, asks, uploads, events, admissionsAtFetch };
}

describe('historical acquisition capacity (controlled offline pool)', () => {
  it('admits and reads the inspected historical source despite a saturated initial pool', async () => {
    const { result, fetches, asks, searches, uploads, admissionsAtFetch, events } = await saturatedRun();
    expect(fetches).toHaveLength(5);
    expect(fetches.at(-1)).toBe(linkedUrl);
    expect(result.sourceLinkedReport?.pageReads.find(read => read.requestedUrl === parentUrl)?.sourceLinks?.[0]).toMatchObject({ followup: 'selected', url: linkedUrl });
    expect(new Set(asks.map(ask => ask.domain)).size).toBe(24);
    expect(new Set(events.flatMap(event => event.type === 'evidence.classified' ? [event.id] : [])).size).toBe(24);
    expect(admissionsAtFetch).toEqual([23, 23, 23, 23, 23]);
    expect(asks.filter(ask => !ask.refined && ask.domain.startsWith('exact'))).toHaveLength(8);
    expect(asks.length).toBeLessThanOrEqual(60);
    expect(asks.reduce((sum, ask) => sum + ask.questions, 0)).toBeLessThanOrEqual(272);
    expect(asks.some(ask => ask.domain === 'archive.example' && ask.refined)).toBe(true);
    expect(searches.length).toBeLessThanOrEqual(6); expect(uploads).toBe(1);
    const all = items(result);
    expect(all.filter(item => item.sourceUrl.startsWith('https://context') || item.sourceUrl === linkedUrl)).toHaveLength(5);
    expect(all.find(item => item.sourceUrl === linkedUrl)).toMatchObject({ mediaRelationship: null, identityBasis: 'contextual', observedAt: null });
    expect(result.earliestObservedOccurrence).toBeNull();
    expect(result.mode === 'claim_check' && result.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(parseDeepReadSelectionAudit(result.sourceLinkedReport?.readSelectionAudit, all)?.finalDecision).toMatchObject({ kind: 'inspected_link' });
    expect(result.sourceLinkedReport?.readSelectionAudit?.candidates.filter(row => row.plan.kind === 'selected').sort((a, b) => (a.plan.kind === 'selected' ? a.plan.position : 0) - (b.plan.kind === 'selected' ? b.plan.position : 0)).map(row => row.plan.kind === 'selected' ? row.plan.reason : '')).toEqual(['core_anchor', 'fact_check', 'current_reporting', 'core_recovery', 'core_recovery']);
    const automatic = { kind: 'video', question: 'Claim: This video shows a current event', caseRecord: result.caseRecord,
      frames: [{ timestampMs: 0, imageResult: result }], assessments: [], limitations: [] };
    const projected = parseAutomaticResearchResult(automatic).frames[0].imageResult;
    expect(projected.readSelectionAudit).toEqual(result.sourceLinkedReport?.readSelectionAudit);
    const saved = parseSavedVideoReport(JSON.parse(JSON.stringify({ schemaVersion: 'contexttrail-video-report-v1', result: automatic })));
    expect(savedVideoView(saved).frames[0].imageResult.readSelectionAudit).toEqual(projected.readSelectionAudit);
    expect(saved.result).toEqual(automatic);
    if (process.env.CT_EXPORT_HISTORICAL === '1') {
      const directory = '.verify/historical-link-capacity';
      await mkdir(directory, { recursive: true });
      await writeFile(`${directory}/result.json`, JSON.stringify(automatic, null, 2));
      await writeFile(`${directory}/events.ndjson`, events.map(event => JSON.stringify(event)).join('\n') + '\n');
      await writeFile(`${directory}/provenance.json`, JSON.stringify({ scope: 'Actual production orchestrator with controlled synthetic search, page and Jev adapters; not a live historical recovery or captured-run replay', sourceTest: 'historical-link-capacity.test.ts', fetches, searches, uploads, asks, admissionsAtFetch,
        distinctAttemptedDomains: new Set(asks.map(ask => ask.domain)).size, questionCount: asks.reduce((sum, ask) => sum + ask.questions, 0), identity: 'New inspected reference remains contextual and undated; verdict insufficient' }, null, 2));
    }
  });

  it('adopts an existing unadmitted reference before pooled refinement consumes its slot', async () => {
    const { result, fetches, asks } = await saturatedRun({ existingUnadmitted: true });
    expect(fetches.at(-1)).toBe(linkedUrl);
    expect(asks.filter(ask => ask.domain === 'archive.example')).toHaveLength(1);
    expect(asks.find(ask => ask.domain === 'archive.example')?.refined).toBe(true);
    expect(new Set(asks.map(ask => ask.domain)).size).toBe(24);
    expect(result.sourceLinkedReport?.pageReads.find(read => read.requestedUrl === parentUrl)?.sourceLinks?.[0].followup).toBe('selected');
  });

  it('keeps ordinary allocations unchanged when metadata has no historical cue', async () => {
    const { result, fetches, asks } = await saturatedRun({ cue: false });
    expect(fetches).toHaveLength(5); expect(fetches).not.toContain(linkedUrl);
    expect(new Set(asks.map(ask => ask.domain)).size).toBe(24);
    expect(items(result).filter(item => item.sourceUrl.startsWith('https://context'))).toHaveLength(5);
    expect(result.sourceLinkedReport?.pageReads.find(read => read.requestedUrl === parentUrl)?.sourceLinks?.[0].followup).toBe('classification_limit');
  });

  it('defers an existing unadmitted reference when no reservation was established', async () => {
    const { result, fetches, asks } = await saturatedRun({ cue: false, existingUnadmitted: true });
    expect(new Set(asks.map(ask => ask.domain)).size).toBe(24);
    expect(fetches).not.toContain(linkedUrl);
    expect(asks.some(ask => ask.domain === 'archive.example')).toBe(false);
    expect(result.sourceLinkedReport?.pageReads.find(read => read.requestedUrl === parentUrl)?.sourceLinks?.[0].followup).toBe('classification_limit');
  });

  it('does not add reads or fabricate a source when the reserved run exposes no historical anchor', async () => {
    const { result, fetches, asks } = await saturatedRun({ link: false });
    expect(fetches).toHaveLength(5); expect(fetches).not.toContain(linkedUrl);
    expect(new Set(asks.map(ask => ask.domain)).size).toBe(23);
    expect(items(result).filter(item => item.sourceUrl.startsWith('https://context'))).toHaveLength(4);
    expect(result.sourceLinkedReport?.readSelectionAudit?.finalDecision.kind).toBe('original_plan');
  });

  it('preserves the independently dated exact anchor and all eight exact admissions', async () => {
    const { fetches, asks, result } = await saturatedRun({ datedExact: true });
    expect(fetches[0]).toBe('https://exact7.example/post');
    expect(asks[0].domain).toBe('exact7.example');
    expect(new Set(asks.filter(ask => ask.domain.startsWith('exact')).map(ask => ask.domain)).size).toBe(8);
    expect(result.timeline.find(item => item.sourceUrl === 'https://exact7.example/post')).toMatchObject({ mediaRelationship: 'EXACT_MATCH', observedAt: '2020-01-01' });
    expect(items(result).find(item => item.sourceUrl === linkedUrl)).toMatchObject({ mediaRelationship: null, identityBasis: 'contextual', observedAt: null });
    expect(fetches).toHaveLength(5); expect(fetches.at(-1)).toBe(linkedUrl);
  });

  it.each(['failLinked', 'emptyLinked', 'rejectedBinding', 'failModel', 'deadline'] as const)('preserves caps and conservative outcomes after %s', async failure => {
    const { result, fetches, asks } = await saturatedRun({ [failure]: true });
    expect(fetches.length).toBeLessThanOrEqual(5);
    expect(new Set(asks.map(ask => ask.domain)).size).toBeLessThanOrEqual(24);
    expect(asks.length).toBeLessThanOrEqual(60);
    expect(asks.reduce((sum, ask) => sum + ask.questions, 0)).toBeLessThanOrEqual(272);
    expect(result.earliestObservedOccurrence).toBeNull();
    expect(result.mode === 'claim_check' && result.status).toBe('INSUFFICIENT_EVIDENCE');
    if (failure === 'deadline') expect(fetches).not.toContain(linkedUrl);
    if (failure === 'failLinked') expect(result.sourceLinkedReport?.pageReads.find(read => read.requestedUrl === linkedUrl)?.fetch).toBe('failed');
    if (failure === 'rejectedBinding') expect(result.sourceLinkedReport?.pageReads.find(read => read.requestedUrl === linkedUrl)?.sourceBinding).toBe('different_resource');
  });
});

const items = (result: Awaited<ReturnType<typeof saturatedRun>>['result']) => [...result.timeline, ...result.undatedEvidence, ...result.supportingEvidence, ...result.contextualEvidence];
