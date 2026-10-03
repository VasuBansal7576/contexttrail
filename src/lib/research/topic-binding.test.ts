/** Controlled candidate pools, not reconstructed unretained live search results. */
import { describe, expect, it } from 'vitest';
import { normalizeSearchResponse } from '../serpapi/normalize';
import { JevClient, JEV_MODEL } from '../jev/client';
import { investigateTopic, type AutomaticResearchDeps } from './automatic';
import { selectTopicSources, type TopicCandidate } from './topic-selection';

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
  it('reads available topical leads before dictionary/sports results while retaining zero-overlap fallbacks when space permits', () => {
    const selected = selectTopicSources(topic, entries([
      Array.from({ length: 3 }, (_, index) => topical(index)),
      Array.from({ length: 3 }, (_, index) => topical(index + 3)), unrelated,
    ]));
    expect(selected).toHaveLength(8);
    expect(selected.slice(0, 5).every(entry => entry.candidate.title?.includes('Agency Meridian'))).toBe(true);
    expect(selected.slice(6).map(entry => entry.candidate.title)).toEqual(unrelated.map(lead => lead.title));
    expect(selected.slice(0, 5).map(entry => entry.search)).toEqual([0, 1, 0, 1, 0]);
  });
  it('ranks lower provider positions by question overlap within each balanced surface without requiring a document cue', () => {
    const groups = Array.from({ length: 3 }, () => [
      { title: 'Agency Meridian holiday staffing policy', snippet: 'A staffing announcement.' },
      { title: 'General institutional lead' }, topical(2), topical(3), topical(4),
    ]);
    const selected = selectTopicSources(topic, entries(groups));
    expect(selected).toHaveLength(8);
    expect(selected.every(entry => entry.candidate.title?.includes('launch operations'))).toBe(true);
    expect(selected.map(entry => entry.search)).toEqual([0, 1, 2, 0, 1, 2, 0, 1]);
  });
  it('puts substantial conduct/tool coverage ahead of multiword institution holiday-policy boilerplate', () => {
    const question = 'What changed in Bank of England interest-rate policy?';
    const financial = { title: 'Bank of England interest-rate policy decisions', snippet: 'Controlled interest-rate coverage.' };
    const holiday = { title: 'Bank of England press release on staff holidays', snippet: 'Our holiday policy and staffing arrangements.' };
    const selected = selectTopicSources(question, entries([[holiday, financial, financial], [holiday, financial, financial], [holiday, financial, financial]]));
    expect(selected.slice(0, 5).every(entry => entry.candidate.title === financial.title)).toBe(true);
    expect(selected.map(entry => entry.search).slice(0, 6)).toEqual([0, 1, 2, 0, 1, 2]);
  });
  it('keeps at most two document-priority entries from distinct surfaces ahead of the balanced tiers', () => {
    const statement = { title: 'Agency Meridian intends to privatise launch operations: clarification statement' };
    const selected = selectTopicSources(topic, entries([[topical(0), statement, statement], [topical(1), statement], [topical(2), statement]]));
    expect(selected.slice(0, 2).map(entry => entry.search)).toEqual([0, 1]);
    expect(selected.slice(2, 5).map(entry => entry.candidate.title)).toEqual([topical(0).title, topical(1).title, topical(2).title]);
    // The third surface's statement follows the balanced first round.
    expect(selected[5].candidate.title).toBe(statement.title);
    expect(selected[5].search).toBe(2);
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
    expect(selected).toHaveLength(8);
    expect(selected.every(entry => !entry.candidate.sourceUrl.includes('access_token'))).toBe(true);
    expect(selected.slice(0, 5).map(entry => entry.search)).toEqual([0, 1, 2, 0, 1]);
  });
  it('keeps three attempts, eight sources/five reads/eight requests/forty questions after a failed first search, and preserves failed/rejected lead ownership', async () => {
    let searches = 0, requests = 0, questions = 0;
    const queries: string[] = [], reads: string[] = [];
    const dependencies: AutomaticResearchDeps = {
      now: () => Date.parse('2026-10-03T00:00:00Z'),
      serpapi: { uploadImage: async () => { throw new Error('No media uploads in this controlled topic test'); }, search: async params => {
        queries.push(params.q ?? '');
        const search = searches++;
        if (search === 0) throw new Error('Controlled first search failure');
        return { [params.engine === 'google_news' ? 'news_results' : 'organic_results']: [
          ...unrelated, ...Array.from({ length: 8 }, (_, index) => ({ ...topical(index), link: `https://surface-${search}.example.org/${index}` })),
        ].map((lead, index) => ({ ...lead, link: lead.link ?? `https://surface-${search}.example.org/unrelated-${index}` })) };
      } },
      fetchPage: async url => {
        reads.push(url);
        if (reads.length === 1) throw new Error('Controlled read failure');
        if (reads.length === 2) return { url: 'https://unrelated.example.org/other', html: '<meta property="article:published_time" content="2001-01-01"><p>Rejected destination content</p>' };
        return { url, html: `<html><head><title>Controlled launch discussion</title></head><body><article><p>${'Agency Meridian intends to privatise its launch operations, according to this controlled synthetic passage. '.repeat(4)}</p></article></body></html>` };
      },
      jev: new JevClient({ apiKey: 'offline-fixture-only', fetchImpl: async (_url, init) => {
        requests++;
        if (typeof init?.body !== 'string') throw new Error('Missing question payload');
        const payload: unknown = JSON.parse(init.body);
        if (!payload || typeof payload !== 'object' || !('questions' in payload) || !payload.questions || typeof payload.questions !== 'object' || Array.isArray(payload.questions)) throw new Error('Malformed question payload');
        questions += Object.keys(payload.questions).length;
        return Response.json({ model: JEV_MODEL, answers: { relevance: { type: 'noul', noul: 0.8 } } });
      } }),
    };
    const result = await investigateTopic(topic, () => {}, dependencies);
    expect({ searches, reads: reads.length, requests, questions, sources: result.caseRecord.evidence.length }).toEqual({ searches: 3, reads: 5, requests: 8, questions: 40, sources: 8 });
    expect(queries).toEqual([topic, topic, `${topic} statement clarification counterevidence correction`]);
    expect(result.caseRecord.coverage.searches.map(search => search.retained)).toEqual([0, 4, 4]);
    expect(reads.slice(0, 5).every(url => !url.includes('unrelated'))).toBe(true);
    expect(result.caseRecord.coverage.sourceReads?.map(read => read.outcome)).toEqual(['fetch_failed', 'binding_rejected', 'page_quote', 'page_quote', 'page_quote', 'not_attempted', 'not_attempted', 'not_attempted']);
    expect(result.caseRecord.evidence[0].content).toMatchObject({ kind: 'text', attribution: 'search_snippet' });
    expect(result.caseRecord.evidence[1]).toMatchObject({ sourceUrl: reads[1], publicationDate: { status: 'unknown' }, content: { kind: 'text', attribution: 'search_snippet' } });
    expect(result.limitations).toContain('Search 1 was unavailable; no replacement results were invented.');
    expect(result.limitations).toContain('Source 1 could not be read; its original search lead remains.');
    expect(result.limitations.some(value => value.startsWith('Source 2 led to an unrelated'))).toBe(true);
    expect(result.limitations.some(value => value.startsWith('Primary-source coverage'))).toBe(true);
    expect(result.claimReport?.mode).toBe('source_assertions');
    expect(result.claimReport?.sources.every(source => source.relation === 'insufficient')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('Rejected destination content');
  });
});
