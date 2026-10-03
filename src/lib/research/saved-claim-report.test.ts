import { JEV_MODEL } from '../jev/model';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { assessClaimSource, buildClaimReport } from './claim-report';
import { localResearchService } from './service';
import { inquiryCase, researchWorkflow, parseResearchDocument } from './workflow';
import { parseResearchCaseView } from './client';
import type { CaseEvidence } from '../cases/model';
import { selectClaimQuotePassage } from './claim-quote-passage';
import { localizedNavigationQuote, localizedSourceUrl } from './claim-quote-passage-fixture';
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
  expect(view.claimReportCaseOrigin).toBe('retained_snapshot');
});
it('keeps localized chrome display separate from saved quote bytes, inputs and historical assessment', async () => {
  const { dir, service, request } = await setup();
  const evidence = request.caseRecord.evidence[0];
  evidence.sourceUrl = localizedSourceUrl;
  evidence.content = { kind: 'text', text: localizedNavigationQuote, attribution: 'page_quote' };
  request.claimReport = buildClaimReport(request.question, request.caseRecord, [assessClaimSource(evidence, 'The supplied sample is historical.', null)]);
  await service.apply(request);
  const file = join(dir, (await readdir(dir))[0]), bytes = await readFile(file);
  const reopened = parseResearchCaseView(await service.get(request.caseRecord.id));
  const source = reopened.claimReport?.sources[0];
  expect(selectClaimQuotePassage(source?.quote ?? null, reopened.claimReportCase?.evidence[0])).toMatchObject({ kind: 'navigation_only', original: { start: 0, end: 378, text: localizedNavigationQuote } });
  await service.list();
  expect(await readFile(file)).toEqual(bytes);
  expect(reopened.claimReport).toEqual(request.claimReport);
  expect(reopened.claimReportCase).toEqual(request.caseRecord);
  const corrected = await service.apply({ kind: 'update', caseId: request.caseRecord.id, operationId: 'localized-correct', expectedRevision: 1, change: { kind: 'evidence', value: { ...evidence, content: { kind: 'text', text: 'ИСРО остава държавна агенция.', attribution: 'page_quote' } }, assets: [] } });
  const historical = parseResearchCaseView(corrected);
  expect(historical.reportStatus).toBe('stale');
  expect(historical.claimReport).toEqual(request.claimReport);
  expect(selectClaimQuotePassage(historical.claimReport?.sources[0].quote ?? null, historical.claimReportCase?.evidence[0]).kind).toBe('navigation_only');
});
it('keeps missing original coverage provenance sticky through legacy corrections, replay and revert without rewriting reads', async () => {
  const { dir, service, request } = await setup();
  const initial = await service.apply(request), legacy = structuredClone(initial.document);
  delete legacy.claimReportCase; delete legacy.claimReportCaseOrigin;
  const file = join(dir, (await readdir(dir))[0]);
  await writeFile(file, JSON.stringify(legacy));
  const bytes = await readFile(file, 'utf8');
  const reopened = parseResearchCaseView(await service.get(request.caseRecord.id));
  expect(reopened.claimReportCaseOrigin).toBe('legacy_fallback');
  expect(reopened.claimReport).toEqual(request.claimReport);
  await service.list(); expect(await readFile(file, 'utf8')).toBe(bytes);
  const changed = await service.apply({ kind: 'update', caseId: request.caseRecord.id, operationId: 'legacy-correct', expectedRevision: 1, change: { kind: 'evidence', value: { ...request.caseRecord.evidence[0], title: 'Corrected legacy source' }, assets: [] } });
  expect(changed.reportStatus).toBe('stale');
  expect(changed.document.claimReportCaseOrigin).toBe('legacy_fallback');
  expect(changed.document.claimReportCase?.evidence[0].title).toBe('Original source');
  expect((await service.apply(request)).document).toEqual(changed.document);
  const reverted = await service.apply({ kind: 'update', caseId: request.caseRecord.id, operationId: 'legacy-revert', expectedRevision: 2, change: { kind: 'evidence', value: request.caseRecord.evidence[0], assets: [] } });
  const after = parseResearchCaseView(await localResearchService(dir).get(request.caseRecord.id));
  expect(after.reportStatus).toBe('stale');
  expect(after.claimReportCaseOrigin).toBe('legacy_fallback');
  expect(after.claimReport).toEqual(request.claimReport);
  expect(reverted.document.applied[0]).toEqual(legacy.applied[0]);
});
it('rejects malformed, orphan and falsely retained coverage provenance at server and browser boundaries', () => {
  const original = researchWorkflow(input());
  const { claimReportCase: _snapshot, ...withoutSnapshot } = original.document;
  const noReport = researchWorkflow({ kind: 'start', operationId: 'empty', question: 'What changed?', createdAt: '2026-10-01T00:00:00Z' });
  const malformed = [
    { ...original.document, claimReportCaseOrigin: 'invented' },
    { ...original.document, claimReportCaseOrigin: null },
    { ...withoutSnapshot, claimReportCaseOrigin: 'retained_snapshot' },
    { ...original.document, claimReportCase: null },
    { ...noReport.document, claimReportCaseOrigin: 'legacy_fallback' },
  ];
  for (const document of malformed) {
    expect(() => parseResearchDocument(document)).toThrow();
    expect(() => parseResearchCaseView({ ...original, document })).toThrow();
  }
});
it('treats a historical null snapshot like absent original coverage while retaining fallback evidence', () => {
  const original = researchWorkflow(input());
  const { claimReportCaseOrigin: _origin, ...legacy } = original.document;
  const read = researchWorkflow({ kind: 'read', document: { ...legacy, claimReportCase: null } });
  expect(read.document.claimReportCaseOrigin).toBe('legacy_fallback');
  expect(parseResearchCaseView(read).claimReportCaseOrigin).toBe('legacy_fallback');
  expect(read.document.claimReport).toEqual(original.document.claimReport);
  expect(read.document.claimReportCase).toEqual(original.document.claimReportCase);
});
it('preserves legacy coverage absence through retained material changes', async () => {
  const { dir, service, request } = await setup();
  request.caseRecord.evidence[0].content = { kind: 'reference' };
  request.claimReport = buildClaimReport(request.question, request.caseRecord, [assessClaimSource(request.caseRecord.evidence[0], 'The supplied sample is historical.', null)]);
  const initial = await service.apply(request), legacy = structuredClone(initial.document);
  delete legacy.claimReportCase; delete legacy.claimReportCaseOrigin;
  await writeFile(join(dir, (await readdir(dir))[0]), JSON.stringify(legacy));
  const updated = await service.apply({ kind: 'update', caseId: request.caseRecord.id, operationId: 'legacy-material', expectedRevision: 1, change: { kind: 'material', value: { kind: 'retain', material: { materialId: 'legacy-table', revision: 1, evidenceId: 'source-one', evidenceDigest: initial.anchorSources[0].evidenceDigest, capturedAt: request.createdAt, rights: 'user_provided', content: { kind: 'table', columns: ['Year'], rows: [['2026']] } } } } });
  expect(updated.reportStatus).toBe('stale');
  expect(parseResearchCaseView(await service.get(request.caseRecord.id)).claimReportCaseOrigin).toBe('legacy_fallback');
  expect(updated.document.claimReport).toEqual(request.claimReport);
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
