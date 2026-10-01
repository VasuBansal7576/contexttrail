import { describe, expect, it, vi, afterEach } from 'vitest';
import { CASE_SCHEMA_VERSION, type CaseRecord, type Provenance } from './model';
import { CaseValidationError, parseCaseRecord, readCaseFromResult } from './parse';
import { caseFromImageInvestigation } from './from-image-investigation';
import { makeCandidate, makeExact, makeJudgment } from '../investigation/__tests__/testkit';
import { buildProvenanceGraph } from '../investigation/provenance-graph';
import { buildTimeline } from '../investigation/timeline';
import { buildClaimResult, buildTraceResult } from '../investigation/policy';
import type { EvidenceCandidate } from '../investigation/contracts/evidence';
import { applyEvent, readCachedResult, type InvestigationSnapshot } from '../stream/useInvestigation';
import { getMode, getStatus, getTimeline } from '../stream/result-view';

const now = '2026-10-01T00:00:00.000Z';
const provenance: Provenance = {
  method: 'manual', toolVersion: null, capturedAt: null, retrievedAt: now,
  rights: 'public_reference', retention: 'reference_only', contentHash: null,
};
function multimediaCase(): CaseRecord {
  return {
    schemaVersion: CASE_SCHEMA_VERSION, id: 'case-1', revision: 1, createdAt: now,
    claims: [
      { id: 'claim-1', kind: 'text', text: 'The product was recalled.', language: 'en', provenance },
      { id: 'claim-2', kind: 'text', text: 'El producto fue retirado.', language: 'es', provenance },
    ],
    assets: [
      { id: 'image-1', kind: 'image', location: { kind: 'not_retained' }, provenance },
      { id: 'video-1', kind: 'video', location: { kind: 'url', url: 'https://example.com/video.mp4' }, durationMs: 30_000, provenance },
      { id: 'audio-1', kind: 'audio', location: { kind: 'url', url: 'https://example.com/audio.mp3' }, durationMs: null, provenance },
    ],
    evidence: [
      { id: 'evidence-1', sourceUrl: 'https://example.com/announcement', title: 'Announcement',
        content: { kind: 'text', text: 'The product was recalled.', attribution: 'page_quote' },
        publicationDate: { status: 'observed', observation: { value: '2026-09-30', precision: 'day', source: { kind: 'page_time', url: 'https://example.com/announcement', recordedValue: '2026-09-30' } } }, provenance },
      { id: 'evidence-2', sourceUrl: 'https://example.com/video', title: null,
        content: { kind: 'media', assetId: 'video-1', span: { kind: 'time', startMs: 8000, durationMs: 4000 } },
        publicationDate: { status: 'unknown', reason: 'No publication date supplied.' }, provenance },
    ],
    occurrences: [
      { id: 'occurrence-1', assetId: 'video-1', span: { kind: 'time', startMs: 8000, durationMs: 4000 }, sourceEvidenceId: 'evidence-2', identity: { status: 'observed', method: 'manual source inspection', evidenceIds: ['evidence-2'] } },
      { id: 'occurrence-2', assetId: 'audio-1', span: { kind: 'time', startMs: 0, durationMs: 4000 }, sourceEvidenceId: 'evidence-2', identity: { status: 'unknown', reason: 'Audio has not been compared.' } },
    ],
    relations: [
      { id: 'relation-1', kind: 'evidence_claim', evidenceId: 'evidence-1', claimId: 'claim-1', relationship: 'supports', assessment: { status: 'inferred', evidenceIds: ['evidence-1'], method: 'manual reading', rationale: 'The announcement describes this product.' } },
      { id: 'relation-2', kind: 'claim_claim', fromClaimId: 'claim-1', toClaimId: 'claim-2', relationship: 'translation', assessment: { status: 'unknown', reason: 'Translation needs review.' } },
      { id: 'relation-3', kind: 'occurrence_occurrence', fromOccurrenceId: 'occurrence-1', toOccurrenceId: 'occurrence-2', relationship: 'similar_media', assessment: { status: 'inferred', evidenceIds: ['evidence-2'], method: 'comparison-test-v1', rationale: 'A matching audio segment was proposed.' } },
    ],
    coverage: { scope: 'retrieved_evidence', completeness: 'partial', omittedEvidenceCount: 0, originalPublication: { status: 'unknown', reason: 'No original publication established.' }, limitations: ['Only supplied sources examined.'], searches: [] },
  };
}

