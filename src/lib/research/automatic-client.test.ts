import { afterEach, describe, expect, it, vi } from 'vitest';
import { investigateAutomatically, parseAutomaticResearchResult } from './automatic-client';
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
