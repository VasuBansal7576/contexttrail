import { describe, expect, it } from 'vitest';
import { extractPage } from '../../pages/extract';
import { MAX_SOURCE_LINKS } from '../../pages/source-links';
import { candidateFromSourceLink } from '../linked-history';
import { applyRetentionCaps } from '../candidates';
import { makeCandidate, makeExact, makeJudgment, sharedOrigin } from './testkit';
import { evaluateClaimPolicy } from '../policy';
import { JevClient } from '../../jev/client';
import { runInvestigation, type SearchProvider } from '../run';
import type { InvestigationEvent } from '../contracts/events';

const parentUrl = 'https://report.example/article';
const linkedUrl = 'https://archive.example/post?id=old-2024';
const support = 'The original video was posted on February 1, 2024. See this earlier post.';
const prose = 'The photograph was released by Common Agency. Retrieved source material describes the photograph and the historical event in detail. '.repeat(30);
const article = (url: string, date: string | null, body: string) => `<html><head><title>Source photograph</title>${date ? `<script type="application/ld+json">${JSON.stringify({ '@type': 'Article', url, datePublished: date, dateCreated: '1990-01-01' })}</script>` : ''}</head><body><article>${body}<p>${prose}</p></article></body></html>`;
const linkBody = `<p>${support} <a href="${linkedUrl}">Earlier post</a></p>`;

async function run(input: { body?: string; contextualCount?: number; fullClassificationPool?: boolean; failLink?: boolean; exactLinked?: boolean; deadline?: boolean } = {}) {
  const fetches: string[] = [];
  const searches: string[] = [];
  let now = Date.parse('2026-10-02T00:00:00Z');
  const contextual = Array.from({ length: input.contextualCount ?? 0 }, (_, i) => ({ position: i + 1, title: 'Context source', link: `https://context${i}.example/article` }));
  const exact = [{ position: 1, title: 'Current photograph', link: parentUrl }];
  if (input.fullClassificationPool) {
    for (let i = 0; i < 7; i++) exact.push({ position: i + 2, title: 'Photograph', link: `https://exact${i}.example/photo` });
  }
  if (input.exactLinked) {
    for (let i = 0; i < 3; i++) exact.push({ position: i + 2, title: 'Photograph', link: `https://exact${i}.example/photo` });
    exact.push({ position: 5, title: 'Historical photograph', link: linkedUrl });
  }
  const serpapi: SearchProvider = {
    uploadImage: async () => 'offline-image',
    search: async params => {
      searches.push(`${params.engine}:${params.type ?? ''}`);
      if (params.type === 'exact_matches') return { exact_matches: exact };
      if (input.fullClassificationPool && params.engine === 'google_news') return { news_results: Array.from({ length: 5 }, (_, i) => ({ position: i + 1, title: 'News', link: `https://news${i}.example/article` })) };
      if (input.fullClassificationPool && params.type === 'all') return { visual_matches: Array.from({ length: 8 }, (_, i) => ({ position: i + 1, title: 'Visual lead', link: `https://visual${i}.example/photo` })) };
      if (params.engine === 'google') return { organic_results: contextual };
      return {};
    },
  };
  const jev = new JevClient({ apiKey: 'offline-only', fetchImpl: async () => Response.json({ model: 'jev-1.13.0', answers: {
    relevance: { type: 'noul', noul: .95 },
    page_role: { type: 'choice', choice: 'FACT_CHECK', probabilities: { REPORTING: 0, FACT_CHECK: 1, SOCIAL_REPOST: 0, AGGREGATOR: 0, COMMENTARY: 0, OTHER: 0 } },
    claim_relation: { type: 'choice', choice: 'CONTRADICTS', probabilities: { SUPPORTS: 0, CONTRADICTS: .9, NEUTRAL: .05, INSUFFICIENT: .05 } },
  } }) });
  const events: InvestigationEvent[] = [];
  await runInvestigation({ media: new Uint8Array([1]), claim: 'The photo shows a recent event', timezone: 'UTC', locale: 'en' }, event => events.push(event), {
    serpapi, jev, now: () => now,
    fetchPage: async url => {
      fetches.push(url);
      if (url === linkedUrl && input.failLink) throw new Error('Controlled source unavailable');
      if (input.deadline && url === parentUrl) now += 55_001;
      return { url, html: article(url, url === linkedUrl ? '2024-02-01' : url === parentUrl ? '2026-09-27' : null,
        url === parentUrl ? input.body ?? linkBody : `<p>Filmed at an event on <time datetime="2024-01-31">January 31</time>. The source does not separately establish filming time.</p>`) };
    },
  });
  const terminal = events.find(event => event.type === 'investigation.completed');
  if (terminal?.type !== 'investigation.completed') throw new Error('Missing result');
  const classifiedIds = new Set(events.flatMap(event => event.type === 'evidence.classified' ? [event.id] : []));
  return { result: terminal.result, fetches, searches, classifiedIds };
}

