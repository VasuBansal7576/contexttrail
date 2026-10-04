/** Controlled candidate pools, not reconstructed unretained live search results. */
import { describe, expect, it } from 'vitest';
import { normalizeSearchResponse } from '../serpapi/normalize';
import { selectTopicSources, type TopicCandidate } from './topic-selection';
import { measureTopicBinding } from '../../../scripts/fixtures/topic-coverage/binding';

type Lead = { title?: string; snippet?: string; link?: string };
function entries(groups: Lead[][]): TopicCandidate[] {
  return groups.flatMap((group, search) => normalizeSearchResponse({ organic_results: group.map((lead, index) => ({
    ...lead, link: lead.link ?? `https://surface-${search}.example.org/${index}`,
  })) }, 'google_search', { retrievedAt: '2026-10-03T00:00:00Z' }).candidates.map(candidate => ({ candidate, dates: {}, search })));
}
const topic = 'Does Agency Meridian intend to privatise its launch operations?';
const topical = (index: number): Lead => ({ title: `Agency Meridian launch operations discussion ${index}`, snippet: 'Agency Meridian intends to privatise launch operations; a controlled search lead.' });
const unrelated: Lead[] = [
  { title: 'POLICY Definition & Meaning', snippet: 'The meaning of policy is prudence or wisdom in the management of affairs.' },
  { title: 'Participation Policy for Transgender Student-Athletes', snippet: 'The policy applies to practice and competition in NCAA sports.' },
];

