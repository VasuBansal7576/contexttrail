import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { investigateTopic } from './automatic';
import { parseAutomaticResearchResult } from './automatic-client';
import { parseResearchCaseView } from './client';
import { localResearchService } from './service';
import { parseCaseRecord } from '../cases/parse';
import { inquiryCase } from './workflow';
import { JevClient } from '../jev/client';
import type { AutomaticResearchDeps } from './automatic';

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))); });
const topic = 'What changed in the reef recovery programme?';
async function run(count = 12, failFirst = false, rejectedRead = false) {
  let attempt = 0;
  const search = vi.fn(async () => {
    const index = attempt++;
    if (index === 0 && failFirst) throw new Error('Controlled provider failure');
    const rows = Array.from({ length: count }, (_, rank) => ({ position: rank + 1, link: `https://surface-${index}.example/source?id=${rank}`, title: 'Reef recovery programme context', snippet: 'Synthetic retained lead.' }));
    rows.push({ position: count + 1, link: `https://surface-${index}.example/source?id=${count - 1}#duplicate`, title: 'Duplicate title', snippet: 'Synthetic duplicate.' });
    const unsafe = [{ link: 'https://private.example/source?access_token=synthetic' }, { link: 'http://127.1/private' }, { link: 'https://user:secret@credential.example/source' }];
    return { search_metadata: { status: 'Success', id: `search-${index}` }, [index === 1 ? 'news_results' : 'organic_results']: [...rows, ...unsafe, { link: 'javascript:invalid' }, { title: 'No URL' }] };
  });
  const fetchPage = vi.fn(async (url: string) => ({ url: rejectedRead ? url.replace('id=', 'different=') : url, html: '<html><body></body></html>' }));
  const requests = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({ model: 'jev-1.13.0', answers: { relevance: { type: 'noul', noul: .9 } } }));
  const deps: AutomaticResearchDeps = { serpapi: { search, uploadImage: vi.fn(async () => 'unused') }, fetchPage, jev: new JevClient({ apiKey: 'offline-only', fetchImpl: requests }), now: () => Date.parse('2026-10-03T00:00:00Z') };
  return { result: await investigateTopic(topic, () => {}, deps), search, fetchPage, requests };
}

