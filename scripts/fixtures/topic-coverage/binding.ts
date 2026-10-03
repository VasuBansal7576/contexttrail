/** Synthetic admitted-pool controls; no captured upstream candidate pool is reconstructed. */
import { investigateTopic, type AutomaticResearchDeps } from '../../../src/lib/research/automatic';
import { JevClient, JEV_MODEL } from '../../../src/lib/jev/client';

export async function measureTopicBinding(firstSearchUnavailable: boolean) {
  const topic = 'Does Agency Meridian intend to privatise its launch operations?';
  let searches = 0, uploads = 0, requests = 0, questions = 0;
  const queries: string[] = [], reads: string[] = [];
  const admittedTitles = new Map<string, string>();
  const zeroOverlapUrls = new Set<string>();
  const dependencies: AutomaticResearchDeps = {
    now: () => Date.parse('2026-10-03T00:00:00Z'),
    serpapi: {
      uploadImage: async () => { uploads++; throw new Error('No uploads in this controlled topic fixture'); },
      search: async params => {
        queries.push(params.q ?? '');
        const search = searches++;
        if (search === 0 && firstSearchUnavailable) throw new Error('Controlled first search failure');
        return { [params.engine === 'google_news' ? 'news_results' : 'organic_results']: [
          { title: 'POLICY Definition & Meaning', snippet: 'The meaning of policy is prudence or wisdom in the management of affairs.' },
          { title: 'Participation Policy for Student-Athletes', snippet: 'The policy applies to practice and competition in sports.' },
          ...Array.from({ length: 8 }, (_, index) => ({ title: `Agency Meridian launch operations discussion ${index}`, snippet: 'Agency Meridian intends to privatise launch operations; a controlled search lead.' })),
        ].map((lead, index) => {
          const link = `https://surface-${search}.example.org/${index}`;
          admittedTitles.set(link, lead.title);
          if (index < 2) zeroOverlapUrls.add(link);
          return { ...lead, link };
        }) };
      },
    },
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
  return {
    fixtureBasis: 'controlled_synthetic_adapters_not_a_provider_replay', firstSearchUnavailable,
    actual: { searches, uploads, requests, questions, sources: result.caseRecord.evidence.length, pageReads: reads.length,
      retainedBySearch: result.caseRecord.coverage.searches.map(search => search.retained), queries,
      // Extraction replaces display titles: measure original fixture leads by
      // actual requested URL, never by the post-read evidence title.
      readCandidateTitles: reads.map(url => admittedTitles.get(url) ?? null),
      zeroOverlapReadCount: reads.filter(url => zeroOverlapUrls.has(url)).length,
      outcomes: result.caseRecord.coverage.sourceReads?.map(read => read.outcome) ?? [],
      unresolved: result.limitations.filter(value => value.startsWith('Primary-source coverage')),
      broadQuestionMode: result.claimReport?.mode },
    reads, result,
  };
}