describe('versioned multimedia case boundary', () => {
  it('round-trips image, video segments, audio references, claims and all relation types', () => {
    const value = multimediaCase();
    expect(parseCaseRecord(JSON.parse(JSON.stringify(value)))).toEqual(value);
    expect(readCaseFromResult({ caseRecord: value })).toEqual({ status: 'available', caseRecord: value });
  });
  it('supports a text-only case with no media', () => {
    const value = multimediaCase();
    value.assets = []; value.occurrences = []; value.relations = [];
    value.evidence = [value.evidence[0]];
    expect(parseCaseRecord(value)).toEqual(value);
  });
  it('returns a detached parsed record and strips unknown fields', () => {
    const value = multimediaCase();
    const parsed = parseCaseRecord({ ...value, ignored: 'future optional value' });
    parsed.claims[0].text = 'Changed';
    expect(value.claims[0].text).toBe('The product was recalled.');
    expect(parsed).not.toHaveProperty('ignored');
  });
  it.each([
    ['unsupported version', (c: CaseRecord) => ({ ...c, schemaVersion: 'contexttrail-case-v2' })],
    ['zero revision', (c: CaseRecord) => ({ ...c, revision: 0 })],
    ['invalid timestamp', (c: CaseRecord) => ({ ...c, createdAt: '2026-02-30T00:00:00Z' })],
    ['duplicate claim', (c: CaseRecord) => ({ ...c, claims: [...c.claims, c.claims[0]] })],
    ['dangling claim', (c: CaseRecord) => ({ ...c, claims: [] })],
    ['dangling asset', (c: CaseRecord) => ({ ...c, assets: [] })],
    ['dangling evidence', (c: CaseRecord) => ({ ...c, evidence: [] })],
    ['dangling occurrence', (c: CaseRecord) => ({ ...c, occurrences: [] })],
    ['empty observed support', (c: CaseRecord) => ({ ...c, occurrences: [{ ...c.occurrences[0], identity: { status: 'observed', method: 'manual', evidenceIds: [] } }] })],
    ['missing support reference', (c: CaseRecord) => ({ ...c, relations: [{ ...c.relations[0], assessment: { status: 'inferred', method: 'model', rationale: 'proposal', evidenceIds: ['missing'] } }] })],
    ['invented certainty', (c: CaseRecord) => ({ ...c, relations: [{ ...c.relations[0], assessment: { status: 'proven_true' } }] })],
    ['self relation', (c: CaseRecord) => ({ ...c, relations: [{ ...c.relations[1], toClaimId: 'claim-1' }] })],
    ['similarity as observed spread', (c: CaseRecord) => ({ ...c, relations: [{ ...c.relations[2], assessment: { status: 'observed', method: 'similarity', evidenceIds: ['evidence-2'] } }] })],
    ['negative span', (c: CaseRecord) => ({ ...c, occurrences: [{ ...c.occurrences[0], span: { kind: 'time', startMs: -1, durationMs: 1 } }] })],
    ['empty span', (c: CaseRecord) => ({ ...c, occurrences: [{ ...c.occurrences[0], span: { kind: 'time', startMs: 0, durationMs: 0 } }] })],
    ['out-of-bounds span', (c: CaseRecord) => ({ ...c, occurrences: [{ ...c.occurrences[0], span: { kind: 'time', startMs: 29000, durationMs: 2000 } }] })],
    ['time span on image', (c: CaseRecord) => ({ ...c, occurrences: [{ ...c.occurrences[0], assetId: 'image-1' }] })],
    ['media evidence out of bounds', (c: CaseRecord) => ({ ...c, evidence: [{ ...c.evidence[1], content: { kind: 'media', assetId: 'video-1', span: { kind: 'time', startMs: 30_000, durationMs: 1 } } }] })],
    ['credential URL', (c: CaseRecord) => ({ ...c, evidence: [{ ...c.evidence[0], sourceUrl: 'https://user:secret@example.com/' }] })],
    ['embedded bytes', (c: CaseRecord) => ({ ...c, assets: [{ ...c.assets[0], location: { kind: 'url', url: 'data:image/png;base64,AAAA' } }] })],
    ['unbounded collection', (c: CaseRecord) => ({ ...c, claims: Array(1001).fill(c.claims[0]) })],
    ['malformed content hash', (c: CaseRecord) => ({ ...c, claims: [{ ...c.claims[0], provenance: { ...provenance, contentHash: 'made-up' } }] })],
    ['unbacked date', (c: CaseRecord) => ({ ...c, evidence: [{ ...c.evidence[0], publicationDate: { status: 'observed', observation: { value: '2026-09-30', precision: 'day', source: { kind: 'page_meta', url: null, recordedValue: '2026-09-30' } } } }] })],
    ['false day precision', (c: CaseRecord) => ({ ...c, evidence: [{ ...c.evidence[0], publicationDate: { status: 'observed', observation: { value: '2026-09', precision: 'day', source: { kind: 'page_time', url: 'https://example.com', recordedValue: '2026-09' } } } }] })],
    ['invalid calendar date', (c: CaseRecord) => ({ ...c, evidence: [{ ...c.evidence[0], publicationDate: { status: 'observed', observation: { value: '2026-02-30', precision: 'day', source: { kind: 'page_time', url: 'https://example.com', recordedValue: '2026-02-30' } } } }] })],
    ['invented complete coverage', (c: CaseRecord) => ({ ...c, coverage: { ...c.coverage, completeness: 'complete' } })],
    ['invented original', (c: CaseRecord) => ({ ...c, coverage: { ...c.coverage, originalPublication: { status: 'observed' } } })],
  ])('rejects %s', (_, mutate) => {
    expect(() => parseCaseRecord(mutate(multimediaCase()))).toThrow(CaseValidationError);
    expect(readCaseFromResult({ caseRecord: mutate(multimediaCase()) }).status).toBe('invalid');
  });
  it.each([null, [], 0, 'case', {}])('rejects malformed case %j', value => {
    expect(() => parseCaseRecord(value)).toThrow(CaseValidationError);
  });
});

