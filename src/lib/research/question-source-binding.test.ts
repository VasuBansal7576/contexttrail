import { expect, it, vi } from 'vitest';
import { investigateTopic, type AutomaticResearchDeps } from './automatic';
import { parseCaseRecord } from '../cases/parse';
import { localResearchService } from './service';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inquiryCase } from './workflow';

const requested = 'https://original.example/photo-article';
const snippet = 'The city photograph was originally published in 2024. This is the original article search snippet.';
const topic = 'When was the city photograph published?';
function fixture(finalUrl: string, body = 'Subscription terms and refund policies. '.repeat(30), request = requested) {
  const search = vi.fn(async (params: { engine: string }) => params.engine === 'google_news' ? { news_results: [] } : { organic_results: [{ link: request, title: 'Original photograph article', snippet, date: '2024-02-01' }] });
  const fetchPage = vi.fn(async () => ({ url: finalUrl, html: `<html><head><title>Destination title</title><meta property="article:published_time" content="2026-09-27" /></head><body><article><p>${body}</p></article></body></html>` }));
  const dependencies: AutomaticResearchDeps = { serpapi: { search, uploadImage: vi.fn() }, fetchPage, jev: null, now: () => Date.parse('2026-10-02T00:00:00Z') };
  return { dependencies, search, fetchPage };
}
it('preserves original snippet, URL, title and search date when the destination is a different resource', async () => {
  const { dependencies } = fixture('https://different.example/subscription');
  const result = await investigateTopic(topic, () => {}, dependencies);
  expect(result.caseRecord.evidence[0]).toMatchObject({ sourceUrl: requested, title: 'Original photograph article', content: { kind: 'text', text: snippet, attribution: 'search_snippet' }, publicationDate: { status: 'inferred', observation: { value: '2024-02-01', source: { kind: 'search_metadata', url: requested } } } });
});

it.each([
  ['https://original.example/other-article', 'different_resource'],
  ['https://original.example/photo-article?id=other', 'different_resource'],
  ['https://different.example/subscription', 'different_resource'],
  ['https://original.example/login', 'blocked_destination'],
  ['https://original.example/error', 'blocked_destination'],
  ['http://original.example/photo-article', 'different_resource'],
])('rejects destination %s even if it contains question-overlapping text', async (final, binding) => {
  const { dependencies, search, fetchPage } = fixture(final, 'The city photograph was published on a different page in 2026. '.repeat(20));
  const result = await investigateTopic(topic, () => {}, dependencies);
  expect(result.caseRecord.evidence[0]).toMatchObject({ sourceUrl: requested, title: 'Original photograph article', content: { kind: 'text', text: snippet, attribution: 'search_snippet' }, publicationDate: { status: 'inferred', observation: { value: '2024-02-01' } } });
  expect(result.caseRecord.coverage.sourceReads).toEqual([{ evidenceId: result.caseRecord.evidence[0].id, requestedUrl: requested, finalUrl: final, sourceBinding: binding, outcome: 'binding_rejected' }]);
  expect(JSON.stringify(result)).not.toContain('published on a different page');
  expect(JSON.stringify(result)).not.toContain('2026-09-27');
  expect(search).toHaveBeenCalledTimes(6); expect(fetchPage).toHaveBeenCalledTimes(1);
});

it.each([
  ['no_matching_quote', 'Subscription terms and refund policies. '.repeat(30)],
  ['no_readable_text', ''],
])('preserves original ownership and search date for same-resource %s fallback', async (outcome, body) => {
  const { dependencies } = fixture(requested, body);
  const result = await investigateTopic(topic, () => {}, dependencies);
  expect(result.caseRecord.evidence[0]).toMatchObject({ sourceUrl: requested, title: 'Original photograph article', content: { text: snippet, attribution: 'search_snippet' }, publicationDate: { status: 'inferred', observation: { value: '2024-02-01', source: { url: requested } } } });
  expect(result.caseRecord.coverage.sourceReads?.[0]).toMatchObject({ sourceBinding: 'same_resource', outcome });
});