describe('future-only bounded topic candidate references', () => {
  it('captures safe omitted identities without promoting them to evidence or retaining provider text', async () => {
    const { result, search, fetchPage, requests } = await run();
    const audit = result.caseRecord.coverage.topicCandidateAudit;
    expect(audit).toMatchObject({ schemaVersion: 'contexttrail-topic-candidate-audit-v1', uniqueNormalizedCount: 39, safeReferenceCount: 36, withheldReferenceCount: 3, retainedCount: 8, notRetainedCount: 28, uncapturedSafeReferenceCount: 0 });
    expect(audit?.references).toHaveLength(36);
    expect(audit?.searches).toEqual([0, 1, 2].map(searchIndex => ({ searchIndex, outcome: 'succeeded', normalizedCount: 16, droppedBeforeNormalizationCount: 2, duplicateCount: searchIndex === 0 ? 1 : 4 })));
    expect(audit?.references.slice(0, 8).map(row => row.candidateId)).toEqual(result.caseRecord.evidence.map(item => item.id));
    expect(audit?.references.slice(8).every(row => row.disposition === 'not_retained')).toBe(true);
    expect(audit?.references.some(row => row.sourceUrl === 'https://surface-0.example/source?id=11')).toBe(true);
    expect(result.caseRecord.evidence).toHaveLength(8);
    expect(result.caseRecord.coverage.omittedEvidenceCount).toBe(31);
    expect(JSON.stringify(audit)).not.toMatch(/Synthetic|Duplicate title|access_token|secret|127\.0\.0\.1|authority|official/);
    expect(search).toHaveBeenCalledTimes(3); expect(fetchPage).toHaveBeenCalledTimes(5);
    expect(requests).toHaveBeenCalledTimes(8);
    const questions = requests.mock.calls.reduce((total, [, init]) => {
      const body: unknown = JSON.parse(String(init?.body));
      if (!body || typeof body !== 'object' || !('questions' in body) || !body.questions || typeof body.questions !== 'object') throw new Error('Missing bounded questions');
      return total + Object.keys(body.questions).length;
    }, 0);
    expect(questions).toBe(40);
    expect(result.claimReport?.sources.every(source => source.relation === 'insufficient')).toBe(true);
  });

  it('distinguishes measured empty successful surfaces from unavailable search counts', async () => {
    const result = await investigateTopic(topic, () => {}, { serpapi: { search: async params => ({ [params.engine === 'google_news' ? 'news_results' : 'organic_results']: [] }), uploadImage: async () => 'unused' }, jev: null, fetchPage: async () => { throw new Error('No reads allowed'); } });
    expect(result.caseRecord.coverage.topicCandidateAudit).toMatchObject({ uniqueNormalizedCount: 0, safeReferenceCount: 0, retainedCount: 0, references: [] });
    expect(result.caseRecord.coverage.topicCandidateAudit?.searches).toEqual([0, 1, 2].map(searchIndex => ({ searchIndex, outcome: 'succeeded', normalizedCount: 0, droppedBeforeNormalizationCount: 0, duplicateCount: 0 })));
  });

  it('binds selected audit rows to the original requested lead when fetched query resources differ', async () => {
    const { result } = await run(12, false, true);
    expect(result.caseRecord.coverage.sourceReads?.filter(read => read.outcome === 'binding_rejected')).toHaveLength(5);
    expect(result.caseRecord.coverage.topicCandidateAudit?.references.every(row => !row.sourceUrl.includes('different='))).toBe(true);
    expect(parseCaseRecord(result.caseRecord)).toEqual(result.caseRecord);
    // Coverage describes the past retrieval even if a current source is removed.
    const withoutEvidence = { ...result.caseRecord, evidence: [] };
    expect(parseCaseRecord(withoutEvidence).coverage.topicCandidateAudit).toEqual(result.caseRecord.coverage.topicCandidateAudit);
  });

  it('never backfills legacy archives and keeps read/list bytes unchanged', async () => {
    const { result } = await run();
    delete result.caseRecord.coverage.topicCandidateAudit;
    const folder = await mkdtemp(join(tmpdir(), 'ct-topic-legacy-')); folders.push(folder);
    const service = localResearchService(folder);
    await service.apply({ kind: 'import_case', operationId: 'legacy-save', question: topic, createdAt: result.caseRecord.createdAt, caseRecord: result.caseRecord, claimReport: result.claimReport });
    const file = join(folder, `${createHash('sha256').update(result.caseRecord.id).digest('hex')}.json`);
    const before = await readFile(file, 'utf8');
    const reopened = parseResearchCaseView(await service.get(result.caseRecord.id));
    expect(reopened.claimReportCase?.coverage).not.toHaveProperty('topicCandidateAudit');
    await service.list(); await service.get(result.caseRecord.id);
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(before).not.toContain('topicCandidateAudit');
  });

  it('captures every selected reference before truncating the remaining safe pool at100', async () => {
    const { result } = await run(110);
    const audit = result.caseRecord.coverage.topicCandidateAudit;
    expect(audit).toMatchObject({ uniqueNormalizedCount: 333, safeReferenceCount: 330, retainedCount: 8, notRetainedCount: 322, uncapturedSafeReferenceCount: 230 });
    expect(audit?.references).toHaveLength(100);
    expect(audit?.references.slice(0, 8).map(row => row.candidateId)).toEqual(result.caseRecord.evidence.map(item => item.id));
    expect(audit?.references.slice(8, 11).map(row => row.sourceUrl)).toEqual(['https://surface-0.example/source?id=3', 'https://surface-0.example/source?id=4', 'https://surface-0.example/source?id=5']);
  });

  it('keeps unavailable search counts unknown rather than treating failures as successful empties', async () => {
    const { result } = await run(12, true);
    expect(result.caseRecord.coverage.topicCandidateAudit?.searches[0]).toEqual({ searchIndex: 0, outcome: 'unavailable', normalizedCount: null, droppedBeforeNormalizationCount: null, duplicateCount: null });
    expect(result.caseRecord.coverage.topicCandidateAudit?.references.every(row => row.searchIndex !== 0)).toBe(true);
  });

  it('preserves audit through live parsing, disk save/reload, retries, corrections and original snapshots', async () => {
    const { result } = await run();
    const view = parseAutomaticResearchResult(result);
    expect(view.caseRecord.coverage.topicCandidateAudit).toBeDefined();
    expect(view.caseRecord.coverage.topicCandidateAudit).toEqual(result.caseRecord.coverage.topicCandidateAudit);
    const folder = await mkdtemp(join(tmpdir(), 'ct-topic-audit-')); folders.push(folder);
    const service = localResearchService(folder);
    const request = { kind: 'import_case' as const, operationId: 'audit-save', question: topic, createdAt: result.caseRecord.createdAt, caseRecord: view.caseRecord, claimReport: view.claimReport };
    const saved = await service.apply(request);
    const again = await service.apply(request);
    expect(again.document.revision).toBe(saved.document.revision);
    const file = join(folder, `${createHash('sha256').update(result.caseRecord.id).digest('hex')}.json`);
    const bytes = await readFile(file, 'utf8');
    const reopened = parseResearchCaseView(await service.get(result.caseRecord.id));
    expect(reopened.claimReportCase?.coverage.topicCandidateAudit).toEqual(result.caseRecord.coverage.topicCandidateAudit);
    const evidence = reopened.caseRecord.evidence[0]; if (!evidence) throw new Error('Missing evidence');
    const changed = await service.apply({ kind: 'update', caseId: result.caseRecord.id, operationId: 'correct-source', expectedRevision: reopened.revision, change: { kind: 'evidence', value: { ...evidence, sourceUrl: 'https://corrected.example/source' }, assets: [] } });
    expect(changed.document.claimReportCase?.coverage.topicCandidateAudit).toEqual(result.caseRecord.coverage.topicCandidateAudit);
    expect(parseResearchCaseView(changed).reportStatus).toBe('stale');
    const reverted = await service.apply({ kind: 'update', caseId: result.caseRecord.id, operationId: 'revert-source', expectedRevision: changed.document.revision, change: { kind: 'evidence', value: evidence, assets: [] } });
    expect(reverted.document.claimReportCase?.coverage.topicCandidateAudit).toEqual(result.caseRecord.coverage.topicCandidateAudit);
    expect(inquiryCase(reverted.document.workspace).coverage.topicCandidateAudit).toEqual(result.caseRecord.coverage.topicCandidateAudit);
    await service.get(result.caseRecord.id); await service.list();
    expect(bytes).toContain('topicCandidateAudit');
  });

  it('leaves absent legacy metadata absent and rejects malformed new audit while stripping extra provider fields', async () => {
    const { result } = await run();
    const legacy = structuredClone(result.caseRecord); delete legacy.coverage.topicCandidateAudit;
    expect(parseCaseRecord(legacy).coverage).not.toHaveProperty('topicCandidateAudit');
    const audit = result.caseRecord.coverage.topicCandidateAudit; expect(audit).toBeDefined();
    if (!audit) throw new Error('Missing audit');
    const extra = { ...result.caseRecord, coverage: { ...result.caseRecord.coverage, topicCandidateAudit: { ...audit, rawProviderResponse: 'secret', references: audit.references.map(row => ({ ...row, snippet: 'arbitrary raw text' })) } } };
    expect(parseCaseRecord(extra)).toEqual(result.caseRecord);
    for (const mutation of [
      { safeReferenceCount: audit.safeReferenceCount + 1 }, { uncapturedSafeReferenceCount: -1 },
      { references: [...audit.references, audit.references[0]] },
      { references: Array.from({ length: 101 }, (_, index) => ({ ...audit.references[0], candidateId: `new-${index}`, sourceUrl: `https://new.example/${index}` })) },
      { searches: audit.searches.map((search, index) => index ? search : { ...search, normalizedCount: 0 }) },
      { references: audit.references.map((row, index) => index ? row : { ...row, candidateId: 'unbound-selected-id' }) },
      { references: audit.references.map((row, index) => index ? row : { ...row, sourceUrl: 'https://different.example/source' }) },
      { references: audit.references.map((row, index) => index ? row : { ...row, sourceUrl: 'http://127.1/private' }) },
      { references: audit.references.map((row, index) => index ? row : { ...row, sourceUrl: 'https://safe.example/?token=secret' }) },
    ]) expect(() => parseCaseRecord({ ...result.caseRecord, coverage: { ...result.caseRecord.coverage, topicCandidateAudit: { ...audit, ...mutation } } })).toThrow();
    expect(() => parseCaseRecord({ ...result.caseRecord, coverage: { ...result.caseRecord.coverage, sourceReads: undefined } })).toThrow();
  });
});