function imageResult(candidates: EvidenceCandidate[], claim: string | null = 'The product was recalled.') {
  const graph = buildProvenanceGraph({ candidates, pairwiseJudgments: new Map(), claim, claimDate: null, claimDatePrecision: 'unknown' });
  const excerpts = new Map(candidates.flatMap(c => c.snippet === null ? [] : [[c.id, c.snippet] as const]));
  const timeline = buildTimeline(candidates, graph, excerpts, excerpts);
  const common = { candidates, ...timeline, graph, limitations: [], requestLog: [{ engine: 'google_lens', attempted: 1, returned: candidates.length, retained: candidates.length, durationMs: 10, searchId: 'search-1' }] };
  return claim === null ? buildTraceResult(common) : buildClaimResult({ ...common, claim, claimDate: null, webContextAvailable: true, takeaways: [] });
}
const adapt = (result: ReturnType<typeof imageResult>) => caseFromImageInvestigation({ result, id: 'investigation-1', createdAt: now });

describe('image investigation adapter', () => {
  it('preserves the complete legacy result and exposes inferred findings without creating transmission edges', () => {
    const candidate = makeExact({ id: 'exact-1', snippet: 'The product was recalled.', excerptSource: 'serp_snippet', judgment: makeJudgment() });
    const legacy = imageResult([candidate]);
    const before = structuredClone(legacy);
    const value = adapt(legacy);
    expect(legacy).toEqual(before);
    expect(value.claims[0].text).toBe('The product was recalled.');
    expect(value.evidence[0].content).toEqual({ kind: 'text', text: candidate.snippet, attribution: 'search_snippet' });
    expect(value.evidence[0].provenance.capturedAt).toBeNull();
    expect(value.evidence[0].provenance.retrievedAt).toBe('2026-09-25T00:00:00.000Z');
    expect(value.occurrences[0].identity.status).toBe('inferred');
    expect(value.relations).toHaveLength(1);
    expect(value.relations[0]).toMatchObject({ kind: 'evidence_claim', relationship: 'supports', assessment: { status: 'inferred', method: 'jev-1.13.0' } });
    expect(value.assets[0].location.kind).toBe('not_retained');
    expect(value.coverage.originalPublication.status).toBe('unknown');
    expect(value.coverage.searches[0].searchId).toBe('search-1');
  });
  it('keeps trace mode claimless and leaves visual leads unknown', () => {
    const value = adapt(imageResult([makeCandidate()], null));
    expect(value.claims).toEqual([]);
    expect(value.relations).toEqual([]);
    expect(value.occurrences[0].identity.status).toBe('unknown');
  });
  it('does not turn contextual evidence into a media sighting', () => {
    const value = adapt(imageResult([makeCandidate({ mediaRelationship: null, retrievalKind: 'google_search', judgment: makeJudgment() })]));
    expect(value.evidence).toHaveLength(1);
    expect(value.occurrences).toEqual([]);
    expect(value.relations[0].assessment.status).toBe('inferred');
  });
  it('retains month precision and source binding separately from retrieval time', () => {
    const value = adapt(imageResult([makeExact({ publishedAt: '2020-02-01', publishedAtSource: 'page_json_ld', datePrecision: 'month', dateStatus: 'usable' })]));
    expect(value.evidence[0].publicationDate).toMatchObject({ status: 'observed', observation: { value: '2020-02', precision: 'month', source: { kind: 'page_json_ld', recordedValue: '2020-02-01' } } });
  });
  it('marks search-derived dates inferred and leaves missing sources unknown', () => {
    const values = [
      makeExact({ id: 'search-date', publishedAt: '2020-01-01', publishedAtSource: 'serpapi', datePrecision: 'day', dateStatus: 'usable' }),
      makeExact({ id: 'no-source', publishedAt: '2020-01-01', datePrecision: 'day', dateStatus: 'usable' }),
      makeExact({ id: 'disputed', publishedAt: null, datePrecision: 'unknown', dateStatus: 'disputed' }),
    ];
    const dates = new Map(adapt(imageResult(values)).evidence.map(item => [item.id, item.publicationDate.status]));
    expect([...dates.entries()]).toEqual(expect.arrayContaining([['search-date', 'inferred'], ['no-source', 'unknown'], ['disputed', 'disputed']]));
  });
  it('handles older results without a source-linked report without inventing findings', () => {
    const legacy = imageResult([makeExact({ judgment: makeJudgment() })]);
    delete legacy.sourceLinkedReport;
    expect(adapt(legacy).relations).toEqual([]);
    expect(readCaseFromResult(legacy)).toEqual({ status: 'absent' });
  });
  it('redacts audit URLs and deduplicates evidence across legacy partitions', () => {
    const legacy = imageResult([makeCandidate({ sourceUrl: 'https://user:secret@example.com/source?token=private#private' })]);
    legacy.supportingEvidence.push(...legacy.undatedEvidence);
    const value = adapt(legacy);
    expect(value.evidence).toHaveLength(1);
    expect(value.evidence[0].sourceUrl).toBe('https://example.com/source');
    expect(JSON.stringify(value)).not.toContain('secret');
    expect(JSON.stringify(value)).not.toContain('token=');
  });
  it('normalizes empty titles and reports omitted source references', () => {
    const legacy = imageResult([
      makeExact({ id: 'blank', title: '   ' }),
      makeExact({ id: 'long-url', sourceUrl: `https://example.com/${'x'.repeat(5000)}` }),
    ]);
    const value = adapt(legacy);
    expect(value.evidence).toHaveLength(1);
    expect(value.evidence.find(e => e.id === 'blank')?.title).toBeNull();
    expect(value.coverage.omittedEvidenceCount).toBe(1);
    expect(value.coverage.limitations).toContain('case_reference_omitted_invalid_source');
    expect(legacy.undatedEvidence).toHaveLength(2);
  });
  it('rejects an oversized projection rather than silently truncating quotes', () => {
    const legacy = imageResult([makeExact()]);
    const quote = 'word '.repeat(5000);
    legacy.undatedEvidence[0].excerpt = quote;
    expect(() => adapt(legacy)).toThrow(CaseValidationError);
    expect(legacy.undatedEvidence[0].excerpt).toBe(quote);
  });
  it('retains both supporting and contrary assessments instead of resolving by count', () => {
    const value = adapt(imageResult([
      makeExact({ judgment: makeJudgment() }),
      makeExact({ judgment: makeJudgment({ claimRelation: { supports: 0, contradicts: 1, neutral: 0, insufficient: 0 } }) }),
    ]));
    expect(value.relations.map(r => r.relationship)).toEqual(['supports', 'challenges']);
    expect(value).not.toHaveProperty('verdict');
  });
});