const allItems = (result: Awaited<ReturnType<typeof run>>['result']) => [...result.timeline, ...result.undatedEvidence, ...result.contextualEvidence];

describe('inspected historical links within the existing investigation bounds', () => {
  it('acquires a separate dated contextual source without inheriting media identity or parent date', async () => {
    const { result, fetches, searches } = await run();
    expect(fetches).toEqual([parentUrl, linkedUrl]);
    expect(searches.length).toBeLessThanOrEqual(6);
    const linked = allItems(result).find(item => item.sourceUrl === linkedUrl);
    expect(linked).toMatchObject({ observedAt: '2024-02-01', publishedAtSource: 'page_json_ld', mediaRelationship: null, identityBasis: 'contextual' });
    expect(result.earliestObservedOccurrence).toBe('2026-09-27');
    expect(result.sourceLinkedReport?.provenanceCompleteness.originalPublication.status).toBe('unknown');
    const reference = result.sourceLinkedReport?.pageReads.find(read => read.requestedUrl === parentUrl)?.sourceLinks?.[0];
    expect(reference).toMatchObject({ url: linkedUrl, supportingText: `${support} Earlier post`, location: { element: 'anchor', index: 0 }, followup: 'selected', evidenceId: linked?.evidenceId });
  });

  it('recovers a date for a linked resource with its own independently retrieved exact identity', async () => {
    const { result, fetches } = await run({ exactLinked: true });
    expect(fetches).toHaveLength(5);
    expect(fetches.at(-1)).toBe(linkedUrl);
    expect(result.earliestObservedOccurrence).toBe('2024-02-01');
    expect(result.timeline.find(item => item.sourceUrl === linkedUrl)).toMatchObject({ mediaRelationship: 'EXACT_MATCH', identityBasis: 'lens_exact_collection', observedAt: '2024-02-01' });
    // All pages credit the same provider: domains cannot create independence.
    expect(result.timeline.every(item => item.reportingOriginStatus === 'shared_origin')).toBe(true);
    if (result.mode === 'claim_check') expect(result.status).not.toBe('CONTEXT_CONFLICT');
  });

  it('keeps failed follow-ups visible and parent evidence intact', async () => {
    const { result } = await run({ failLink: true });
    expect(result.sourceLinkedReport?.pageReads.find(read => read.requestedUrl === linkedUrl)).toMatchObject({ fetch: 'failed', failureCode: 'unknown', sourceBinding: 'not_established' });
    expect(allItems(result).find(item => item.sourceUrl === linkedUrl)?.observedAt).toBeNull();
    expect(result.earliestObservedOccurrence).toBe('2026-09-27');
  });

  it('never dispatches follow-up work beyond a deadline', async () => {
    const { result, fetches } = await run({ deadline: true });
    expect(fetches).toEqual([parentUrl]);
    expect(result.sourceLinkedReport?.pageReads[0].sourceLinks?.[0].followup).toBe('deadline');
  });

  it('keeps existing contextual retention and spends the fifth page on an ordinary candidate when a new lead cannot fit', async () => {
    const { result, fetches } = await run({ contextualCount: 5 });
    expect(fetches).toHaveLength(5);
    expect(fetches).not.toContain(linkedUrl);
    expect(result.sourceLinkedReport?.pageReads.find(read => read.requestedUrl === parentUrl)?.sourceLinks?.[0].followup).toBe('retention_limit');
  });

  it('defers a fresh lead at 24 admitted candidates even when a contextual retention slot is available', async () => {
    const { result, fetches, classifiedIds } = await run({ fullClassificationPool: true, contextualCount: 3 });
    expect(classifiedIds.size).toBe(24);
    expect(result.sourceLinkedReport?.sourceRoles).toHaveLength(24);
    expect(fetches).toHaveLength(5);
    expect(fetches).not.toContain(linkedUrl);
    expect(allItems(result).some(item => item.sourceUrl === linkedUrl)).toBe(false);
    expect(result.sourceLinkedReport?.pageReads.find(read => read.requestedUrl === parentUrl)?.sourceLinks?.[0].followup).toBe('classification_limit');
  });

  it('retains an unrelated reference for inspection without crawling it', async () => {
    const { result, fetches } = await run({ body: `<p>Read our subscription terms. <a href="${linkedUrl}">Terms</a></p>` });
    expect(fetches).toEqual([parentUrl]);
    expect(result.sourceLinkedReport?.pageReads[0].sourceLinks?.[0].followup).toBe('not_historical');
  });

  it('follows at most one link and retains all deferrals without recursive crawling', async () => {
    const body = linkBody + `<p>An earlier video appeared in 2020. <a href="https://another.example/video">Second lead</a></p>`;
    const { result, fetches } = await run({ body });
    expect(fetches).toEqual([parentUrl, linkedUrl]);
    expect(result.sourceLinkedReport?.pageReads[0].sourceLinks?.map(link => link.followup)).toEqual(['selected', 'page_limit']);
  });
});

