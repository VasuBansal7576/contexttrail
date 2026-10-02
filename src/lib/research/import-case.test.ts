import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { localResearchService } from './service';
import { inquiryCase, researchWorkflow } from './workflow';
import { parseResearchCaseView } from './client';
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
const start = { kind: 'start', operationId: 'source', question: 'What happened?', createdAt: '2026-10-01T00:00:00Z' };
function request() {
  const caseRecord = inquiryCase(researchWorkflow(start).document.workspace);
  return { kind: 'import_case', operationId: 'import-one', question: 'What does the evidence show?', createdAt: caseRecord.createdAt, caseRecord };
}
it('imports the exact case, reopens from disk and retries after later edits without losing them', async () => {
  const d = await mkdtemp(join(tmpdir(), 'ct-import-')); dirs.push(d);
  const service = localResearchService(d), input = request();
  const result = await service.apply(input), id = result.document.workspace.inquiry.caseId;
  expect(parseResearchCaseView(result).caseRecord).toEqual(input.caseRecord);
  expect(await localResearchService(d).get(id)).toEqual(result);
  const updated = await service.apply({ kind: 'update', caseId: id, operationId: 'edit', expectedRevision: 1, change: { kind: 'subquestion', value: { kind: 'subquestion', id: 'q2', question: 'What is still unknown?' } } });
  expect(await localResearchService(d).apply(input)).toEqual(updated);
  await expect(service.apply({ ...input, caseRecord: { ...input.caseRecord, revision: 2 } })).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
  await expect(service.apply({ ...input, question: 'Changed?' })).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
});
it('rejects cross-kind operation reuse and malformed cases before saving', async () => {
  const d = await mkdtemp(join(tmpdir(), 'ct-import-')); dirs.push(d);
  const service = localResearchService(d); await service.apply(start);
  const input = request();
  await expect(service.apply({ ...input, operationId: start.operationId, question: start.question })).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
  await expect(service.apply({ ...input, caseRecord: {} })).rejects.toThrow();
  expect((await service.list()).cases).toHaveLength(1);
});
