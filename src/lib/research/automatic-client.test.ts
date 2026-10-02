import { afterEach, describe, expect, it, vi } from 'vitest';
import { investigateAutomatically, parseAutomaticResearchResult } from './automatic-client';
import { buildClaimReport } from './claim-report';
import { CASE_SCHEMA_VERSION, type CaseRecord } from '../cases/model';

const caseRecord: CaseRecord = { schemaVersion: CASE_SCHEMA_VERSION, id: 'test', revision: 1, createdAt: '2026-10-01T00:00:00Z', claims: [], assets: [], evidence: [], occurrences: [], relations: [], coverage: { scope: 'retrieved_evidence', completeness: 'partial', omittedEvidenceCount: 0, originalPublication: { status: 'unknown', reason: 'No original established.' }, limitations: ['Test evidence only.'], searches: [] } };
const result = { kind: 'topic', question: 'A real question?', caseRecord, frames: [], assessments: [], limitations: [] };
afterEach(() => vi.unstubAllGlobals());
function stream(chunks: string[]) { const encoder = new TextEncoder(); return new ReadableStream<Uint8Array>({ start(controller) { chunks.forEach(chunk => controller.enqueue(encoder.encode(chunk))); controller.close(); } }); }
describe('automatic research stream boundary', () => {
  it('reads chunked progress and completion without a final newline', async () => {
    const progress = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream(['{"type":"research.pro', 'gress","message":"Reading sources"}\n', JSON.stringify({ type: 'research.completed', result })]))));
    expect((await investigateAutomatically(new FormData(), new AbortController().signal, progress)).question).toBe(result.question);
    expect(progress).toHaveBeenCalledWith('Reading sources');
  });
  it('rejects incomplete streams, server failures and malformed case records', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream(['{"type":"research.progress","message":"Searching"}\n']))));
    await expect(investigateAutomatically(new FormData(), new AbortController().signal, () => {})).rejects.toThrow('before a complete result');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream(['{"type":"research.error","message":"Provider unavailable"}\n']))));
    await expect(investigateAutomatically(new FormData(), new AbortController().signal, () => {})).rejects.toThrow('Provider unavailable');
    expect(() => parseAutomaticResearchResult({ ...result, caseRecord: {} })).toThrow();
  });
  it('cancels a pending stream read and rejects without accepting stale data', async () => {
    const cancelled = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ cancel: cancelled }))));
    const controller = new AbortController();
    const pending = investigateAutomatically(new FormData(), controller.signal, () => {});
    await new Promise(resolve => setTimeout(resolve, 0)); controller.abort();
    await expect(pending).rejects.toThrow('Aborted'); expect(cancelled).toHaveBeenCalled();
  });
  it('bounds both a pending line and total response bytes to 8 MiB', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream(['x'.repeat(8 * 1024 * 1024 + 1)]))));
    await expect(investigateAutomatically(new FormData(), new AbortController().signal, () => {})).rejects.toThrow('8 MiB limit');
    const progress = JSON.stringify({ type: 'research.progress', message: 'x'.repeat(1024 * 1024) }) + '\n';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream(Array.from({ length: 8 }, () => progress)))));
    await expect(investigateAutomatically(new FormData(), new AbortController().signal, () => {})).rejects.toThrow('8 MiB limit');
  });
  it('validates relevance probabilities, source binding and the pinned model', () => {
    const evidence = { id: 'source', sourceUrl: 'https://example.com/article', title: 'Article', content: { kind: 'reference' }, publicationDate: { status: 'unknown', reason: 'No date.' }, provenance: { method: 'retrieval', toolVersion: null, capturedAt: null, retrievedAt: null, rights: 'public_reference', retention: 'reference_only', contentHash: null } };
    const input = { ...result, caseRecord: { ...caseRecord, evidence: [evidence] } };
    const assessment = { evidenceId: 'source', relevance: 0.85, model: 'jev-1.13.0' };
    expect(parseAutomaticResearchResult({ ...input, assessments: [assessment] }).assessments).toEqual([assessment]);
    expect(parseAutomaticResearchResult({ ...input, assessments: [{ ...assessment, relevance: null, model: null }] }).assessments[0].relevance).toBeNull();
    for (const invalid of [{ ...assessment, evidenceId: 'missing' }, { ...assessment, relevance: NaN }, { ...assessment, relevance: Infinity }, { ...assessment, relevance: -0.01 }, { ...assessment, relevance: 1.01 }, { ...assessment, model: 'jev-latest' }, { ...assessment, model: null }]) expect(() => parseAutomaticResearchResult({ ...input, assessments: [invalid] })).toThrow();
    expect(() => parseAutomaticResearchResult({ ...input, assessments: [assessment, assessment] })).toThrow();
  });
  it('rejects invalid timestamps and drops executable frame URLs', () => {
    const frame = { timestampMs: 1000, imageResult: { timeline: [{ evidenceId: 'unsafe', sourceUrl: 'javascript:alert(1)' }, { evidenceId: 'safe', sourceUrl: 'https://example.com/source', excerpt: 'Actual source text.' }] } };
    const parsed = parseAutomaticResearchResult({ ...result, kind: 'video', frames: [frame] });
    expect(parsed.frames[0].imageResult.timeline).toHaveLength(1);
    expect(parsed.frames[0].imageResult.timeline[0].excerpt).toBe('Actual source text.');
    expect(parsed.frames[0].imageResult.timeline[0].dateStatus).toBe('unknown');
    expect(() => parseAutomaticResearchResult({ ...result, frames: [{ ...frame, timestampMs: -1 }] })).toThrow();
  });
});