describe('topic binding before bounded admission and page reads', () => {
  it.each([false, true])('measures the synthetic high-ranked zero-overlap pool with first-search-unavailable=%s through the actual bounded pipeline', async unavailable => {
    const measured = await measureTopicBinding(unavailable);
    expect(measured.actual).toMatchObject({ searches: 6, uploads: 0, requests: 12, questions: 60, sources: 12, pageReads: 10, zeroOverlapReadCount: 0, broadQuestionMode: 'source_assertions' });
    expect(measured.actual.retainedBySearch).toEqual(unavailable ? [0, 3, 3, 2, 2, 2] : [2, 2, 2, 2, 2, 2]);
    expect(measured.actual.queries.slice(0, 3)).toEqual([topic, topic, `${topic} (statement OR clarification OR "press release" OR correction)`]);
    expect(new Set(measured.actual.queries.slice(2)).size).toBe(4);
    expect(measured.actual.readCandidateTitles.every(title => title?.includes('Agency Meridian'))).toBe(true);
    expect(measured.actual.outcomes).toEqual(['fetch_failed', 'binding_rejected', ...Array(8).fill('page_quote'), 'not_attempted', 'not_attempted']);
    expect(measured.actual.unresolved).toHaveLength(1);
    expect(measured.result.caseRecord.evidence[0].content).toMatchObject({ kind: 'text', attribution: 'search_snippet' });
    expect(measured.result.caseRecord.evidence[1]).toMatchObject({ sourceUrl: measured.reads[1], publicationDate: { status: 'unknown' }, content: { kind: 'text', attribution: 'search_snippet' } });
    expect(measured.result.claimReport?.sources.every(source => source.relation === 'insufficient')).toBe(true);
    if (unavailable) expect(measured.result.limitations).toContain('Search 1 was unavailable; no replacement results were invented.');
    expect(measured.result.limitations).toContain('Source 1 could not be read; its original search lead remains.');
    expect(measured.result.limitations.some(value => value.startsWith('Source 2 led to an unrelated'))).toBe(true);
    expect(JSON.stringify(measured.result)).not.toContain('Rejected destination content');
  });
  it('keeps topical leads without padding a useful trail with dictionary or sports results', () => {
    const selected = selectTopicSources(topic, entries([
      Array.from({ length: 3 }, (_, index) => topical(index)),
      Array.from({ length: 3 }, (_, index) => topical(index + 3)), unrelated,
    ]));
    expect(selected).toHaveLength(6);
    expect(selected.slice(0, 5).every(entry => entry.candidate.title?.includes('Agency Meridian'))).toBe(true);
    expect(selected.some(entry => unrelated.some(lead => lead.title === entry.candidate.title))).toBe(false);
    expect(selected.slice(0, 5).map(entry => entry.search)).toEqual([0, 1, 0, 1, 0]);
  });
  it('ranks lower provider positions by question overlap within each balanced surface without requiring a document cue', () => {
    const groups = Array.from({ length: 3 }, () => [
      { title: 'Agency Meridian holiday staffing policy', snippet: 'A staffing announcement.' },
      { title: 'General institutional lead' }, topical(2), topical(3), topical(4),
    ]);
    const selected = selectTopicSources(topic, entries(groups));
    expect(selected).toHaveLength(12);
    expect(selected.slice(0, 9).every(entry => entry.candidate.title?.includes('launch operations'))).toBe(true);
    expect(selected.slice(0, 9).map(entry => entry.search)).toEqual([0, 1, 2, 0, 1, 2, 0, 1, 2]);
  });
  it('puts substantial conduct/tool coverage ahead of multiword institution holiday-policy boilerplate', () => {
    const question = 'What changed in Bank of England interest-rate policy?';
    const financial = { title: 'Bank of England interest-rate policy decisions', snippet: 'Controlled interest-rate coverage.' };
    const holiday = { title: 'Bank of England press release on staff holidays', snippet: 'Our holiday policy and staffing arrangements.' };
    const selected = selectTopicSources(question, entries([[holiday, financial, financial], [holiday, financial, financial], [holiday, financial, financial]]));
    expect(selected.slice(0, 5).every(entry => entry.candidate.title === financial.title)).toBe(true);
    expect(selected.map(entry => entry.search).slice(0, 6)).toEqual([0, 1, 2, 0, 1, 2]);
  });
  it('keeps three document-priority hosts ahead of the remaining balanced leads', () => {
    const statement = { title: 'Agency Meridian intends to privatise launch operations: clarification statement' };
    const selected = selectTopicSources(topic, entries([[topical(0), statement, statement], [topical(1), statement], [topical(2), statement]]));
    expect(selected.slice(0, 3).map(entry => entry.search)).toEqual([0, 1, 2]);
    expect(selected.slice(0, 3).every(entry => entry.candidate.title === statement.title)).toBe(true);
    expect(new Set(selected.slice(0, 3).map(entry => new URL(entry.candidate.sourceUrl).hostname)).size).toBe(3);
    expect(selected.slice(3, 6).map(entry => entry.candidate.title)).toEqual([topical(0).title, topical(1).title, topical(2).title]);
  });
  it('retains and reads metadata-poor and semantic paraphrase fallbacks when higher tiers leave capacity', () => {
    const paraphrase = { title: 'Transfer of orbital manufacturing to commercial companies' };
    const selected = selectTopicSources(topic, entries([[topical(0)], [paraphrase], [{}]]));
    expect(selected).toHaveLength(3);
    expect(selected.map(entry => entry.search)).toEqual([0, 1, 2]);
    expect(selected[1].candidate.title).toBe(paraphrase.title);
    expect(selected[2].candidate.title).toBeNull();
  });
  it.each(['AI?', 'What is it?', '宇宙研究機関の民営化は進んでいますか？'])('keeps all-zero or empty meaningful-term pools balanced for %s', question => {
    const selected = selectTopicSources(question, entries(Array.from({ length: 3 }, () => unrelated)));
    expect(selected.map(entry => entry.search)).toEqual([0, 1, 2, 0, 1, 2]);
  });
  it('supports broad one-term and non-English questions without inventing entity or authority semantics', () => {
    expect(selectTopicSources('What changed in inflation?', entries([[{ title: 'Office opening hours' }, { title: 'Inflation measurements' }]]))[0].candidate.title).toBe('Inflation measurements');
    expect(selectTopicSources('Politique spatiale Meridian', entries([[{ title: 'Horaires de vacances' }, { title: 'Meridian politique spatiale' }]]))[0].candidate.title).toBe('Meridian politique spatiale');
  });
  it('filters unsafe leads before tier allocation, without spending source/read slots', () => {
    const selected = selectTopicSources(topic, entries(Array.from({ length: 3 }, () => [
      { ...topical(0), link: 'https://unsafe.example.org/topic?access_token=controlled' }, topical(1), topical(2), topical(3),
    ])));
    expect(selected).toHaveLength(9);
    expect(selected.every(entry => !entry.candidate.sourceUrl.includes('access_token'))).toBe(true);
    expect(selected.slice(0, 5).map(entry => entry.search)).toEqual([0, 1, 2, 0, 1]);
  });
});