it.each([requested, 'https://www.original.example/photo-article/?utm_source=redirect#section'])('uses only bound page text/title/dates for accepted %s', async final => {
  const body = 'The city photograph was published on this page. '.repeat(20);
  const { dependencies } = fixture(final, body);
  const result = await investigateTopic(topic, () => {}, dependencies);
  const safeFinal = final.split('#')[0];
  expect(result.caseRecord.evidence[0]).toMatchObject({ sourceUrl: safeFinal, title: 'Destination title', content: { text: body.trim(), attribution: 'page_quote' }, publicationDate: { status: 'observed', observation: { value: '2026-09-27', source: { kind: 'page_meta', url: safeFinal } } } });
  expect(result.caseRecord.coverage.sourceReads?.[0]).toMatchObject({ sourceBinding: final === requested ? 'same_resource' : 'normalized_resource', outcome: 'page_quote' });
});

it('accepts an HTTPS upgrade with a quote while preserving original ownership on normalized fallbacks', async () => {
  const { dependencies } = fixture(requested, 'The city photograph was published on this page. '.repeat(20), 'http://original.example/photo-article');
  const upgraded = await investigateTopic(topic, () => {}, dependencies);
  expect(upgraded.caseRecord.coverage.sourceReads?.[0]).toMatchObject({ requestedUrl: 'http://original.example/photo-article', finalUrl: requested, sourceBinding: 'normalized_resource', outcome: 'page_quote' });
  expect(upgraded.caseRecord.evidence[0]).toMatchObject({ sourceUrl: requested, content: { attribution: 'page_quote' } });
  const normalized = fixture('https://www.original.example/photo-article/?utm_source=redirect', '');
  const fallback = await investigateTopic(topic, () => {}, normalized.dependencies);
  expect(fallback.caseRecord.evidence[0]).toMatchObject({ sourceUrl: requested, title: 'Original photograph article', publicationDate: { status: 'inferred', observation: { source: { url: requested }, value: '2024-02-01' } } });
  expect(fallback.caseRecord.coverage.sourceReads?.[0]).toMatchObject({ sourceBinding: 'normalized_resource', outcome: 'no_readable_text' });
});

it('preserves failed reads and sanitizes unsafe destinations without archiving their credentials', async () => {
  const { dependencies } = fixture('https://different.example/?access_token=private');
  const blocked = await investigateTopic(topic, () => {}, dependencies);
  expect(blocked.caseRecord.coverage.sourceReads?.[0]).toMatchObject({ requestedUrl: requested, finalUrl: null, sourceBinding: 'not_established', outcome: 'binding_rejected' });
  expect(JSON.stringify(blocked)).not.toContain('access_token');
  dependencies.fetchPage = async () => { throw new Error('Offline read failure'); };
  const failed = await investigateTopic(topic, () => {}, dependencies);
  expect(failed.caseRecord.coverage.sourceReads?.[0]).toMatchObject({ requestedUrl: requested, finalUrl: null, sourceBinding: 'not_established', outcome: 'fetch_failed' });
  expect(failed.caseRecord.evidence[0].publicationDate).toMatchObject({ status: 'inferred', observation: { value: '2024-02-01' } });
});

it('persists source-read audit on save/reload, keeps old cases valid and rejects malformed audit rows', async () => {
  const { dependencies } = fixture('https://different.example/subscription');
  const result = await investigateTopic(topic, () => {}, dependencies);
  const directory = await mkdtemp(join(tmpdir(), 'question-binding-'));
  try {
    await localResearchService(directory).apply({ kind: 'import_case', operationId: 'question-binding-save', question: result.question, createdAt: result.caseRecord.createdAt, caseRecord: result.caseRecord, claimReport: result.claimReport });
    const reopened = await localResearchService(directory).get(result.caseRecord.id);
    expect(inquiryCase(reopened.document.workspace).coverage.sourceReads).toEqual(result.caseRecord.coverage.sourceReads);
    expect(inquiryCase(reopened.document.workspace).evidence).toEqual(result.caseRecord.evidence);
    const legacy = structuredClone(result.caseRecord); delete legacy.coverage.sourceReads; delete legacy.coverage.topicCandidateAudit;
    expect(parseCaseRecord(legacy)).toEqual(legacy);
    for (const row of [
      { ...result.caseRecord.coverage.sourceReads?.[0], finalUrl: 'https://different.example/?access_token=private' },
      { ...result.caseRecord.coverage.sourceReads?.[0], sourceBinding: 'invented_binding' },
      { ...result.caseRecord.coverage.sourceReads?.[0], outcome: 'page_quote' },
      { ...result.caseRecord.coverage.sourceReads?.[0], outcome: 'not_attempted' },
    ]) expect(() => parseCaseRecord({ ...result.caseRecord, coverage: { ...result.caseRecord.coverage, sourceReads: [row] } })).toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
