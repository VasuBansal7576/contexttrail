import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CaseEvidence, MediaAsset, Provenance } from '../cases/model';
import type { Finding } from '../inquiries/model';
import { localResearchService } from './service';
import { inquiryCase, type ResearchChange } from './workflow';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const provenance: Provenance = { method: 'manual', toolVersion: null, capturedAt: '2026-10-01T00:00:00.000Z', retrievedAt: null, rights: 'user_provided', retention: 'reference_only', contentHash: null };
function evidence(id: string, text = 'The bridge opened on Monday. Further inspection is pending.'): CaseEvidence {
  return { id, sourceUrl: `https://synthetic.example/${id}`, title: id, content: { kind: 'text', text, attribution: 'page_quote' }, publicationDate: { status: 'unknown', reason: 'No publication date supplied' }, provenance };
}
const start = { kind: 'start', operationId: 'create-bridge', question: 'When did the bridge open?', createdAt: '2026-10-01T00:00:00.000Z' };
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'contexttrail-research-'));
  directories.push(directory);
  const service = localResearchService(directory), result = await service.apply(start);
  return { directory, service, result, id: result.document.workspace.inquiry.caseId };
}
function finding(questionId: string): Finding {
  return { kind: 'finding', id: 'finding-a', questionId, text: 'The supplied source says Monday.', assessment: { kind: 'source_statement', reviewer: 'Fixture reviewer', rationale: 'Exact wording retained; the event date remains unverified.' }, support: [{ evidenceId: 'a', relationship: 'context', anchor: { kind: 'text', start: 0, quote: 'The bridge opened on Monday.' } }] };
}