it('retains only a validated source-bound claim report, rejecting forged or stale output', () => {
  const claimReport = buildClaimReport(result.question, caseRecord, []);
  expect(parseAutomaticResearchResult({ ...result, claimReport }).claimReport).toEqual(claimReport);
  for (const invalid of [null, {}, { ...claimReport, claim: 'Invented claim' }, { ...claimReport, evidenceBinding: 'stale' }, { ...claimReport, limitations: [] }]) {
    expect(() => parseAutomaticResearchResult({ ...result, claimReport: invalid })).toThrow('invalid or stale claim report');
  }
  expect(() => parseAutomaticResearchResult({ ...result, question: 'A changed question?', claimReport })).toThrow('invalid or stale claim report');
});

it('validates sampled-frame claim status and binds takeaway IDs to safe retained sources', () => {
  const imageResult = { mode: 'claim_check', claim: 'This clip is current.', status: 'POSSIBLE_CONTEXT_CONFLICT', policyReasons: [{ gate: 'qualifying_conflicts', passed: false, supportIds: ['frame-source'] }], timeline: [{ evidenceId: 'frame-source', sourceUrl: 'https://example.com/frame' }], takeaways: [{ code: 'historical_reuse', evidenceIds: ['frame-source'] }, { code: 'temporal_conflict', evidenceIds: ['missing'] }, { code: 'invented_verdict', evidenceIds: ['frame-source'] }] };
  const retained = { id: 'frame-source', sourceUrl: 'https://example.com/frame', title: null, content: { kind: 'reference' }, publicationDate: { status: 'unknown', reason: 'Unknown date.' }, provenance: { method: 'retrieval', toolVersion: null, capturedAt: null, retrievedAt: null, rights: 'unknown', retention: 'reference_only', contentHash: null } };
  const input = { ...result, kind: 'video', caseRecord: { ...caseRecord, evidence: [retained] }, frames: [{ timestampMs: 0, imageResult }] };
  expect(parseAutomaticResearchResult(input).frames[0].imageResult.captionComparison).toEqual({ mode: 'claim_check', claim: 'This clip is current.', status: 'POSSIBLE_CONTEXT_CONFLICT', takeaways: [{ code: 'historical_reuse', evidenceIds: ['frame-source'] }] });
  expect(() => parseAutomaticResearchResult({ ...input, frames: [{ timestampMs: 0, imageResult: { ...imageResult, status: 'TRUE' } }] })).toThrow('invalid caption comparison');
});


