import { describe, expect, it, vi } from 'vitest';
import { JevClient, JEV_MODEL } from '../jev/client';
import { investigateTopic, runAutomaticResearch, type AutomaticResearchDeps } from './automatic';
import type { PreparedVideo } from '../video/ingest';
import type { SerpapiParams } from '../serpapi/client';
import { parseCaseRecord } from '../cases/parse';

function deps(search: (params: SerpapiParams) => Promise<unknown>): AutomaticResearchDeps {
  return { serpapi: { search, uploadImage: vi.fn(async () => 'offline-upload') }, jev: null,
    fetchPage: vi.fn(async url => ({ url, html: `<html><head><title>Primary source</title><meta property="article:published_time" content="2020-02-03" /></head><body><article><p>${'Measured coral recovery was recorded in the reef study. '.repeat(15)}</p></article></body></html>` })),
    now: () => Date.parse('2026-10-02T00:00:00Z') };
}
const response = (engine: string, count = 10) => ({ search_metadata: { id: engine, status: 'Success' }, [engine === 'google_news' ? 'news_results' : 'organic_results']: Array.from({ length: count }, (_, index) => ({ link: `https://${engine === 'google_news' ? 'news' : 'science'}.example.org/source-${index}`, title: `Coral study ${index}`, snippet: 'A retrieved coral study summary.', date: '2020-02-03' })) });