describe('local research application service', () => {
  it('persists questions, subquestions, hypotheses, exact findings and citations across new service instances', async () => {
    const { directory, service, id, result } = await setup();
    let revision = 1;
    const questionId = result.document.workspace.inquiry.id;
    async function update(change: ResearchChange) {
      const next = await service.apply({ kind: 'update', caseId: id, expectedRevision: revision, operationId: `op-${revision}`, change });
      revision = next.document.revision;
      return next;
    }
    await update({ kind: 'subquestion', value: { kind: 'subquestion', id: 'q2', question: 'Was an inspection complete?' } });
    await update({ kind: 'hypothesis', value: { kind: 'hypothesis', id: 'h1', questionId: 'q2', explanation: 'Opening and inspection might be separate milestones.' } });
    await update({ kind: 'evidence', value: evidence('a'), assets: [] });
    await update({ kind: 'evidence', value: evidence('b'), assets: [] });
    await update({ kind: 'finding', value: finding(questionId) });
    for (const fromEvidenceId of ['a', 'b']) await update({ kind: 'citation', value: { id: `citation-${fromEvidenceId}`, fromEvidenceId, targetUrl: 'https://synthetic.example/a', targetRole: 'primary', claimId: null, quote: { text: 'The bridge opened on Monday.', start: 0 } } });
    const reopened = await localResearchService(directory).get(id);
    expect(reopened.document.revision).toBe(8);
    expect(reopened.document.workspace.subquestions).toHaveLength(1);
    expect(reopened.document.workspace.hypotheses).toHaveLength(1);
    expect(inquiryCase(reopened.document.workspace).claims).toEqual([]);
    expect(reopened.findings[0].support[0].status).toBe('current');
    expect(reopened.dependencies.sharedCitations).toHaveLength(1);
    expect(reopened.dependencies.duplicatePassages).toHaveLength(1);
    expect(reopened.dependencies.independence.status).toBe('unknown');
    expect(reopened.dependencies.citationChecks[0].entailment.status).toBe('unknown');
    expect(await service.list()).toEqual([{ caseId: id, question: start.question, revision: 8, createdAt: start.createdAt }]);
    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    expect(JSON.parse(await readFile(join(directory, files[0]), 'utf8'))).toEqual(reopened.document);
  });

  it('makes retried creation and update operations idempotent even after later changes', async () => {
    const { service, id } = await setup();
    const request = { kind: 'update', caseId: id, expectedRevision: 1, operationId: 'same-operation', change: { kind: 'evidence', value: evidence('a'), assets: [] } };
    const once = await service.apply(request);
    expect(await service.apply(request)).toEqual(once);
    await service.apply({ ...request, expectedRevision: 2, operationId: 'later-operation', change: { kind: 'evidence', value: evidence('b'), assets: [] } });
    expect((await service.apply(request)).document.revision).toBe(3);
    expect((await service.apply(start)).document.revision).toBe(3);
    await expect(service.apply({ ...start, question: 'Different question' })).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    await expect(service.apply({ ...request, change: { kind: 'evidence', value: evidence('c'), assets: [] } })).rejects.toThrow('Operation ID reused');
    await expect(service.apply({ ...request, operationId: start.operationId, expectedRevision: 3, change: { kind: 'citation', value: { id: 'c1', fromEvidenceId: 'a', targetUrl: 'https://synthetic.example/a', targetRole: 'primary', claimId: null, quote: null } } })).rejects.toThrow('Operation ID reused');
    expect((await service.get(id)).document.revision).toBe(3);
  });

  it('rejects invalid anchors and stale writers without changing persisted bytes', async () => {
    const { service, id, result, directory } = await setup();
    await service.apply({ kind: 'update', caseId: id, expectedRevision: 1, operationId: 'e1', change: { kind: 'evidence', value: evidence('a'), assets: [] } });
    const file = join(directory, (await readdir(directory))[0]), before = await readFile(file, 'utf8');
    const wrong = finding(result.document.workspace.inquiry.id);
    wrong.support[0].anchor = { kind: 'text', start: 1, quote: 'The bridge opened on Monday.' };
    await expect(service.apply({ kind: 'update', caseId: id, expectedRevision: 2, operationId: 'invalid', change: { kind: 'finding', value: wrong } })).rejects.toThrow('lacks exact evidence');
    await expect(service.apply({ kind: 'update', caseId: id, expectedRevision: 1, operationId: 'stale', change: { kind: 'evidence', value: evidence('b'), assets: [] } })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('retains corrections and stale finding bindings across replay and reload', async () => {
    const { service, id, result, directory } = await setup();
    const questionId = result.document.workspace.inquiry.id;
    await service.apply({ kind: 'update', caseId: id, expectedRevision: 1, operationId: 'e1', change: { kind: 'evidence', value: evidence('a'), assets: [] } });
    const f = finding(questionId);
    await service.apply({ kind: 'update', caseId: id, expectedRevision: 2, operationId: 'f1', change: { kind: 'finding', value: f } });
    await service.apply({ kind: 'update', caseId: id, expectedRevision: 3, operationId: 'citation', change: { kind: 'citation', value: { id: 'c1', fromEvidenceId: 'a', targetUrl: 'https://synthetic.example/a', targetRole: 'unspecified', claimId: null, quote: { text: 'The bridge opened on Monday.', start: 0 } } } });
    const correction = { kind: 'update', caseId: id, expectedRevision: 4, operationId: 'correct', change: { kind: 'evidence', value: evidence('a', 'Correction: the bridge opened on Tuesday.'), assets: [] } };
    await service.apply(correction);
    await service.apply(correction);
    const reopened = await localResearchService(directory).get(id);
    expect(reopened.findings[0].reviewStatus).toBe('needs_review');
    expect(reopened.findings[0].support[0].anchor).toEqual(f.support[0].anchor);
    expect(reopened.dependencies.citationChecks[0].quoteChecks[0].result).toBe('offset_mismatch');
    expect(reopened.dependencies.citationChecks[0].entailment.status).toBe('unknown');
    expect(reopened.document.workspace.collection.caseHistory.some(record => record.evidence.some(e => e.content.kind === 'text' && e.content.text.startsWith('The bridge opened on Monday.')))).toBe(true);
    const unchanged = await service.apply({ kind: 'update', caseId: id, expectedRevision: 5, operationId: 'resubmit', change: { kind: 'finding', value: f } });
    expect(unchanged.findings[0].reviewStatus).toBe('needs_review');
  });

  it('requires timed anchors inside the supplied media span and duration', async () => {
    const { service, id, result } = await setup();
    const asset: MediaAsset = { id: 'clip', kind: 'video', location: { kind: 'not_retained' }, durationMs: 5000, provenance };
    const media: CaseEvidence = { ...evidence('a'), content: { kind: 'media', assetId: 'clip', span: { kind: 'time', startMs: 1000, durationMs: 2000 } } };
    await service.apply({ kind: 'update', caseId: id, expectedRevision: 1, operationId: 'media', change: { kind: 'evidence', value: media, assets: [asset] } });
    const timed = finding(result.document.workspace.inquiry.id);
    timed.support[0].anchor = { kind: 'time', startMs: 1200, durationMs: 500 };
    const saved = await service.apply({ kind: 'update', caseId: id, expectedRevision: 2, operationId: 'valid-span', change: { kind: 'finding', value: timed } });
    expect(saved.findings[0].reviewStatus).toBe('current');
    timed.id = 'out-of-span'; timed.support[0].anchor = { kind: 'time', startMs: 0, durationMs: 500 };
    await expect(service.apply({ kind: 'update', caseId: id, expectedRevision: 3, operationId: 'bad-span', change: { kind: 'finding', value: timed } })).rejects.toThrow('lacks exact evidence');
    expect((await service.get(id)).document.revision).toBe(3);
  });

  it('serializes concurrent writers and preserves interrupted-save artifacts', async () => {
    const { service, id, directory } = await setup();
    const request = { kind: 'update', caseId: id, expectedRevision: 1, operationId: 'a', change: { kind: 'evidence', value: evidence('a'), assets: [] } };
    const results = await Promise.allSettled([service.apply(request), service.apply({ ...request, operationId: 'b' })]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await service.get(id)).document.revision).toBe(2);
    const prefix = join(directory, createHash('sha256').update(id).digest('hex'));
    await writeFile(`${prefix}.tmp`, 'interrupted bytes');
    await expect(service.apply({ ...request, expectedRevision: 2, operationId: 'c' })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect((await service.get(id)).document.revision).toBe(2);
    expect(await readFile(`${prefix}.tmp`, 'utf8')).toBe('interrupted bytes');
    await writeFile(`${prefix}.lock`, 'interrupted writer');
    await expect(service.apply({ ...request, expectedRevision: 2, operationId: 'd' })).rejects.toMatchObject({ code: 'CASE_BUSY' });
    expect((await localResearchService(directory).get(id)).document.revision).toBe(2);
    expect(await readFile(`${prefix}.lock`, 'utf8')).toBe('interrupted writer');
  });

  it('refuses incompatible saved versions without overwriting them', async () => {
    const { service, id, directory } = await setup();
    const path = join(directory, (await readdir(directory))[0]);
    const invalid = '{"schemaVersion":"future-version"}';
    await writeFile(path, invalid);
    await expect(service.get(id)).rejects.toThrow('Unsupported research version');
    await expect(service.apply({ ...start })).rejects.toThrow('Unsupported research version');
    expect(await readFile(path, 'utf8')).toBe(invalid);
  });
});