afterEach(() => vi.unstubAllGlobals());
describe('completed-result compatibility', () => {
  it.each([false, true])('streams, caches and restores the %s case addition without changing old selectors', includeCase => {
    const legacy = imageResult([makeCandidate()]);
    const result = includeCase ? { ...legacy, caseRecord: adapt(legacy) } : legacy;
    let cached: string | null = null;
    vi.stubGlobal('sessionStorage', { setItem: (_: string, value: string) => { cached = value; }, getItem: () => cached });
    const snapshot: InvestigationSnapshot = { phase: 'streaming', investigationId: 'inv', stages: [], searchCounts: [], evidence: [], classifications: {}, partialTimeline: null, preliminaryVerdict: null, divergence: null, result: null, error: null };
    const event = JSON.parse(JSON.stringify({ type: 'investigation.completed', result }));
    const applied = applyEvent(snapshot, event);
    const restored = readCachedResult();
    expect(applied.phase).toBe('completed');
    expect(restored).toEqual(result);
    expect(getMode(restored)).toBe('claim-check');
    expect(getStatus(restored)).toBe('INSUFFICIENT_EVIDENCE');
    expect(getTimeline(restored).unknownDate).toHaveLength(1);
    expect(readCaseFromResult(restored).status).toBe(includeCase ? 'available' : 'absent');
    expect(cached).not.toContain('data:image');
  });
  it('isolates a malformed case from the legacy report', () => {
    const legacy = JSON.parse(JSON.stringify(imageResult([])));
    const result = { ...legacy, caseRecord: { schemaVersion: 'future-version' } };
    expect(readCaseFromResult(result).status).toBe('invalid');
    expect(getStatus(result)).toBe('INSUFFICIENT_EVIDENCE');
  });
});