describe('automatic topic investigation (offline providers only)', () => {
  it('retrieves bounded balanced sources, reads real HTML and retains verbatim grounded evidence', async () => {
    const search = vi.fn(async (params: SerpapiParams) => response(params.engine));
    const dependencies = deps(search);
    const result = await investigateTopic('What evidence shows coral recovery?', () => {}, dependencies);
    expect(search).toHaveBeenCalledTimes(3);
    expect(dependencies.fetchPage).toHaveBeenCalledTimes(5);
    expect(result.caseRecord.coverage.sourceReads).toHaveLength(8);
    expect(result.caseRecord.coverage.sourceReads?.filter(read => read.outcome === 'not_attempted')).toHaveLength(3);
    expect(result.caseRecord.evidence).toHaveLength(8);
    expect(result.caseRecord.evidence.some(item => item.sourceUrl.includes('news.'))).toBe(true);
    expect(result.caseRecord.evidence[0].content).toMatchObject({ kind: 'text', attribution: 'page_quote' });
    expect(result.caseRecord.evidence[7].content).toMatchObject({ kind: 'text', attribution: 'search_snippet' });
    expect(result.caseRecord.evidence[0].publicationDate).toMatchObject({ status: 'observed', observation: { value: '2020-02-03' } });
    expect(result.caseRecord.claims).toEqual([]);
    expect(result.caseRecord.relations).toEqual([]);
    expect(result.caseRecord.coverage.searches.map(item => item.retained).reduce((a, b) => a + b)).toBe(8);
    expect(parseCaseRecord(result.caseRecord)).toEqual(result.caseRecord);
  });
  it('keeps snippets as leads when the retrieved page has no question-overlapping paragraph', async () => {
    const dependencies = deps(async params => ({ search_metadata: { status: 'Success' }, [params.engine === 'google_news' ? 'news_results' : 'organic_results']: [
      { link: 'https://source.example.org/reviews', title: 'Fashion Nova blocking negative reviews', snippet: 'A search lead about Fashion Nova reviews.' },
    ] }));
    dependencies.fetchPage = async url => ({ url, html: `<html><head><title>Newsletter subscription</title></head><body><article><p>${'Unrelated newsletter subscription and general editorial material. '.repeat(15)}</p></article></body></html>` });
    const result = await investigateTopic('What does evidence establish about Fashion Nova suppressing customer reviews versus fabricating them?', () => {}, dependencies);
    expect(result.caseRecord.evidence[0].content).toEqual({ kind: 'text', text: 'A search lead about Fashion Nova reviews.', attribution: 'search_snippet' });
    expect(result.caseRecord.evidence[0].provenance.method).toBe('retrieval');
    expect(result.limitations.some(value => value.includes('no page paragraph with lexical overlap'))).toBe(true);
    expect(result.claimReport?.sources[0].relation).toBe('insufficient');
    expect(JSON.stringify(result)).not.toContain('Unrelated newsletter subscription');
  });
  it('retains only a reference if neither a matching paragraph nor a snippet is available', async () => {
    const dependencies = deps(async params => ({ search_metadata: { status: 'Success' }, [params.engine === 'google_news' ? 'news_results' : 'organic_results']: [
      { link: 'https://source.example.org/reviews', title: 'Fashion Nova reviews' },
    ] }));
    const result = await investigateTopic('Fashion Nova reviews', () => {}, dependencies);
    expect(result.caseRecord.evidence[0].content).toEqual({ kind: 'reference' });
    expect(result.claimReport?.sources[0].quote).toBeNull();
    expect(result.claimReport?.sources[0].relation).toBe('insufficient');
    expect(result.limitations.some(value => value.includes('only its source reference remains'))).toBe(true);
  });
  it('retains failure limits and empty evidence rather than substituted results', async () => {
    const dependencies = deps(async () => { throw new Error('provider unavailable'); });
    const result = await investigateTopic('Coral recovery evidence', () => {}, dependencies);
    expect(result.caseRecord.evidence).toEqual([]);
    expect(result.limitations.filter(item => item.includes('unavailable'))).toHaveLength(3);
    expect(result.limitations.some(item => item.includes('remains unresolved'))).toBe(true);
    expect(dependencies.fetchPage).not.toHaveBeenCalled();
  });
  it('uses pinned-model relevance without turning it into a claim verdict', async () => {
    const dependencies = deps(async params => response(params.engine, 1));
    const fetchImpl = vi.fn(async () => Response.json({ model: JEV_MODEL, answers: { relevance: { type: 'noul', noul: 0.9 } } }));
    dependencies.jev = new JevClient({ apiKey: 'offline-test-only', fetchImpl });
    const result = await investigateTopic('Coral recovery evidence', () => {}, dependencies);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.assessments.every(item => item.relevance === 0.9 && item.model === JEV_MODEL)).toBe(true);
    expect(result).not.toHaveProperty('status');
    expect(result.caseRecord.relations).toEqual([]);
  });
  it('keeps malformed probabilities unassessed and aborts rather than completing a cancelled run', async () => {
    const dependencies = deps(async params => response(params.engine, 1));
    dependencies.jev = new JevClient({ apiKey: 'offline-test-only', fetchImpl: async () => Response.json({ model: JEV_MODEL, answers: { relevance: { type: 'noul', noul: 2 } } }) });
    const result = await investigateTopic('Coral recovery evidence', () => {}, dependencies);
    expect(result.assessments.every(item => item.relevance === null && item.model === null)).toBe(true);
    const controller = new AbortController(); controller.abort(); dependencies.signal = controller.signal;
    await expect(investigateTopic('Coral recovery evidence', () => {}, dependencies)).rejects.toThrow();
  });
  it('preserves snippet provenance without readable paragraphs and skips malformed oversized sources', async () => {
    const dependencies = deps(async () => ({ search_metadata: { status: 'Success' }, organic_results: [
      { link: `https://science.example.org/${'x'.repeat(5000)}`, title: 'Too long' },
      { link: 'https://science.example.org/metadata', title: '   ', snippet: 'Coral recovery summary.' },
    ] }));
    dependencies.fetchPage = async url => ({ url, html: '<html><head><meta property="article:published_time" content="2021-06-07" /></head><body></body></html>' });
    const result = await investigateTopic('Coral recovery evidence', () => {}, dependencies);
    expect(result.caseRecord.evidence).toHaveLength(1);
    expect(result.caseRecord.evidence[0].title).toBeNull();
    expect(result.caseRecord.evidence[0].publicationDate.status).toBe('unknown');
    expect(result.caseRecord.evidence[0].content).toMatchObject({ kind: 'text', attribution: 'search_snippet' });
    expect(result.caseRecord.coverage.omittedEvidenceCount).toBe(1);
  });
  it('rejects query-addressed resource changes while preserving original snippet ownership', async () => {
    const dependencies = deps(async params => ({ search_metadata: { status: 'Success' }, [params.engine === 'google_news' ? 'news_results' : 'organic_results']: [
      { link: 'https://science.example.org/article?id=17', title: 'Coral evidence', snippet: 'A retrieved summary.' },
    ] }));
    dependencies.fetchPage = vi.fn(async url => {
      expect(url).toBe('https://science.example.org/article?id=17');
      return { url: 'https://science.example.org/archive?paper=42', html: '<html><head><meta property="article:published_time" content="2021-06-07" /></head><body></body></html>' };
    });
    const result = await investigateTopic('Coral recovery evidence', () => {}, dependencies);
    const source = result.caseRecord.evidence[0];
    expect(source.sourceUrl).toBe('https://science.example.org/article?id=17');
    expect(source.publicationDate.status).toBe('unknown');
    expect(source.content).toMatchObject({ kind: 'text', attribution: 'search_snippet' });
    dependencies.fetchPage = async url => ({ url, html: `<html><body><article><p>${'Coral recovery evidence was observed in the original paper. '.repeat(15)}</p></article></body></html>` });
    const quoted = await investigateTopic('Coral recovery evidence', () => {}, dependencies);
    expect(quoted.caseRecord.evidence[0].sourceUrl).toBe('https://science.example.org/article?id=17');
    expect(quoted.caseRecord.evidence[0].content).toMatchObject({ kind: 'text', attribution: 'page_quote' });
  });
  it('omits credential-bearing references and never attributes unsafe redirect text to another URL', async () => {
    const dependencies = deps(async params => ({ search_metadata: { status: 'Success' }, [params.engine === 'google_news' ? 'news_results' : 'organic_results']: [
      { link: 'https://science.example.org/article?token=secret', title: 'Unsafe' },
      { link: 'https://science.example.org/article?id=17', title: 'Public lead', snippet: 'Public search snippet.' },
    ] }));
    dependencies.fetchPage = vi.fn(async () => ({ url: 'https://science.example.org/archive?access_token=private', html: `<html><head><meta property="article:published_time" content="2021-06-07" /></head><body><article><p>${'Sensitive redirect text. '.repeat(30)}</p></article></body></html>` }));
    const result = await investigateTopic('Coral recovery evidence', () => {}, dependencies);
    expect(dependencies.fetchPage).toHaveBeenCalledTimes(1);
    expect(result.caseRecord.evidence).toHaveLength(1);
    expect(result.caseRecord.evidence[0].sourceUrl).toBe('https://science.example.org/article?id=17');
    expect(result.caseRecord.evidence[0].content).toEqual({ kind: 'text', attribution: 'search_snippet', text: 'Public search snippet.' });
    expect(result.caseRecord.evidence[0].publicationDate.status).toBe('unknown');
    expect(JSON.stringify(result)).not.toContain('Sensitive redirect text');
    expect(JSON.stringify(result)).not.toContain('access_token');
  });
  it.each([{}, { organic_results: 'INVALID', news_results: 'INVALID' }, { organic_results: null, news_results: null }, { error: 'Unrecognized provider condition' }])('marks absent or malformed result collections unavailable: %j', async payload => {
    const result = await investigateTopic('Coral recovery evidence', () => {}, deps(async () => ({ search_metadata: { status: 'Success' }, ...payload })));
    expect(result.limitations.filter(item => item.includes('was unavailable'))).toHaveLength(3);
    expect(result.caseRecord.evidence).toEqual([]);
  });
  it.each([{ organic_results: [], news_results: [] }, { error: "Google hasn't returned any results for this query." }])('retains an explicitly empty provider result without inventing a failure: %j', async payload => {
    const result = await investigateTopic('Coral recovery evidence', () => {}, deps(async () => ({ search_metadata: { status: 'Success' }, ...payload })));
    expect(result.limitations.filter(item => item.includes('was unavailable'))).toHaveLength(0);
    expect(result.caseRecord.evidence).toEqual([]);
  });
  it('preserves search snippets as snippets when source reading fails', async () => {
    const dependencies = deps(async params => response(params.engine, 1));
    dependencies.fetchPage = async () => { throw new Error('blocked'); };
    const result = await investigateTopic('Coral recovery evidence', () => {}, dependencies);
    expect(result.caseRecord.evidence.every(item => item.content.kind === 'text' && item.content.attribution === 'search_snippet')).toBe(true);
    expect(result.limitations.some(item => item.includes('could not be read'))).toBe(true);
  });
});

