/** Controlled offline quality measurement. Every adapter is injected; no provider calls. */
import { investigateTopic, type AutomaticResearchDeps } from '../../../src/lib/research/automatic';
import { JevClient, JEV_MODEL } from '../../../src/lib/jev/client';
import { TOPIC_REFERENCES, type TopicReference } from './references';

export type ReferenceCondition = 'available' | 'secondary_only' | 'unsafe' | 'read_failed' | 'wrong_resource' | 'no_quote';
function page(title: string, passage: string, reference?: TopicReference): string {
  const date = reference?.publicationDate ? `<meta property="article:published_time" content="${reference.publicationDate}">` : '';
  const modified = reference?.pageLastUpdated ? `<meta property="article:modified_time" content="${reference.pageLastUpdated}">` : '';
  return `<html><head><title>${title}</title>${date}${modified}</head><body><article>${passage ? `<p>${passage}</p><p>${passage}</p>` : ''}</article></body></html>`;
}
/** Old selection benchmark only; this is not a replay of an omitted live pool. */
function formerSelection(groups: Array<Array<{ link: string }>>): string[] {
  const selected: string[] = [];
  for (let offset = 0; selected.length < 8 && groups.some(group => offset < group.length); offset++) {
    for (const group of groups) if (group[offset] && selected.length < 8) selected.push(group[offset].link);
  }
  return selected;
}
export async function measureTopicReference(reference: TopicReference, condition: ReferenceCondition = 'available') {
  const referenceUrl = condition === 'unsafe' ? `${reference.url}?access_token=synthetic` : reference.url;
  const groups = Array.from({ length: 3 }, (_, search) => Array.from({ length: 10 }, (_, index) => ({
    link: `https://secondary-${search}.example.org/${reference.id}/${index}`,
    title: `Controlled secondary discussion ${index}`,
    snippet: `Synthetic secondary reporting lead about ${reference.question}`,
  })));
  if (condition !== 'secondary_only') groups[0][9] = { link: referenceUrl, title: reference.title, snippet: reference.syntheticLead };
  // An institutional-looking unrelated page must not outrank topical documents.
  const institution = reference.id === 'boe-policy' ? 'Bank of England' : reference.id === 'nasa-clps' ? 'NASA' : 'ISRO';
  groups[1][0] = { link: `https://institution.example.gov/${reference.id}/careers`, title: `${institution} press release on staff holidays`, snippet: 'Controlled unrelated announcement about our holiday policy and staffing arrangements.' };
  let searches = 0, uploads = 0, requests = 0, questions = 0;
  const readUrls: string[] = [];
  const deps: AutomaticResearchDeps = {
    now: () => Date.parse('2026-10-02T00:00:00Z'),
    serpapi: { uploadImage: async () => { uploads++; throw new Error('The topic benchmark cannot upload media.'); }, search: async params => {
      const index = searches++;
      return { search_metadata: { status: 'Success', id: `synthetic-${index}` }, [params.engine === 'google_news' ? 'news_results' : 'organic_results']: groups[index] };
    } },
    fetchPage: async url => {
      readUrls.push(url);
      if (url === referenceUrl) {
        if (condition === 'read_failed') throw new Error('Controlled primary read failure');
        if (condition === 'wrong_resource') return { url: 'https://unrelated.example.org/login', html: page('Unrelated redirect', reference.syntheticPassage, reference) };
        return { url, html: page(reference.title, condition === 'no_quote' ? '' : reference.syntheticPassage, reference) };
      }
      if (url.includes('institution.example.gov')) return { url, html: page('Controlled holiday staffing policy', 'Synthetic unrelated staff holiday arrangements, annual leave and office opening hours. This controlled institutional page does not discuss the requested research or policy tools. '.repeat(3)) };
      return { url, html: page('Controlled secondary page', `Synthetic secondary passage about ${reference.question} This controlled page has no independently established authority and does not settle the question. `.repeat(3)) };
    },
    jev: new JevClient({ apiKey: 'offline-fixture-only', fetchImpl: async (_url, init) => {
      requests++;
      if (typeof init?.body !== 'string') throw new Error('Missing controlled question payload');
      const payload: unknown = JSON.parse(init.body);
      if (!payload || typeof payload !== 'object' || !('questions' in payload) || !payload.questions || typeof payload.questions !== 'object' || Array.isArray(payload.questions)) throw new Error('Invalid controlled question payload');
      questions += Object.keys(payload.questions).length;
      // Relevance is synthetic. No answer relationship or truth verdict is forced.
      return Response.json({ model: JEV_MODEL, answers: { relevance: { type: 'noul', noul: 0.8 } } });
    } }),
  };
  const result = await investigateTopic(reference.question, () => {}, deps);
  const source = result.caseRecord.evidence.find(item => item.sourceUrl === reference.url);
  const read = result.caseRecord.coverage.sourceReads?.find(item => item.evidenceId === source?.id);
  const expectedPassage = source?.content.kind === 'text' && source.content.attribution === 'page_quote' && source.content.text.includes(reference.syntheticPassage);
  return {
    referenceId: reference.id, condition, fixtureBasis: 'controlled_synthetic_adapters_not_a_provider_replay',
    admittedReference: condition === 'secondary_only' ? 'absent_in_controlled_pool' : condition === 'unsafe' ? 'unsafe_in_controlled_pool' : 'available_in_controlled_pool',
    formerSurfaceSelection: { referenceRetained: formerSelection(groups).includes(referenceUrl), method: 'selection_only_no_live_pool_claim' },
    actual: { referenceRetained: !!source, referenceRead: readUrls.includes(referenceUrl), referenceQuote: !!expectedPassage,
      referenceReadOutcome: read?.outcome ?? null, referenceDate: source?.publicationDate ?? null,
      sources: result.caseRecord.evidence.length, pageReads: readUrls.length, searches, uploads, requests, questions,
      omittedEvidenceCount: result.caseRecord.coverage.omittedEvidenceCount,
      pageQuotes: result.caseRecord.evidence.filter(item => item.content.kind === 'text' && item.content.attribution === 'page_quote').length,
      failures: result.caseRecord.coverage.sourceReads?.filter(item => item.outcome === 'fetch_failed' || item.outcome === 'binding_rejected').map(item => item.outcome) ?? [],
      unresolved: result.limitations.filter(item => item.includes('Primary-source coverage')),
      broadQuestionMode: result.claimReport?.mode, relations: result.claimReport?.sources.map(item => item.relation) ?? [] },
    result,
  };
}
export async function runTopicCoverageBenchmark() {
  const measurements = [];
  for (const reference of TOPIC_REFERENCES) measurements.push(await measureTopicReference(reference));
  const isro = TOPIC_REFERENCES[0];
  if (isro) for (const condition of ['secondary_only', 'unsafe', 'read_failed', 'wrong_resource', 'no_quote'] satisfies ReferenceCondition[]) measurements.push(await measureTopicReference(isro, condition));
  return { benchmark: 'topic-coverage-v1', basis: 'offline_controlled_synthetic', references: TOPIC_REFERENCES,
    observedLiveTrial: { question: TOPIC_REFERENCES[0]?.question, source: 'issue-30-recorded-audit', primaryRetained: false,
      omittedPool: 'unknown_not_captured', providerVariability: 'not_measured', freshLiveAcceptance: 'not_authorized_or_performed' },
    measurements: measurements.map(({ result: _result, ...measurement }) => measurement) };
}
