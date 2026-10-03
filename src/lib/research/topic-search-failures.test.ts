import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ProviderError } from '../providers/http';
import { SerpapiClient } from '../serpapi/client';
import { investigateTopic } from './automatic';
import { parseAutomaticResearchResult } from './automatic-client';
import { parseCaseRecord } from '../cases/parse';
import { parseResearchCaseView } from './client';
import { localResearchService } from './service';
import { reviewResearch } from './workflow';

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))); });
const topic = 'What changed in the reef recovery programme?';
const secret = 'https://provider.example/?api_key=DO_NOT_RETAIN';
async function run(first: () => Promise<unknown>) {
  let attempt = 0;
  const search = vi.fn(async () => attempt++ === 0 ? first() : ({ news_results: [{ link: 'https://reef.example/report', title: 'Reef recovery programme context' }], organic_results: [] }));
  const fetchPage = vi.fn(async (url: string) => ({ url, html: '<html><body></body></html>' }));
  const result = await investigateTopic(topic, () => {}, { serpapi: { search, uploadImage: async () => 'unused' }, jev: null, fetchPage });
  return { result, search, fetchPage };
}
const reject = (error: unknown) => async () => { throw error; };

describe('future-only topic search failure diagnostics', () => {
  it.each([
    ['timeout', new ProviderError('timeout', secret), null],
    ['aborted', new ProviderError('aborted', secret), null],
    ['http', new ProviderError('http', secret, 429), 429],
    ['network', new ProviderError('network', secret), null],
    ['malformed', new ProviderError('malformed', secret), null],
    ['unconfigured', new ProviderError('unconfigured', secret), null],
    ['unknown', new Error(secret), null],
    ['unknown', { kind: 'timeout', message: secret, status: 429 }, null],
    ['unknown', new ProviderError('http', secret, 0), null],
    ['network', new ProviderError('network', secret, 503), null],
  ])('retains only the typed %s category and bounded status', async (category, error, httpStatus) => {
    const { result, search, fetchPage } = await run(reject(error));
    expect(result.caseRecord.coverage.topicCandidateAudit?.searches[0]).toMatchObject({ outcome: 'unavailable', failure: { category, httpStatus } });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain('DO_NOT_RETAIN');
    expect(parseAutomaticResearchResult(result).caseRecord).toEqual(result.caseRecord);
    expect(search).toHaveBeenCalledTimes(3); expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['provider_reported', { search_metadata: { status: 'Error' }, error: secret }],
    ['provider_reported', { error: secret }],
    ['provider_reported', { search_metadata: { status: 'Success' }, error: secret }],
    ['malformed', null], ['malformed', 'not an object'], ['malformed', []],
    ['unrecognized_surface', { search_metadata: { status: 'Processing' }, organic_results: [] }],
    ['unrecognized_surface', { search_metadata: { status: 'Success' }, news_results: [] }],
    ['unrecognized_surface', { organic_results: {} }],
  ])('distinguishes %s responses without copying raw errors', async (category, raw) => {
    const { result } = await run(async () => raw);
    expect(result.caseRecord.coverage.topicCandidateAudit?.searches[0]).toMatchObject({ outcome: 'unavailable', failure: { category, httpStatus: null } });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it.each([
    { search_metadata: { status: 'Success' }, error: "Google hasn't returned any results for this query." },
    { search_metadata: { status: 'Success' }, organic_results: [] },
    { organic_results: [] },
  ])('keeps documented empty success distinct from failure', async raw => {
    const { result } = await run(async () => raw);
    expect(result.caseRecord.coverage.topicCandidateAudit?.searches[0]).toEqual({ searchIndex: 0, outcome: 'succeeded', normalizedCount: 0, droppedBeforeNormalizationCount: 0, duplicateCount: 0 });
  });

  it('still stops the entire investigation on caller cancellation', async () => {
    const controller = new AbortController();
    const search = vi.fn(async () => { controller.abort(); throw new ProviderError('timeout', secret); });
    await expect(investigateTopic(topic, () => {}, { serpapi: { search, uploadImage: async () => 'unused' }, jev: null, fetchPage: vi.fn(), signal: controller.signal })).rejects.toThrow();
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('records the actual bounded SerpApi deadline without changing its 12-second limit', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      }));
      const client = new SerpapiClient('offline-only', { fetchImpl });
      const pending = run(() => client.search({ engine: 'google', q: topic }));
      await vi.advanceTimersByTimeAsync(11_999);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      const { result } = await pending;
      expect(result.caseRecord.coverage.topicCandidateAudit?.searches[0]).toMatchObject({ failure: { category: 'timeout', httpStatus: null } });
    } finally { vi.useRealTimers(); }
  });

  it.each([
    ['http', async () => new Response(null, { status: 503 }), 503],
    ['malformed', async () => new Response('invalid JSON'), null],
    ['aborted', async () => { throw new DOMException(secret, 'AbortError'); }, null],
    ['network', async () => { throw new TypeError(secret); }, null],
  ])('retains actual SerpApi client %s classifications without raw error text', async (category, fetchImpl, httpStatus) => {
    const client = new SerpapiClient('offline-only', { fetchImpl });
    const { result } = await run(() => client.search({ engine: 'google', q: topic }));
    expect(result.caseRecord.coverage.topicCandidateAudit?.searches[0]).toMatchObject({ failure: { category, httpStatus } });
    expect(JSON.stringify(result)).not.toContain('DO_NOT_RETAIN');
  });

  it('validates status/category ownership, strips extra raw fields and leaves old absence absent', async () => {
    const { result } = await run(reject(new ProviderError('http', secret, 503)));
    const audit = result.caseRecord.coverage.topicCandidateAudit; if (!audit) throw new Error('Missing audit');
    const withFailure = (failure: unknown) => ({ ...result.caseRecord, coverage: { ...result.caseRecord.coverage, topicCandidateAudit: { ...audit, searches: audit.searches.map((search, index) => index ? search : { ...search, failure }) } } });
    const parsed = parseCaseRecord(withFailure({ category: 'http', httpStatus: 503, message: secret, cause: { api_key: 'DO_NOT_RETAIN' }, url: secret }));
    expect(parsed).toEqual(result.caseRecord);
    expect(JSON.stringify(parsed)).not.toContain('DO_NOT_RETAIN');
    for (const failure of [null, {}, { category: 'arbitrary', httpStatus: null }, { category: 'http', httpStatus: null }, { category: 'http', httpStatus: 99 }, { category: 'http', httpStatus: 600 }, { category: 'http', httpStatus: 429.5 }, { category: 'http', httpStatus: '429' }, { category: 'timeout', httpStatus: 429 }]) {
      expect(() => parseCaseRecord(withFailure(failure))).toThrow();
    }
    const succeeded = { ...result.caseRecord, coverage: { ...result.caseRecord.coverage, topicCandidateAudit: { ...audit, searches: audit.searches.map((search, index) => index === 1 ? { ...search, failure: { category: 'timeout', httpStatus: null } } : search) } } };
    expect(() => parseCaseRecord(succeeded)).toThrow();
    const legacy = structuredClone(result.caseRecord);
    // A pre-addition unavailable row lacks a diagnosis; do not infer its cause.
    if (legacy.coverage.topicCandidateAudit) legacy.coverage.topicCandidateAudit.searches = legacy.coverage.topicCandidateAudit.searches.map(({ searchIndex, outcome, normalizedCount, droppedBeforeNormalizationCount, duplicateCount }) => outcome === 'unavailable'
      ? { searchIndex, outcome, normalizedCount: null, droppedBeforeNormalizationCount: null, duplicateCount: null }
      : { searchIndex, outcome, normalizedCount, droppedBeforeNormalizationCount, duplicateCount });
    expect(parseCaseRecord(legacy).coverage.topicCandidateAudit?.searches[0]).not.toHaveProperty('failure');
  });

  it('never copies a corrupted typed error kind into the archive', async () => {
    const error = new ProviderError('network', secret);
    Object.defineProperty(error, 'kind', { value: secret });
    const { result } = await run(reject(error));
    expect(result.caseRecord.coverage.topicCandidateAudit?.searches[0]).toMatchObject({ failure: { category: 'unknown', httpStatus: null } });
    expect(JSON.stringify(result)).not.toContain('DO_NOT_RETAIN');
  });

  it('preserves original diagnostics through disk replay/correction/revert and byte-exact legacy reads', async () => {
    const { result } = await run(reject(new ProviderError('timeout', secret)));
    const folder = await mkdtemp(join(tmpdir(), 'ct-search-diagnostics-')); folders.push(folder);
    const service = localResearchService(folder);
    const request = { kind: 'import_case', operationId: 'save-failure', question: topic, createdAt: result.caseRecord.createdAt, caseRecord: result.caseRecord, claimReport: result.claimReport };
    const saved = await service.apply(request); expect((await service.apply(request)).document.revision).toBe(saved.document.revision);
    const differentCoverage = structuredClone(saved.document);
    const current = differentCoverage.workspace.collection.cases.find(record => record.id === result.caseRecord.id);
    if (!current?.coverage.topicCandidateAudit) throw new Error('Missing current audit');
    current.coverage.topicCandidateAudit.searches[0] = { searchIndex: 0, outcome: 'unavailable', normalizedCount: null, droppedBeforeNormalizationCount: null, duplicateCount: null, failure: { category: 'http', httpStatus: 429 } };
    const coverageOnly = parseResearchCaseView(reviewResearch(differentCoverage));
    expect(coverageOnly.reportStatus).toBe('current');
    expect(coverageOnly.caseRecord.coverage.topicCandidateAudit?.searches[0]).toMatchObject({ failure: { category: 'http', httpStatus: 429 } });
    expect(coverageOnly.claimReportCase?.coverage.topicCandidateAudit).toEqual(result.caseRecord.coverage.topicCandidateAudit);
    const reopened = parseResearchCaseView(await service.get(result.caseRecord.id));
    expect(reopened.claimReportCase?.coverage.topicCandidateAudit).toEqual(result.caseRecord.coverage.topicCandidateAudit);
    const evidence = reopened.caseRecord.evidence[0]; if (!evidence) throw new Error('Missing source');
    const corrected = await service.apply({ kind: 'update', caseId: result.caseRecord.id, operationId: 'correct', expectedRevision: reopened.revision, change: { kind: 'evidence', value: { ...evidence, sourceUrl: 'https://corrected.example/report' }, assets: [] } });
    expect(parseResearchCaseView(corrected).reportStatus).toBe('stale');
    expect(corrected.document.claimReportCase?.coverage.topicCandidateAudit).toEqual(result.caseRecord.coverage.topicCandidateAudit);
    const reverted = await service.apply({ kind: 'update', caseId: result.caseRecord.id, operationId: 'revert', expectedRevision: corrected.document.revision, change: { kind: 'evidence', value: evidence, assets: [] } });
    expect(parseResearchCaseView(reverted).reportStatus).toBe('stale');
    expect(reverted.document.claimReportCase?.coverage.topicCandidateAudit).toEqual(result.caseRecord.coverage.topicCandidateAudit);
    const file = join(folder, `${createHash('sha256').update(result.caseRecord.id).digest('hex')}.json`);
    const bytes = await readFile(file, 'utf8');
    expect(bytes).not.toContain('DO_NOT_RETAIN');
    const legacyResult = await run(reject(new Error('old unknown failure')));
    const record = legacyResult.result.caseRecord;
    if (record.coverage.topicCandidateAudit) record.coverage.topicCandidateAudit.searches = record.coverage.topicCandidateAudit.searches.map(({ searchIndex, outcome, normalizedCount, droppedBeforeNormalizationCount, duplicateCount }) => outcome === 'unavailable'
      ? { searchIndex, outcome, normalizedCount: null, droppedBeforeNormalizationCount: null, duplicateCount: null }
      : { searchIndex, outcome, normalizedCount, droppedBeforeNormalizationCount, duplicateCount });
    await service.apply({ kind: 'import_case', operationId: 'old-save', question: topic, createdAt: record.createdAt, caseRecord: record, claimReport: legacyResult.result.claimReport });
    const legacyFile = join(folder, `${createHash('sha256').update(record.id).digest('hex')}.json`);
    const before = await readFile(legacyFile, 'utf8');
    await service.list(); const old = parseResearchCaseView(await service.get(record.id));
    expect(old.claimReportCase?.coverage.topicCandidateAudit?.searches[0]).not.toHaveProperty('failure');
    expect(await readFile(legacyFile, 'utf8')).toBe(before); expect(before).not.toContain('"failure"');
  });
});
