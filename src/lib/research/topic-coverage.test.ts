import { describe, expect, it } from 'vitest';
import { originalAccountCue, selectTopicSources, type TopicCandidate } from './topic-selection';
import { normalizeSearchResponse } from '../serpapi/normalize';
import { TOPIC_REFERENCES } from '../../../scripts/fixtures/topic-coverage/references';
import { measureTopicReference, runTopicCoverageBenchmark } from '../../../scripts/fixtures/topic-coverage/benchmark';

describe('bounded topic original-account coverage (synthetic adapters)', () => {
  it.each(TOPIC_REFERENCES)('retains and reads an available low-ranked reference for $id without forcing a broad-question verdict', async reference => {
    const measured = await measureTopicReference(reference);
    expect(measured.formerSurfaceSelection.referenceRetained).toBe(false);
    expect(measured.actual).toMatchObject({ referenceRetained: true, referenceRead: true, referenceQuote: true, referenceReadOutcome: 'page_quote', sources: 12, pageReads: 10, searches: 6, uploads: 0, requests: 12, questions: 60, broadQuestionMode: 'source_assertions' });
    expect(measured.actual.relations.every(relation => relation === 'insufficient')).toBe(true);
    expect(measured.result.caseRecord.claims).toEqual([]);
    if (reference.publicationDate) expect(measured.actual.referenceDate).toMatchObject({ status: 'observed', observation: { value: reference.publicationDate } });
    else expect(measured.actual.referenceDate?.status).toBe('unknown');
    expect(measured.actual.unresolved).toHaveLength(1);
    expect(measured.result.caseRecord.evidence[0].sourceUrl).toBe(reference.url);
    expect(measured.result.caseRecord.evidence.some(item => item.sourceUrl.includes('secondary-1.'))).toBe(true);
    expect(measured.result.caseRecord.evidence.some(item => item.sourceUrl.includes('secondary-2.'))).toBe(true);
  });
  it('filters unsafe references before allocating eight retained/five read slots and keeps other search surfaces', () => {
    const entries: TopicCandidate[] = [];
    for (const search of [0, 1, 2]) {
      const raw = Array.from({ length: 10 }, (_, index) => ({ link: `https://surface-${search}.example.org/${index}${index < 8 ? '?access_token=synthetic' : ''}`, title: 'General retrieved source', snippet: 'A secondary lead.' }));
      const batch = normalizeSearchResponse({ organic_results: raw }, 'google_search', { retrievedAt: '2026-10-02T00:00:00Z' });
      entries.push(...batch.candidates.map(candidate => ({ candidate, dates: {}, search })));
    }
    const selected = selectTopicSources('Institution policy research', entries);
    expect(selected).toHaveLength(6);
    expect(selected.map(entry => entry.search)).toEqual([0, 1, 2, 0, 1, 2]);
    expect(selected.every(entry => !entry.candidate.sourceUrl.includes('access_token'))).toBe(true);
  });
  it.each(['secondary_only', 'unsafe', 'read_failed', 'wrong_resource', 'no_quote'] satisfies Parameters<typeof measureTopicReference>[1][])('keeps %s coverage unresolved and preserves safe failure/quote accounting', async condition => {
    const reference = TOPIC_REFERENCES[0]; if (!reference) throw new Error('Missing independent registry reference');
    const measured = await measureTopicReference(reference, condition);
    expect(measured.actual.referenceQuote).toBe(false);
    expect(measured.actual).toMatchObject({ sources: 12, searches: 6, uploads: 0, pageReads: 10, requests: 12, questions: 60 });
    expect(measured.actual.unresolved).toHaveLength(1);
    if (condition === 'secondary_only' || condition === 'unsafe') expect(measured.actual.referenceRetained).toBe(false);
    if (condition === 'read_failed') expect(measured.actual.failures).toContain('fetch_failed');
    if (condition === 'wrong_resource') expect(measured.actual.failures).toContain('binding_rejected');
    if (condition === 'no_quote') expect(measured.actual.referenceReadOutcome).toBe('no_readable_text');
    if (condition !== 'secondary_only' && condition !== 'unsafe') {
      expect(measured.actual.referenceDate?.status).toBe('unknown');
      expect(measured.result.caseRecord.evidence[0]).toMatchObject({ sourceUrl: reference.url, content: { kind: 'text', attribution: 'search_snippet', text: reference.syntheticLead } });
    }
    if (condition === 'unsafe') expect(JSON.stringify(measured.result)).not.toContain('access_token');
  });
  it('uses topical document cues rather than institution names, hostnames or authority shortcuts', () => {
    const topic = 'Is ISRO being privatised?';
    expect(originalAccountCue(topic, { title: 'ISRO recruitment statement', snippet: 'ISRO careers and employment information.' })).toBe(0);
    expect(originalAccountCue(topic, { title: 'Privatisation commentary', snippet: 'Secondary discussion about ISRO privatisation.' })).toBe(0);
    expect(originalAccountCue(topic, { title: 'ISRO privatisation clarification statement', snippet: null })).toBeGreaterThan(0);
    expect(originalAccountCue('How does monetary policy affect inflation?', { title: 'Monetary policy statement about inflation', snippet: null })).toBeGreaterThan(0);
    const institutionQuestion = 'What changed in Bank of England interest-rate policy?';
    expect(originalAccountCue(institutionQuestion, { title: 'Bank of England press release on staff holidays', snippet: 'Our holiday policy and staffing arrangements.' })).toBe(0);
    expect(originalAccountCue(institutionQuestion, { title: 'Bank of England interest-rate policy statement', snippet: null })).toBeGreaterThan(0);
  });
  it('keeps reference registry independent and admits the live omitted pool remains unknown', async () => {
    const benchmark = await runTopicCoverageBenchmark();
    expect(benchmark.measurements).toHaveLength(8);
    expect(benchmark.observedLiveTrial).toMatchObject({ omittedPool: 'unknown_not_captured', providerVariability: 'not_measured', freshLiveAcceptance: 'not_authorized_or_performed' });
    expect(benchmark.references.every(reference => reference.syntheticPassage.includes('synthetic test input'))).toBe(true);
    expect(benchmark.measurements.every(measurement => measurement.actual.searches <= 6 && measurement.actual.sources <= 12 && measurement.actual.pageReads <= 10 && measurement.actual.requests <= 12 && measurement.actual.questions <= 60)).toBe(true);
  });
});