describe('one-video automatic orchestration (offline providers only)', () => {
  it('decodes one input and searches exactly the middle sample through the real image pipeline', async () => {
    const search = vi.fn(async () => ({ search_metadata: { status: 'Success' }, visual_matches: [], exact_matches: [{ title: 'Retrieved sampled-frame source', link: 'https://archive.example.org/frame-source', snippet: 'Archived photograph caption.' }], about_this_image: { sections: [] } }));
    const dependencies = deps(search);
    dependencies.prepareVideo = vi.fn(async (): Promise<PreparedVideo> => ({ mediaId: 'video:sha256:abc', contentHash: 'a'.repeat(64), durationMs: 3000, coverage: 'sampled_frames_only', frames: [0, 1000, 2000].map(timestampMs => ({ mediaId: 'video:sha256:abc', id: `frame-${timestampMs}`, timestampMs, contentHash: String(timestampMs), mimeType: 'image/jpeg', bytes: new Uint8Array([timestampMs / 1000]) })) }));
    const result = await runAutomaticResearch({ kind: 'video', bytes: new Uint8Array([1]), rights: 'user_provided' }, () => {}, dependencies);
    expect(dependencies.prepareVideo).toHaveBeenCalledTimes(1);
    expect(dependencies.serpapi?.uploadImage).toHaveBeenCalledTimes(1);
    expect(dependencies.serpapi?.uploadImage).toHaveBeenCalledWith(new Uint8Array([1]), expect.any(AbortSignal));
    expect(search.mock.calls.length).toBeLessThanOrEqual(4);
    expect(search.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.frames).toHaveLength(1);
    expect(result.caseRecord.evidence.some(item => item.sourceUrl === 'https://archive.example.org/frame-source')).toBe(true);
    expect(result.caseRecord.occurrences.length).toBeGreaterThan(0);
    expect(result.caseRecord.occurrences.every(item => item.identity.status === 'unknown' && item.span.kind === 'time' && item.span.startMs === 1000)).toBe(true);
    expect(result.frames[0].timestampMs).toBe(1000);
    expect(result.caseRecord.assets[0]).toMatchObject({ kind: 'video', durationMs: 3000, location: { kind: 'not_retained' } });
    expect(result.limitations.some(item => item.includes('Other frames and audio were not searched'))).toBe(true);
    expect(parseCaseRecord(result.caseRecord)).toEqual(result.caseRecord);
  });
});