it.each(['CONTEXT_CONFLICT', 'POSSIBLE_CONTEXT_CONFLICT', 'NO_CONFLICT_FOUND'])('downgrades unsupported %s after unsafe or absent sources are filtered', status => {
  for (const timeline of [[], [{ evidenceId: 'omitted', sourceUrl: 'https://user:secret@example.com/source' }], [{ evidenceId: 'omitted', sourceUrl: 'https://example.com/not-in-case' }]]) {
    const imageResult = { mode: 'claim_check', claim: 'This clip is current.', status, timeline, takeaways: [{ code: 'temporal_conflict', evidenceIds: ['omitted'] }], policyReasons: [{ gate: 'qualifying_conflicts', passed: true, supportIds: ['omitted'] }] };
    const view = parseAutomaticResearchResult({ ...result, kind: 'video', frames: [{ timestampMs: 0, imageResult }] });
    expect(view.frames[0].imageResult.captionComparison).toMatchObject({ status: 'INSUFFICIENT_EVIDENCE', takeaways: [] });
    expect(view.frames[0].imageResult.captionComparison?.evidenceWarning).toContain('safe retained evidence');
  }
});
it('retains policy-backed conflict only while both qualifying/corroborating sources survive', () => {
  const evidence = ['one','two'].map(id => ({ id, sourceUrl: `https://example.com/${id}`, title: null, content: { kind: 'reference' }, publicationDate: { status: 'unknown', reason: 'Unknown date.' }, provenance: { method: 'retrieval', toolVersion: null, capturedAt: null, retrievedAt: null, rights: 'unknown', retention: 'reference_only', contentHash: null } }));
  const imageResult = { mode: 'claim_check', claim: 'This clip is current.', status: 'CONTEXT_CONFLICT', timeline: evidence.map(item => ({ evidenceId: item.id, sourceUrl: item.sourceUrl })), takeaways: [], policyReasons: [{ gate: 'qualifying_conflicts', passed: true, supportIds: ['one','two'] }, { gate: 'corroborating_pair', passed: true, supportIds: ['one','two'] }] };
  const input = { ...result, kind: 'video', caseRecord: { ...caseRecord, evidence }, frames: [{ timestampMs: 0, imageResult }] };
  expect(parseAutomaticResearchResult(input).frames[0].imageResult.captionComparison?.status).toBe('CONTEXT_CONFLICT');
  const changed = { ...input, caseRecord: { ...caseRecord, evidence: evidence.slice(0, 1) } };
  expect(parseAutomaticResearchResult(changed).frames[0].imageResult.captionComparison?.status).toBe('INSUFFICIENT_EVIDENCE');
});

it('withholds no-conflict when filtering breaks its original coverage and support gates', () => {
  const evidence = ['one','two','three'].map(id => ({ id, sourceUrl: `https://example.com/${id}`, title: null, content: { kind: 'reference' }, publicationDate: { status: 'unknown', reason: 'Unknown date.' }, provenance: { method: 'retrieval', toolVersion: null, capturedAt: null, retrievedAt: null, rights: 'unknown', retention: 'reference_only', contentHash: null } }));
  const gates = ['relevant_core_coverage','distinct_domains','distinct_reporting_groups','corroborating_pair','strong_support'].map(gate => ({ gate, passed: true, supportIds: ['one','two','three'] }));
  const imageResult = { mode: 'claim_check', claim: 'This clip is current.', status: 'NO_CONFLICT_FOUND', timeline: evidence.map(item => ({ evidenceId: item.id, sourceUrl: item.sourceUrl })), takeaways: [], policyReasons: gates };
  const input = { ...result, kind: 'video', caseRecord: { ...caseRecord, evidence }, frames: [{ timestampMs: 0, imageResult }] };
  expect(parseAutomaticResearchResult(input).frames[0].imageResult.captionComparison?.status).toBe('NO_CONFLICT_FOUND');
  expect(parseAutomaticResearchResult({ ...input, caseRecord: { ...caseRecord, evidence: evidence.slice(0, 2) } }).frames[0].imageResult.captionComparison?.status).toBe('INSUFFICIENT_EVIDENCE');
});
