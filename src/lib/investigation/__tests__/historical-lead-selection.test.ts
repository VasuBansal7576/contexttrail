import { describe, expect, it } from 'vitest';
import { JevClient } from '../../jev/client';
import { runInvestigation, selectDeepReadCandidates, type SearchProvider } from '../run';
import { evaluateClaimPolicy } from '../policy';
import type { InvestigationEvent } from '../contracts/events';
import { makeCandidate, makeExact, makeJudgment } from './testkit';

const otherRole = { reporting: 0, factCheck: 0, socialRepost: 0, aggregator: 0, commentary: 0, other: 1 };
const judgment = (relevance = .9) => makeJudgment({ relevance, contextRelation: null, claimRelation: null, pageRole: otherRole });
const historical = () => makeCandidate({ id: 'history', title: 'Earlier video posted in 2015', judgment: judgment(.8), serpPosition: 10 });
const ordinary = () => Array.from({ length: 6 }, (_, i) => makeCandidate({ id: `ordinary-${i}`, title: 'Current context', judgment: judgment(.99 - i * .01), serpPosition: i + 1 }));
const factCheck = () => makeCandidate({ id: 'fact-check', title: 'Caption investigation', judgment: makeJudgment({ ...judgment(.99), pageRole: { ...otherRole, factCheck: 1, other: 0 } }) });

describe('retained historical media leads in otherwise open deep-read slots', () => {
  it('reads one relevant historical lead before ordinary filler without promoting it', () => {
    const lead = historical();
    const second = makeCandidate({ ...historical(), id: 'second-history', judgment: judgment(.75) });
    const before = structuredClone(lead);
    const pool = [factCheck(), ...ordinary(), lead, second];
    expect(selectDeepReadCandidates(pool).map(c => c.id)).toEqual(['fact-check', 'history', 'ordinary-0', 'ordinary-1', 'ordinary-2']);
    expect(selectDeepReadCandidates([...pool].reverse()).map(c => c.id)).toEqual(['fact-check', 'history', 'ordinary-0', 'ordinary-1', 'ordinary-2']);
    expect(lead).toEqual(before);
    expect(evaluateClaimPolicy([lead]).status).toBe('INSUFFICIENT_EVIDENCE');
    expect(lead.publishedAt).toBeNull();
    expect(lead.identityEvidence.basis).toBe('unverified');
  });

  it('uses the existing relevance, rank and id tie-breakers for the single cue slot', () => {
    const lead = historical();
    const a = makeCandidate({ ...lead, id: 'a' });
    const b = makeCandidate({ ...lead, id: 'b' });
    const ranked = makeCandidate({ ...lead, id: 'z', serpPosition: 1 });
    const pool = [b, a, lead, ...ordinary()];
    expect(selectDeepReadCandidates(pool, 1)).toEqual([a]);
    expect(selectDeepReadCandidates([...pool].reverse(), 1)).toEqual([a]);
    expect(selectDeepReadCandidates([...pool, ranked], 1)).toEqual([ranked]);
    expect(selectDeepReadCandidates(pool, 0)).toEqual([]);
  });

  it('preserves every frozen role including the fifth current-reporting priority', () => {
    const anchor = makeExact({ id: 'anchor', title: 'Undated media', judgment: judgment(.99) });
    const conflict = makeExact({ id: 'conflict', judgment: makeJudgment({ ...judgment(.95), claimRelation: { supports: 0, contradicts: 1, neutral: 0, insufficient: 0 } }) });
    const support = makeExact({ id: 'support', judgment: makeJudgment({ ...judgment(.94), claimRelation: { supports: 1, contradicts: 0, neutral: 0, insufficient: 0 } }) });
    const reporting = makeCandidate({ id: 'reporting', retrievalKind: 'google_news', judgment: judgment(.93) });
    expect(selectDeepReadCandidates([historical(), reporting, support, conflict, factCheck(), anchor]).map(c => c.id))
      .toEqual(['anchor', 'conflict', 'support', 'fact-check', 'reporting']);
  });

  it('preserves undated core recovery and disables cue priority when dated core exists', () => {
    const cores = Array.from({ length: 5 }, (_, i) => makeExact({ id: `core-${i}`, judgment: judgment(.6 - i * .01) }));
    expect(selectDeepReadCandidates([historical(), ...cores])).toEqual(cores);
    const dated = makeExact({ id: 'dated', publishedAt: '2020-01-01', dateStatus: 'usable', datePrecision: 'day', judgment: judgment(.9) });
    expect(selectDeepReadCandidates([historical(), dated, ...ordinary()]).map(c => c.id)).toEqual(['dated', 'ordinary-0', 'ordinary-1', 'ordinary-2', 'ordinary-3']);
  });

  it.each([
    ['current media', { title: 'Current video report', snippet: null }],
    ['bare date', { title: 'Earlier event in 2015', snippet: null }],
    ['unrelated', { title: 'Subscription terms', snippet: null }],
    ['low relevance', { judgment: judgment(.699) }],
    ['unclassified', { judgment: null }],
    ['private address', { sourceUrl: 'http://127.0.0.1/article' }],
    ['credentials', { sourceUrl: 'https://user:secret@archive.example/article' }],
    ['secret query', { sourceUrl: 'https://archive.example/article?token=secret' }],
    ['oversized cue', { title: 'Earlier video in 2015 ' + 'x'.repeat(1200) }],
  ])('does not reserve a slot for %s', (_label, changes) => {
    const candidate = makeCandidate({ ...historical(), ...changes });
    expect(selectDeepReadCandidates([...ordinary(), candidate]).map(c => c.id)).toEqual(['ordinary-0', 'ordinary-1', 'ordinary-2', 'ordinary-3', 'ordinary-4']);
  });

  it('allows a bounded snippet cue and does not duplicate a cue already selected by a frozen role', () => {
    const lead = makeCandidate({ ...historical(), title: 'Source context', snippet: 'This footage was previously posted.' });
    expect(selectDeepReadCandidates([...ordinary(), lead], 1)).toEqual([lead]);
    const frozen = makeCandidate({ ...historical(), judgment: makeJudgment({ ...judgment(.95), pageRole: { ...otherRole, factCheck: 1, other: 0 } }) });
    const second = makeCandidate({ ...historical(), id: 'second-history', judgment: judgment(.75) });
    expect(selectDeepReadCandidates([frozen, second, ...ordinary()]).map(c => c.id)).toEqual(['history', 'ordinary-0', 'ordinary-1', 'ordinary-2', 'ordinary-3']);
  });
});