describe('bounded source references and distinct temporal meanings', () => {
  it('prefers later historical support over an earlier unrelated reference to the same URL', () => {
    const body = `<p>More coverage <a href="${linkedUrl}">here</a></p>` + linkBody;
    const links = extractPage(article(parentUrl, null, body), parentUrl).sourceLinks;
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ url: linkedUrl, historicalLead: true, supportingText: `${support} Earlier post`, location: { element: 'anchor', index: 1 } });
  });
  it('retains article anchor and embed support with safe query identity, but excludes navigation, secrets and invented URLs', () => {
    const ex = extractPage(article(parentUrl, null, `<nav><p><a href="https://nav.example/old">Old video 2020</a></p></nav>${linkBody}<blockquote>Earlier footage posted in 2020 <iframe src="https://embed.example/video?id=1" title="Embedded video"></iframe></blockquote><p>Earlier video 2020 <a href="http://127.0.0.1/a">Local</a><a href="https://safe.example/?token=secret">Secret</a><a href="javascript:alert(1)">Script</a></p>`), parentUrl);
    expect(ex.sourceLinks).toHaveLength(2);
    expect(ex.sourceLinks[0].url).toBe(linkedUrl);
    expect(ex.sourceLinks[1]).toMatchObject({ location: { element: 'embed', index: 2 }, historicalLead: true });
    expect(candidateFromSourceLink(ex.sourceLinks[0], '2026-10-02')?.publishedAt).toBeNull();
  });

  it('enforces the link cap and drops oversized support instead of losing the actual supporting span', () => {
    const many = Array.from({ length: 40 }, (_, i) => `<p>Earlier video 2020 <a href="https://archive.example/${i}">Post ${i}</a></p>`).join('');
    expect(extractPage(article(parentUrl, null, many), parentUrl).sourceLinks).toHaveLength(MAX_SOURCE_LINKS);
    const unrelated = Array.from({ length: MAX_SOURCE_LINKS }, (_, i) => `<p>Subscription terms <a href="https://terms.example/${i}">Terms</a></p>`).join('');
    expect(extractPage(article(parentUrl, null, unrelated + linkBody), parentUrl).sourceLinks.some(link => link.url === linkedUrl)).toBe(true);
    expect(extractPage(article(parentUrl, null, `<p>${'x'.repeat(1300)}<a href="${linkedUrl}">Post</a></p>`), parentUrl).sourceLinks).toEqual([]);
  });

  it('does not treat an event time or creation/filming time as publication, but accepts explicitly marked publication time', () => {
    const ex = extractPage(article(parentUrl, null, `<div itemscope itemtype="https://schema.org/Article" itemid="${parentUrl}"><p>Filmed on <time datetime="2024-01-31">Jan 31</time>; posted <time datetime="2024-02-01" itemprop="datePublished">Feb 1</time>.</p></div>`)
      .replace('</head>', `<meta name="date" content="1990-01-01"><meta name="dc.date" content="1991-01-01"><script type="application/ld+json">${JSON.stringify({ '@type': 'Article', url: parentUrl, dateCreated: '1990-01-01' })}</script></head>`), parentUrl);
    expect(ex.jsonLdDates).toEqual([]);
    expect(ex.metaDates).toEqual([]);
    expect(ex.timeDates).toEqual(['2024-02-01']);
  });

  it('shares five contextual retention slots and does not add corroboration for a common origin', () => {
    const ex = extractPage(article(parentUrl, null, linkBody), parentUrl);
    const linked = candidateFromSourceLink(ex.sourceLinks[0], '2026-10-02');
    if (!linked) throw new Error('Missing candidate');
    const contextual = Array.from({ length: 5 }, (_, i) => makeCandidate({ id: `ctx${i}`, retrievalKind: 'google_search', serpPosition: i + 1 }));
    const kept = applyRetentionCaps([...contextual, linked]);
    expect(kept).toHaveLength(5);
    expect(kept.filter(c => c.retrievalKind === 'source_link')).toHaveLength(1);
    const contradiction = makeJudgment({ claimRelation: { supports: 0, contradicts: .9, neutral: .05, insufficient: .05 } });
    const core = sharedOrigin(makeExact({ judgment: contradiction }), 'common');
    sharedOrigin(linked, 'common'); linked.judgment = contradiction;
    expect(evaluateClaimPolicy([core, linked]).status).toBe('POSSIBLE_CONTEXT_CONFLICT');
  });

  it('does not bind a different query-addressed post or a quoted post time to the fetched article', () => {
    const html = article(linkedUrl, null, '<blockquote>Another post <time itemprop="datePublished" datetime="1990-01-01">1990</time></blockquote>')
      .replace('</head>', `<script type="application/ld+json">${JSON.stringify({ '@type': 'Article', url: 'https://archive.example/post?id=another-post', datePublished: '1991-01-01' })}</script></head>`);
    const extracted = extractPage(html, linkedUrl);
    expect(extracted.jsonLdDates).toEqual([]);
    expect(extracted.timeDates).toEqual([]);
    expect(extracted.rejectedJsonLdDates).toContainEqual({ value: '1991-01-01', reason: 'contradictory_entity_binding' });
  });

  it('requires publication microdata to have a resource-bound owner and retains rejected ownership', () => {
    const body = `<div itemscope itemtype="https://schema.org/VideoObject" itemid="https://archive.example/other"><time itemprop="datePublished" datetime="2020-01-01">2020</time></div>
      <p><time itemprop="datePublished" datetime="2021-01-01">Unowned</time></p>
      <div itemscope itemtype="https://schema.org/Article" itemid="${parentUrl}"><time itemprop="datePublished" datetime="2026-09-27">Publication</time></div>`;
    const extracted = extractPage(article(parentUrl, null, body), parentUrl);
    expect(extracted.timeDates).toEqual(['2026-09-27']);
    expect(extracted.rejectedTimeDates).toEqual([
      { value: '2020-01-01', reason: 'contradictory_time_owner' },
      { value: '2021-01-01', reason: 'unbound_time_owner' },
    ]);
  });
});
