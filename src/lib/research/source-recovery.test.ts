import { expect, it, vi } from 'vitest';
import { investigateTopic, type AutomaticResearchDeps } from './automatic';
import { parseAutomaticResearchResult } from './automatic-client';
import { parseCaseRecord } from '../cases/parse';
function dependencies(): AutomaticResearchDeps {
  return { serpapi: { search: vi.fn(async p => ({ [p.engine === 'google_news' ? 'news_results' : 'organic_results']: Array.from({ length: 12 }, (_, i) => ({ title: 'UPI payment adoption study', link: `https://search.example.org/upi-${i}`, snippet: 'UPI payment adoption research in India.' })) })), uploadImage: vi.fn(async () => 'unused') }, jev: null,
    fetchPage: vi.fn(async url => url.includes('reference.example.org') ? { url: url.replace('reference.example.org', 'original.example.org'), html: `<html><head><meta property="article:published_time" content="2020-06-01"/></head><body><article><p>${'UPI payment adoption grew through interoperable infrastructure in India. '.repeat(10)}</p><p>UPI payment adoption is discussed in <a href="https://deeper.example.org/paper">this deeper research paper</a>.</p></article></body></html>` } : { url, html: `<html><head><meta property="article:published_time" content="2026-08-03"/></head><body><article><p>${'UPI payment adoption was discussed in India. '.repeat(12)}</p><p>Our UPI payment adoption article cites the <a href="https://reference.example.org/original">underlying UPI research study</a> with its original data.</p><nav><a href="https://navigation.example.org/upi">UPI research</a></nav></article></body></html>` }) };
}
it('follows an explicit inspected reference within unchanged limits and keeps destination text/dates under their own URL', async () => {
  const deps = dependencies(), result = await investigateTopic('Why did UPI payment adoption grow in India?', () => {}, deps);
  expect(deps.serpapi?.search).toHaveBeenCalledTimes(6); expect(deps.fetchPage).toHaveBeenCalledTimes(10);
  expect(result.caseRecord.evidence).toHaveLength(12);
  const recovered = result.caseRecord.evidence.find(e => e.sourceUrl === 'https://original.example.org/original');
  expect(recovered?.publicationDate).toMatchObject({ status: 'observed', observation: { value: '2020-06-01' } });
  expect(recovered?.content).toMatchObject({ kind: 'text', attribution: 'page_quote' });
  const read = result.caseRecord.coverage.sourceReads?.find(r => r.evidenceId === recovered?.id);
  expect(read).toMatchObject({ requestedUrl: 'https://reference.example.org/original', finalUrl: 'https://original.example.org/original', sourceBinding: 'reference_destination', reference: { text: 'underlying UPI research study' } });
  expect(result.caseRecord.coverage.topicCandidateAudit?.retainedCount).toBe(11);
  expect(result.caseRecord.coverage.searches.reduce((sum, s) => sum + s.retained, 0)).toBe(11);
  expect(vi.mocked(deps.fetchPage).mock.calls.some(([url]) => url.includes('deeper') || url.includes('navigation'))).toBe(false);
  expect(parseCaseRecord(result.caseRecord)).toEqual(result.caseRecord);
  expect(parseAutomaticResearchResult(result).claimReport).toEqual(result.claimReport);
  expect(recovered?.content.kind === 'text' ? recovered.content.text : '').not.toContain('Our UPI payment adoption article cites');
});
it('does not follow unrelated or unsafe references and never accepts reference redirects as search-result binding', async () => {
  const deps = dependencies();
  deps.fetchPage = vi.fn(async url => ({ url, html: `<article><p>${'UPI payment adoption grew in India. '.repeat(12)}</p><p>Read this <a href="https://irrelevant.example.org/football">football research article</a>.</p><p>UPI payment adoption research <a href="https://private.example.org/paper?token=secret">UPI research paper</a>.</p></article>` }));
  const result = await investigateTopic('Why did UPI payment adoption grow in India?', () => {}, deps);
  expect(result.caseRecord.coverage.sourceReads?.some(r => r.reference)).toBe(false);
  expect(vi.mocked(deps.fetchPage).mock.calls).toHaveLength(10);
  const read = result.caseRecord.coverage.sourceReads?.[0];
  if (!read) throw Error();
  expect(() => parseCaseRecord({ ...result.caseRecord, coverage: { ...result.caseRecord.coverage, sourceReads: [{ ...read, sourceBinding: 'reference_destination' }, ...result.caseRecord.coverage.sourceReads!.slice(1)] } })).toThrow();
});
it('follows the explicit article URL after author and signup links in the same citation paragraph', async () => {
  const deps = dependencies();
  deps.fetchPage = vi.fn(async url => ({ url, html: `<article><p>${'UPI payment adoption is discussed in India. '.repeat(12)}</p><p>This UPI research article by <a href="https://people.example.org/in/author">A Researcher</a> discusses <a href="https://social.example.org/signup/cold-join">#UPI</a>. Read the study: <a href="https://reference.example.org/paper">https://reference.example.org/paper</a>. <a href="https://social.example.org/redir?url=paper">https://reference.example.org/paper</a></p></article>` }));
  const result = await investigateTopic('Why did UPI payment adoption grow in India?', () => {}, deps);
  const references = result.caseRecord.coverage.sourceReads?.filter(r => r.reference);
  expect(references).toHaveLength(1);
  expect(references?.[0].requestedUrl).toBe('https://reference.example.org/paper');
  expect(vi.mocked(deps.fetchPage).mock.calls.some(([url]) => /people|signup|redir/.test(url))).toBe(false);
  expect(deps.fetchPage).toHaveBeenCalledTimes(10);
});
