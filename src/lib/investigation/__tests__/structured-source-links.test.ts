import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { extractPage } from '../../pages/extract';
import { extractSourceLinks } from '../../pages/source-links';
import { candidateFromSourceLink } from '../linked-history';
import { runAutomaticResearch } from '../../research/automatic';
import { parseAutomaticResearchResult } from '../../research/automatic-client';
import { parseSavedVideoReport } from '../../research/saved-video';
import { JevClient, JEV_MODEL } from '../../jev/client';

const pageUrl = 'https://publisher.example.org/article?id=historical';
const originalUrl = 'https://archive.example.org/video?id=original';
const support = 'The original video was posted in 2017. This paragraph supplies controlled inspectable historical context for the adjacent media resource.';
const current = 'The current video describes unrelated activities today. This controlled paragraph has no association with another resource.';
type TextItem = { type: 'text'; text: string };
type MediaItem = { type: 'video'; url: string };
const textItem = (text: string): TextItem => ({ type: 'text', text: `<p>${text}</p>` });
const mediaItem = (url = originalUrl): MediaItem => ({ type: 'video', url });
function story(items: Array<TextItem | MediaItem> = [textItem(support), mediaItem()], url = pageUrl, cardId = 'context-card') {
  return { url, cards: [{ id: cardId, 'story-elements': items }] };
}
const padding = '<p>' + 'Controlled article material keeps the readable content distinct from unrelated navigation, advertisements and recommendations. '.repeat(7) + '</p>';
function html(json: unknown = { content: story() }, body = `<div id="context-card"><p>${support}</p></div>`, script?: string): string {
  return `<html><head><title>Controlled article</title></head><body><div id="story-body">${body}${padding}</div><script type="application/json">${script ?? JSON.stringify(json)}</script></body></html>`;
}