describe('offline retained article to inspected original acquisition', () => {
  it.each(['success', 'failed', 'empty', 'rejected binding', 'deadline'] as const)('keeps caps and unknown media identity after a %s original read', async outcome => {
    const historyUrl = 'https://history.example/article';
    const originalUrl = 'https://archive.example/post?id=original';
    const filler = Array.from({ length: 4 }, (_, i) => ({ position: i + 1, title: 'Current context', link: `https://ordinary${i}.example/article` }));
    const leads = [{ position: 1, title: 'Earlier video posted in 2015', link: historyUrl }];
    const searches: string[] = [];
    const serpapi: SearchProvider = {
      uploadImage: async () => 'offline-image',
      search: async params => {
        searches.push(`${params.engine}:${params.type ?? ''}`);
        if (params.type === 'all') return { visual_matches: leads };
        if (params.engine === 'google') return { organic_results: filler };
        return {};
      },
    };
    const jev = new JevClient({ apiKey: 'offline-only', fetchImpl: async (_url, init) => Response.json({ model: 'jev-1.13.0', answers: {
      relevance: { type: 'noul', noul: String(init?.body).includes('"title":"Current context"') ? .99 : .9 },
      page_role: { type: 'choice', choice: 'OTHER', probabilities: { REPORTING: 0, FACT_CHECK: 0, SOCIAL_REPOST: 0, AGGREGATOR: 0, COMMENTARY: 0, OTHER: 1 } },
    } }) });
    let now = Date.parse('2026-10-03T00:00:00Z');
    const fetches: string[] = [];
    const events: InvestigationEvent[] = [];
    await runInvestigation({ media: new Uint8Array([1]), claim: 'This video shows a current event', timezone: 'UTC', locale: 'en' }, event => events.push(event), {
      serpapi, jev, now: () => now,
      fetchPage: async url => {
        fetches.push(url);
        if (url === originalUrl && outcome === 'failed') throw new Error('Controlled unavailable source');
        if (url === originalUrl && outcome === 'empty') return { url, html: '<html><body></body></html>' };
        if (url === originalUrl && outcome === 'rejected binding') return { url: 'https://other.example/article', html: '<article>Wrong resource</article>' };
        if (url === historyUrl && outcome === 'deadline') now += 55_001;
        const body = url === historyUrl ? `<p>The original video was posted in 2015. <a href="${originalUrl}">Earlier post</a></p>` : '<p>Source context.</p>';
        return { url, html: `<html><head><title>Retrieved source</title><script type="application/ld+json">${JSON.stringify({ '@type': 'Article', url, datePublished: '2015-02-01' })}</script></head><body><article>${body}<p>${'Historical source material describes the event without establishing submitted media identity. '.repeat(30)}</p></article></body></html>` };
      },
    });
    const terminal = events.find(event => event.type === 'investigation.completed');
    if (terminal?.type !== 'investigation.completed' || terminal.result.mode !== 'claim_check') throw new Error('Missing claim result');
    const result = terminal.result;
    expect(fetches).toContain(historyUrl);
    expect(fetches.length).toBeLessThanOrEqual(5);
    expect(searches.length).toBeLessThanOrEqual(6);
    expect(new Set(events.flatMap(event => event.type === 'evidence.classified' ? [event.id] : [])).size).toBeLessThanOrEqual(24);
    expect(result.timeline).toEqual([]);
    expect(result.earliestObservedOccurrence).toBeNull();
    expect(result.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.sourceLinkedReport?.provenanceCompleteness.originalPublication.status).toBe('unknown');
    const historyRead = result.sourceLinkedReport?.pageReads.find(read => read.requestedUrl === historyUrl);
    expect(historyRead?.sourceLinks?.[0]).toMatchObject({ url: originalUrl, followup: outcome === 'deadline' ? 'deadline' : 'selected' });
    if (outcome === 'deadline') {
      expect(fetches).not.toContain(originalUrl);
      return;
    }
    expect(fetches).toHaveLength(5);
    expect(fetches.at(-1)).toBe(originalUrl);
    expect(fetches).not.toContain(filler[3].link);
    const read = result.sourceLinkedReport?.pageReads.find(item => item.requestedUrl === originalUrl);
    expect(read).toMatchObject({ selection: 'selected', fetch: outcome === 'failed' ? 'failed' : 'succeeded',
      extraction: outcome === 'success' ? 'usable_text' : outcome === 'empty' ? 'empty_text' : 'not_attempted',
      failureCode: outcome === 'failed' ? 'unknown' : outcome === 'rejected binding' ? 'source_binding_rejected' : null });
    const linked = [...result.contextualEvidence, ...result.undatedEvidence].find(item => item.sourceUrl === originalUrl);
    expect(linked).toMatchObject({ mediaRelationship: null, identityBasis: 'contextual', observedAt: outcome === 'success' ? '2015-02-01' : null });
  });
});
