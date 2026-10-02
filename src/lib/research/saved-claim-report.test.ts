import { JEV_MODEL } from '../jev/model';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { assessClaimSource, buildClaimReport } from './claim-report';
import { localResearchService } from './service';
import { inquiryCase, researchWorkflow } from './workflow';
import { parseResearchCaseView } from './client';
import type { CaseEvidence } from '../cases/model';
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
function input() {
  const question = 'Claim: The supplied sample is historical.';
  const caseRecord = inquiryCase(researchWorkflow({ kind: 'start', operationId: 'source', question, createdAt: '2026-10-01T00:00:00Z' }).document.workspace);
  const evidence: CaseEvidence = { id: 'source-one', sourceUrl: 'https://example.com/source', title: 'Original source', content: { kind: 'text', text: 'A historical sample was retained.', attribution: 'page_quote' }, publicationDate: { status: 'unknown', reason: 'Synthetic test' }, provenance: { method: 'user_submission', toolVersion: null, capturedAt: '2026-10-01T00:00:00Z', retrievedAt: null, rights: 'user_provided', retention: 'reference_only', contentHash: null } };
  caseRecord.evidence = [evidence];
  const claimReport = buildClaimReport(question, caseRecord, [assessClaimSource(evidence, 'The supplied sample is historical.', null)]);
  return { kind: 'import_case', operationId: 'save-report', question, caseRecord, createdAt: caseRecord.createdAt, claimReport };
}
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'ct-claim-save-')); dirs.push(dir);
  return { dir, service: localResearchService(dir), request: input() };
}
it('saves and reopens the exact grounded report without changing existing v1 contracts', async () => {
  const { dir, service, request } = await setup();
  const saved = await service.apply(request);
  const reopened = await localResearchService(dir).get(request.caseRecord.id);
  expect(reopened).toEqual(saved);
  const view = parseResearchCaseView(reopened);
  expect(view.reportStatus).toBe('current');
  expect(view.claimReport).toEqual(request.claimReport);
  expect(view.caseRecord).toEqual(request.caseRecord);
  expect(saved.document.schemaVersion).toBe('contexttrail-research-v1');
  expect(view.claimReportCase).toEqual(request.caseRecord);
});
it('keeps historical assessments after evidence correction and repeated import preserves the correction', async () => {
  const { dir, service, request } = await setup();
  await service.apply(request);
  const changed = { ...request.caseRecord.evidence[0], title: 'Corrected source' };
  const updated = await service.apply({ kind: 'update', caseId: request.caseRecord.id, operationId: 'correct', expectedRevision: 1, change: { kind: 'evidence', value: changed, assets: [] } });
  expect(updated.reportStatus).toBe('stale');
  expect(await localResearchService(dir).apply(request)).toEqual(updated);
  const view = parseResearchCaseView(await localResearchService(dir).get(request.caseRecord.id));
  expect(view.reportStatus).toBe('stale');
  expect(view.caseRecord.evidence[0].title).toBe('Corrected source');
  expect(view.claimReportCase?.evidence[0].title).toBe('Original source');
  expect(view.claimReport).toEqual(request.claimReport);
  const reverted = await service.apply({ kind: 'update', caseId: request.caseRecord.id, operationId: 'revert', expectedRevision: 2, change: { kind: 'evidence', value: request.caseRecord.evidence[0], assets: [] } });
  expect(reverted.reportStatus).toBe('stale');
  expect((await localResearchService(dir).apply(request)).document.revision).toBe(3);
  await expect(service.apply({ ...request, claimReport: { ...request.claimReport, limitations: ['Changed output'] } })).rejects.toThrow();
});
it('invalidates after retained material intake without dropping the exact original report', async () => {
  const { dir, service, request } = await setup();
  request.caseRecord.evidence[0].content = { kind: 'reference' };
  request.claimReport = buildClaimReport(request.question, request.caseRecord, [assessClaimSource(request.caseRecord.evidence[0], 'The supplied sample is historical.', null)]);
  const original = await service.apply(request);
  await service.apply({ kind: 'update', caseId: request.caseRecord.id, operationId: 'material', expectedRevision: 1, change: { kind: 'material', value: { kind: 'retain', material: { materialId: 'table', revision: 1, evidenceId: 'source-one', evidenceDigest: original.anchorSources[0].evidenceDigest, capturedAt: request.createdAt, rights: 'user_provided', content: { kind: 'table', columns: ['Year'], rows: [['2026']] } } } } });
  const reopened = parseResearchCaseView(await localResearchService(dir).get(request.caseRecord.id));
  expect(reopened.reportStatus).toBe('stale');
  expect(reopened.claimReport).toEqual(request.claimReport);
  expect(reopened.materials.versions).toHaveLength(1);
});
it('marks persisted claim or question corrections stale on read and preserves provenance', () => {
  const request = input();
  for (const correction of ['claim', 'question']) {
    const saved = researchWorkflow(request).document;
    if (correction === 'question') saved.workspace.inquiry.question = 'What was actually observed?';
    else inquiryCase(saved.workspace).claims.push({ id: 'corrected-claim', kind: 'text', text: 'A corrected narrower claim.', language: 'en', provenance: request.caseRecord.evidence[0].provenance });
    const reopened = parseResearchCaseView(researchWorkflow({ kind: 'read', document: saved }));
    expect(reopened.reportStatus).toBe('stale');
    expect(reopened.claimReport).toEqual(request.claimReport);
  }
});
it('legacy documents remain readable and invalid unbound imports are rejected', () => {
  const request = input();
  const { claimReport, ...legacy } = request;
  expect(parseResearchCaseView(researchWorkflow(legacy)).reportStatus).toBe('none');
  expect(() => researchWorkflow({ ...request, question: 'Different question' })).toThrow();
  expect(() => researchWorkflow({ ...request, claimReport: { ...claimReport, sources: [] } })).toThrow();
});
it('reopens legacy reason-only reports as historical without rewriting bytes, and retains them through edits', async () => {
  const { dir, service, request } = await setup();
  const source = assessClaimSource(request.caseRecord.evidence[0], 'The supplied sample is historical.', {
    model: JEV_MODEL, identity: { requested: JEV_MODEL, reported: JEV_MODEL, status: 'verified', pinned: true }, answers: { relevance: { type: 'noul', noul: 0.1 } },
  });
  request.claimReport = buildClaimReport(request.question, request.caseRecord, [source]);
  request.claimReport.sources[0].reasons.shift();
  const historical = researchWorkflow(request).document;
  const saved = await service.apply(request);
  const file = join(dir, (await readdir(dir))[0]);
  // Exact pre-change storage shape, with no new presentation metadata.
  await writeFile(file, JSON.stringify(historical));
  const originalBytes = await readFile(file, 'utf8');
  expect(saved.reportStatus).toBe('stale');
  expect((await service.list()).cases).toHaveLength(1);
  const reopened = parseResearchCaseView(await localResearchService(dir).get(request.caseRecord.id));
  expect(reopened.reportStatus).toBe('stale');
  expect(reopened.claimReport).toEqual(request.claimReport);
  expect(await readFile(file, 'utf8')).toBe(originalBytes);
  const edited = await service.apply({ kind: 'update', caseId: request.caseRecord.id, operationId: 'add-question', expectedRevision: 1, change: { kind: 'subquestion', value: { kind: 'subquestion', id: 'q2', question: 'What does this source establish?' } } });
  expect(edited.document.claimReport).toEqual(request.claimReport);
  expect(edited.document.applied[0]).toEqual(historical.applied[0]);
  expect(parseResearchCaseView(await localResearchService(dir).get(request.caseRecord.id)).reportStatus).toBe('stale');
});