describe('observed article structure and bounded structured source references', () => {
  it('retains the two URLs actually present in the reduced inspected publisher fixture, without claiming the original live HTML was retained', () => {
    const fixture = readFileSync(new URL('./fixtures/quint-structured-reference.html', import.meta.url), 'utf8');
    const url = 'https://www.thequint.com/news/webqoof/old-video-of-mcd-demolition-in-jasola-falsely-shared-as-one-of-satya-niketan-building-collapse-fact-check';
    const extracted = extractPage(fixture, url);
    expect(extracted.text).toContain('10 November 2017');
    expect(extracted.sourceLinks.map(link => link.url)).toEqual(['https://www.youtube.com/watch?v=hAPTXAFae9o', 'https://www.youtube.com/watch?v=Q4U6jJmSz4E']);
    expect(extracted.sourceLinks.map(link => link.historicalLead)).toEqual([true, false]);
    expect(extracted.sourceLinks[1]).toMatchObject({ location: { element: 'structured_embed', scriptIndex: 0, jsonPath: '/qt/data/story/cards/0/story-elements/1/url' } });
    expect(candidateFromSourceLink(extracted.sourceLinks[1], '2026-10-03')).toMatchObject({ mediaRelationship: null, identityEvidence: { basis: 'contextual' }, publishedAt: null });
  });
  it('retains an original DOM link from the chosen readable paragraph without semantic article wrappers', () => {
    const extracted = extractPage(html({}, `<div id="context-card"><p>${support} <a href="${originalUrl}">Original resource</a></p></div>`), pageUrl);
    expect(extracted.sourceLinks).toHaveLength(1);
    expect(extracted.sourceLinks[0]).toMatchObject({ url: originalUrl, historicalLead: true, location: { element: 'anchor', index: 0 } });
  });
  it('requires URL and complete support together in the same selected readable paragraph', () => {
    const original = new JSDOM(`<div><p>${support}<a href="${originalUrl}">Original resource</a></p><p>${current}<a href="https://other.example.org/video">Other</a></p></div>`).window.document;
    const readable = new JSDOM(`<p>${support}<a href="https://other.example.org/video">Original resource</a></p><p>${current}<a href="${originalUrl}">Other</a></p>`).window.document;
    expect(extractSourceLinks(original, pageUrl, readable)).toEqual([]);
  });
  it('indexes readable references once for many wrapper links, preserving relative URLs and joint support binding', () => {
    const passages = Array.from({ length: 200 }, (_, index) => `<p>Controlled readable passage ${index}. <a href="/source?id=${index}">Source ${index}</a></p>`).join('');
    const original = new JSDOM(`<div>${passages}</div>`).window.document;
    const readable = new JSDOM(`<div>${passages}</div>`).window.document;
    const scan = vi.spyOn(readable, 'querySelectorAll');
    const links = extractSourceLinks(original, pageUrl, readable);
    expect(links).toHaveLength(12);
    expect(links[0]).toMatchObject({ url: 'https://publisher.example.org/source?id=0', supportingText: 'Controlled readable passage 0. Source 0' });
    expect(scan.mock.calls.filter(([selector]) => selector === 'a[href], iframe[src]')).toHaveLength(1);
    scan.mockRestore();
  });
  it('excludes readable navigation and unsafe references from the shared support index', () => {
    const original = new JSDOM(`<div><p>${support}<a href="${originalUrl}">Original</a></p></div>`).window.document;
    const readable = new JSDOM(`<nav><p>${support}<a href="${originalUrl}">Original</a></p></nav><p>${support}<a href="http://127.0.0.1/video">Original</a></p>`).window.document;
    expect(extractSourceLinks(original, pageUrl, readable)).toEqual([]);
  });
  it('preserves existing semantic article references and excludes navigation/footer/hidden references from the new fallback', () => {
    expect(extractPage(`<article><p>${support}<a href="${originalUrl}">Original</a></p></article>`, pageUrl).sourceLinks).toHaveLength(1);
    const body = `<nav><p>${support}<a href="${originalUrl}">Original</a></p></nav><footer><p>${support}<a href="${originalUrl}">Original</a></p></footer><div hidden><p>${support}<a href="${originalUrl}">Original</a></p></div>`;
    expect(extractPage(html({}, body), pageUrl).sourceLinks).toEqual([]);
  });
  it('binds generic structured media to the exact page/card/visible adjacent text and exposes an immutable JSON locator', () => {
    const extracted = extractPage(html(), pageUrl);
    expect(extracted.sourceLinks).toHaveLength(1);
    expect(extracted.sourceLinks[0]).toMatchObject({ url: originalUrl, supportingText: support, historicalLead: true,
      location: { element: 'structured_embed', scriptIndex: 0, jsonPath: '/content/cards/0/story-elements/1/url' } });
    expect(extracted.jsonLdDates).toEqual([]);
  });
  it('rejects a nested independently same-page-bound story rather than inheriting one apparent unique owner', () => {
    const value = { ...story(), nested: story(undefined, pageUrl, 'child-card') };
    expect(extractPage(html({ content: value }), pageUrl).sourceLinks).toEqual([]);
  });
  it.each(['foreign', 'unbound'])('requires an explicit same-resource URL for a nested %s child owner', kind => {
    const child = story([textItem(current), mediaItem('https://child.example.org/video')], 'https://foreign.example.org/article', 'child-card');
    const { url: _url, ...unbound } = child;
    const value = { ...story(), nested: kind === 'foreign' ? child : unbound };
    const body = `<div id="context-card"><p>${support}</p></div><div id="child-card"><p>${current}</p></div>`;
    expect(extractPage(html({ content: value }, body), pageUrl).sourceLinks.map(link => link.url)).toEqual([originalUrl]);
  });
  it.each(['blockquote', 'figure'])('counts %s around a single paragraph as one supporting passage', wrapper => {
    const passage = `<${wrapper}><p>${support}</p></${wrapper}>`;
    const items = [{ type: 'text', text: passage } satisfies TextItem, mediaItem()];
    const links = extractPage(html({ content: story(items) }, `<div id="context-card">${passage}</div>`), pageUrl).sourceLinks;
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ url: originalUrl, supportingText: support, historicalLead: true });
  });
  it.each(['sibling', 'other card'])('still rejects separately repeated wrapped passages in %s ownership', duplicate => {
    const passage = `<blockquote><p>${support}</p></blockquote>`;
    const body = duplicate === 'sibling' ? `<div id="context-card">${passage}${passage}</div>`
      : `<div id="context-card">${passage}</div><div id="other-card">${passage}</div>`;
    expect(extractPage(html(undefined, body), pageUrl).sourceLinks).toEqual([]);
  });
  it('rejects the whole structured story when a later card exceeds the item limit, before returning earlier references', () => {
    const value = story();
    value.cards.push({ id: 'oversized-card', 'story-elements': Array.from({ length: 65 }, () => textItem(current)) });
    expect(extractPage(html({ content: value }), pageUrl).sourceLinks).toEqual([]);
  });
  it.each([false, true])('lets outer deduplication and historical replacement inspect late structured references, early duplicates=%s', duplicates => {
    const early = Array.from({ length: 12 }, (_, index) => ({
      text: `Controlled present-day discussion ${index} has no temporal association with the media resource.`,
      url: duplicates ? 'https://archive.example.org/video?id=current' : `https://archive.example.org/video?id=current-${index}`,
    }));
    const items = [...early.flatMap(item => [textItem(item.text), mediaItem(item.url)]), textItem(support), mediaItem()];
    const body = `<div id="context-card">${early.map(item => `<p>${item.text}</p>`).join('')}<p>${support}</p></div>`;
    const links = extractPage(html({ content: story(items) }, body), pageUrl).sourceLinks;
    expect(links).toHaveLength(duplicates ? 2 : 12);
    expect(links.find(link => link.url === originalUrl)).toMatchObject({ historicalLead: true, supportingText: support,
      location: { element: 'structured_embed', jsonPath: '/content/cards/0/story-elements/25/url' } });
    expect(new Set(links.map(link => link.url)).size).toBe(links.length);
  });
  it.each(['nodes', 'depth', 'object keys', 'array items', 'script count', 'script bytes', 'malformed script', 'path length'])('rejects partial ownership scans truncated by %s even after finding one bound story', limit => {
    let value: unknown = { content: story() };
    let document: string;
    if (limit === 'nodes') value = { content: story(), filler: Array.from({ length: 8 }, () => Array.from({ length: 63 }, () => ({}))), hidden: story() };
    if (limit === 'depth') {
      let hidden: unknown = story();
      for (let index = 0; index < 9; index++) hidden = { nested: hidden };
      value = { content: story(), hidden };
    }
    if (limit === 'object keys') value = { content: story(), ...Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`padding-${index}`, {}])), hidden: story() };
    if (limit === 'array items') value = { content: story(), hidden: [...Array.from({ length: 64 }, () => ({})), story()] };
    if (limit === 'path length') value = { content: story(), ['x'.repeat(1025)]: story() };
    document = html(value);
    const extra = limit === 'script count' ? '<script type="application/json">{}</script>'.repeat(7) + `<script type="application/json">${JSON.stringify({ hidden: story() })}</script>`
      : limit === 'script bytes' ? `<script type="application/json">${JSON.stringify({ padding: 'x'.repeat(525000), hidden: story() })}</script>`
      : limit === 'malformed script' ? '<script type="application/json">{bad JSON</script>' : '';
    document = document.replace('</body>', `${extra}</body>`);
    expect(extractPage(document, pageUrl).sourceLinks).toEqual([]);
  });
  it('accepts a complete scan at 512 nodes, rejects its truncated successor and preserves independent DOM references', () => {
    // Seven story/root containers plus 505 filler containers = 512.
    const filler = Array.from({ length: 8 }, () => Array.from({ length: 62 }, () => ({})));
    const value = { content: story(), filler };
    expect(extractPage(html(value), pageUrl).sourceLinks).toHaveLength(1);
    filler[7].push({});
    expect(extractPage(html(value), pageUrl).sourceLinks).toEqual([]);
    const body = `<div id="context-card"><p>${support}</p></div><article><p>${current}<a href="https://other.example.org/reference">Independent DOM source</a></p></article>`;
    expect(extractPage(html(value, body), pageUrl).sourceLinks.map(link => link.url)).toEqual(['https://other.example.org/reference']);
  });
  it.each([
    ['foreign page', { content: story(undefined, 'https://other.example.org/article') }],
    ['query-addressed other page', { content: story(undefined, 'https://publisher.example.org/article?id=other') }],
    ['contradictory canonical story', { content: { ...story(), 'canonical-url': 'https://other.example.org/article' } }],
    ['missing card', { content: story(undefined, pageUrl, 'absent-card') }],
    ['unsafe media', { content: story([textItem(support), mediaItem('http://127.0.0.1/video')]) }],
    ['credential query', { content: story([textItem(support), mediaItem(`${originalUrl}&token=secret`)]) }],
    ['missing visible support', { content: story([textItem('An earlier video in 2015 that never occurs in the visible article.'), mediaItem()]) }],
    ['unrecognized schema', { recommendations: [{ url: pageUrl, links: [originalUrl] }] }],
  ])('rejects %s structured references', (_label, value) => {
    expect(extractPage(html(value), pageUrl).sourceLinks).toEqual([]);
  });
  it('does not borrow earlier/cross-card support across intervening text or accept URL mentions as explicit references', () => {
    const items = [textItem(support), textItem(current), mediaItem()];
    const body = `<div id="context-card"><p>${support}</p><p>${current}</p></div>`;
    const links = extractPage(html({ content: story(items) }, body), pageUrl).sourceLinks;
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ supportingText: current, historicalLead: false });
    const oneItem = { type: 'text', text: `<p>${support}</p><p>${current}</p>` } satisfies TextItem;
    const sameItemLinks = extractPage(html({ content: story([oneItem, mediaItem()]) }, body), pageUrl).sourceLinks;
    expect(sameItemLinks[0]).toMatchObject({ supportingText: current, historicalLead: false });
    const missingLast = { type: 'text', text: `<p>${support}</p><p>A current unrelated video paragraph missing from the chosen article.</p>` } satisfies TextItem;
    expect(extractPage(html({ content: story([missingLast, mediaItem()]) }, body), pageUrl).sourceLinks).toEqual([]);
    const oversizedLast = { type: 'text', text: `<p>${support}</p><p>${'Current unrelated sports interview. '.repeat(50)}</p>` } satisfies TextItem;
    expect(extractPage(html({ content: story([oversizedLast, mediaItem()]) }, body), pageUrl).sourceLinks).toEqual([]);
    expect(extractPage(html({}, `<div id="context-card"><p>${support} ${originalUrl}</p></div>`), pageUrl).sourceLinks).toEqual([]);
    const crossCard = { url: pageUrl, cards: [{ id: 'other-card', 'story-elements': [textItem(support)] }, { id: 'context-card', 'story-elements': [mediaItem()] }] };
    expect(extractPage(html({ content: crossCard }, body), pageUrl).sourceLinks).toEqual([]);
  });
  it('rejects ambiguous card DOM IDs, duplicate structured story/card owners and card support outside the chosen article', () => {
    expect(extractPage(html(undefined, `<div id="context-card"><p>${support}</p></div><div id="context-card"><p>${support}</p></div>`), pageUrl).sourceLinks).toEqual([]);
    const duplicate = story(); duplicate.cards.push(...duplicate.cards);
    expect(extractPage(html({ content: duplicate }), pageUrl).sourceLinks).toEqual([]);
    expect(extractPage(html({ first: story(), second: story() }), pageUrl).sourceLinks).toEqual([]);
    expect(extractPage(html(undefined, `<aside id="context-card"><p>${support}</p></aside>`), pageUrl).sourceLinks).toEqual([]);
    expect(extractPage(html(undefined, `<div id="context-card"><p>${support}</p></div><div id="other-card"><p>${support}</p></div>`), pageUrl).sourceLinks).toEqual([]);
  });
  it('fails closed on malformed/oversized state while preserving valid DOM references', () => {
    const body = `<div><p>${support}<a href="${originalUrl}">Original resource</a></p></div>`;
    for (const script of ['{bad JSON', JSON.stringify({ padding: 'x'.repeat(525000), content: story() })]) {
      expect(extractPage(html({}, body, script), pageUrl).sourceLinks.map(link => link.url)).toEqual([originalUrl]);
    }
  });
  it('bounds JSON script count, traversal depth, cards, items and support without inventing replacement references', () => {
    const value = story();
    const tooManyCards = { ...value, cards: Array.from({ length: 17 }, (_, index) => ({ ...value.cards[0], id: `card-${index}` })) };
    expect(extractPage(html({ content: tooManyCards }), pageUrl).sourceLinks).toEqual([]);
    const tooManyItems = { ...value, cards: [{ id: 'context-card', 'story-elements': Array.from({ length: 65 }, () => textItem(support)) }] };
    expect(extractPage(html({ content: tooManyItems }), pageUrl).sourceLinks).toEqual([]);
    let deep: unknown = { content: value };
    for (let index = 0; index < 10; index++) deep = { nested: deep };
    expect(extractPage(html(deep), pageUrl).sourceLinks).toEqual([]);
    const nineScripts = html().replace('<script type="application/json">', '<script type="application/json">{}</script>'.repeat(8) + '<script type="application/json">');
    expect(extractPage(nineScripts, pageUrl).sourceLinks).toEqual([]);
    const oversized = 'Original video in 2017. '.repeat(60);
    expect(extractPage(html({ content: story([textItem(oversized), mediaItem()]) }, `<div id="context-card"><p>${oversized}</p></div>`), pageUrl).sourceLinks).toEqual([]);
  });
});

describe('structured reference acquisition and saved raw report roundtrip (offline adapters)', () => {
  it.each([false, true])('preserves unchanged fifth-read ownership and cautious identity when an earlier DOM historical reference exists=%s', async domFirst => {
    const alternativeUrl = 'https://alternate.example.org/video?id=other';
    const filler = Array.from({ length: 4 }, (_, index) => ({ title: `Current context ${index}`, link: `https://filler-${index}.example.org/article`, snippet: 'Controlled current reporting lead.' }));
    let searches = 0, uploads = 0;
    const reads: string[] = [];
    const result = await runAutomaticResearch({ kind: 'video', bytes: new Uint8Array([1]), rights: 'user_provided', claim: 'This video depicts a current event.' }, () => {}, {
      now: () => Date.parse('2026-10-03T00:00:00Z'),
      prepareVideo: async () => ({ mediaId: 'video:sha256:abc', contentHash: 'a'.repeat(64), durationMs: 3000, coverage: 'sampled_frames_only', frames: [{ mediaId: 'video:sha256:abc', id: 'frame-0', timestampMs: 0, contentHash: 'b'.repeat(64), mimeType: 'image/jpeg', bytes: new Uint8Array([1]) }] }),
      serpapi: { uploadImage: async () => { uploads++; return 'controlled-image'; }, search: async params => {
        searches++;
        if (params.type === 'all') return { visual_matches: [{ title: 'Historical article', link: pageUrl }, { title: 'Original resource reference', link: originalUrl }] };
        if (params.engine === 'google') return { organic_results: filler };
        return {};
      } },
      jev: new JevClient({ apiKey: 'offline-fixture-only', fetchImpl: async (_url, init) => {
        const body = String(init?.body);
        return Response.json({ model: JEV_MODEL, answers: {
          relevance: { type: 'noul', noul: body.includes('Original resource reference') ? .1 : .95 },
          page_role: { type: 'choice', choice: body.includes('Historical article') ? 'FACT_CHECK' : 'OTHER', probabilities: { REPORTING: 0, FACT_CHECK: body.includes('Historical article') ? 1 : 0, SOCIAL_REPOST: 0, AGGREGATOR: 0, COMMENTARY: 0, OTHER: body.includes('Historical article') ? 0 : 1 } },
        } });
      } }),
      fetchPage: async url => {
        reads.push(url);
        if (url === pageUrl) {
          const dom = domFirst ? `<p>Earlier footage was posted in 2014. <a href="${alternativeUrl}">Other inspected reference</a></p>` : '';
          return { url, html: html(undefined, `<div id="context-card"><p>${support}</p></div>${dom}`) };
        }
        return { url, html: `<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'Article', url, datePublished: '2017-11-10' })}</script></head><body><article><p>${'Controlled source text describes a historical video but supplies no identity measurement. '.repeat(15)}</p></article></body></html>` };
      },
    });
    expect(result.kind).toBe('video');
    expect({ searches, uploads, reads: reads.length }).toEqual({ searches: 5, uploads: 1, reads: 5 });
    expect(reads[4]).toBe(domFirst ? alternativeUrl : originalUrl);
    const report = result.frames[0]?.imageResult;
    if (!report || report.mode !== 'claim_check') throw new Error('Missing completed frame report');
    expect(report.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(report.timeline).toEqual([]);
    expect(report.earliestObservedOccurrence).toBeNull();
    const parentRead = report.sourceLinkedReport?.pageReads.find(read => read.requestedUrl === pageUrl);
    const structured = parentRead?.sourceLinks?.find(link => link.location.element === 'structured_embed');
    expect(structured).toMatchObject({ url: originalUrl, followup: domFirst ? 'page_limit' : 'selected', location: { scriptIndex: 0, jsonPath: '/content/cards/0/story-elements/1/url' } });
    const raw: unknown = JSON.parse(JSON.stringify(result));
    const live = parseAutomaticResearchResult(raw);
    expect(live.retainedResult).toEqual(raw);
    expect(parseSavedVideoReport({ schemaVersion: 'contexttrail-video-report-v1', result: live.retainedResult }).result).toEqual(raw);
  });
});
