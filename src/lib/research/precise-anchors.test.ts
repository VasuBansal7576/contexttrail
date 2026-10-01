import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import fixture from '../../../scripts/fixtures/precise-anchors/synthetic.json';
import type { CaseEvidence, MediaAsset, Provenance } from '../cases/model';
import type { ExactAnchor, Finding } from '../inquiries/model';
import { WORKSPACE_VERSION_V2 } from '../inquiries/model';
import { parseWorkspace } from '../inquiries/parse';
import { applyInquiry } from '../inquiries/workspace';
import type { MaterialInput } from '../inquiries/materials';
import { localResearchService } from './service';
import { inquiryCase, parseResearchDocument, type ResearchChange, type ResearchReview } from './workflow';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const provenance: Provenance = { method: 'user_submission', toolVersion: null, capturedAt: '2026-10-01T00:00:00Z', retrievedAt: null, rights: 'user_provided', retention: 'reference_only', contentHash: null };
function evidence(id: string, image = false): CaseEvidence { return { id, sourceUrl: `https://synthetic.example/${id}`, title: `Synthetic ${id}`, content: image ? { kind: 'media', assetId: 'image-asset', span: { kind: 'whole' } } : { kind: 'reference' }, publicationDate: { status: 'unknown', reason: 'Synthetic fixture' }, provenance }; }
const asset: MediaAsset = { id: 'image-asset', kind: 'image', location: { kind: 'not_retained' }, provenance };
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'contexttrail-anchor-')); directories.push(directory);
  const service = localResearchService(directory);
  let report = await service.apply({ kind: 'start', operationId: 'start', question: 'What does the supplied material record?', createdAt: '2026-10-01T00:00:00Z' });
  const caseId = report.document.workspace.inquiry.caseId, questionId = report.document.workspace.inquiry.id;
  const path = join(directory, `${createHash('sha256').update(caseId).digest('hex')}.json`);
  async function update(change: ResearchChange, operationId = `op-${report.document.revision}`) {
    const request = { kind: 'update', caseId, operationId, expectedRevision: report.document.revision, change };
    report = await service.apply(request); return { report, request };
  }
  const material = (id: 'image' | 'table', revision = 1, content?: MaterialInput['content']): MaterialInput => {
    const source = report.anchorSources.find(s => s.evidenceId === id);
    if (!source) throw new Error('Fixture missing source');
    return { materialId: id, revision, evidenceId: id, evidenceDigest: source.evidenceDigest, capturedAt: '2026-10-01T00:00:00Z', rights: 'user_provided', content: content ?? (id === 'image' ? { kind: 'image', mimeType: 'image/png', base64: fixture.image.base64 } : { ...fixture.table, kind: 'table' }) };
  };
  const anchor = (id: 'image' | 'table'): ExactAnchor => {
    const w = report.document.workspace;
    if (w.schemaVersion !== WORKSPACE_VERSION_V2) throw new Error('Fixture is not v2');
    const h = w.materials.heads.find(h => h.materialId === id);
    if (!h || h.status !== 'available') throw new Error('Missing fixture material');
    return id === 'image' ? { kind: 'image_region', materialId: id, materialDigest: h.digest, x: 2, y: 1, width: 6, height: 5 } : { kind: 'table_cell', materialId: id, materialDigest: h.digest, row: 1, column: 1, value: '18' };
  };
  const finding = (id: 'image' | 'table', selected = anchor(id)): Finding => ({ kind: 'finding', id: `finding-${id}`, questionId, text: 'Reviewer recorded this selection.', assessment: { kind: 'operator_inference', reviewer: 'Synthetic reviewer', rationale: 'Supplied selection, with no independent truth or authenticity claim.' }, support: [{ evidenceId: id, relationship: 'context', anchor: selected }] });
  async function retain() {
    await update({ kind: 'evidence', value: evidence('image', true), assets: [asset] });
    await update({ kind: 'evidence', value: evidence('table'), assets: [] });
    for (const id of ['image', 'table'] as const) await update({ kind: 'material', value: { kind: 'retain', material: material(id) } });
  }
  return { directory, service, caseId, path, update, material, anchor, finding, retain, current: () => report };
}
function view(report: ResearchReview, id: string) { const v = report.findings.find(f => f.finding.id === `finding-${id}`); if (!v) throw new Error('Missing finding'); return v; }

describe('precise anchors through persisted research workflow', () => {
  it('opens v1 byte-for-byte, upgrades only on material intake, and preserves CaseRecord v1', async () => {
    const t = await setup();
    const before = await readFile(t.path, 'utf8');
    expect((await t.service.get(t.caseId)).document.schemaVersion).toBe('contexttrail-research-v1');
    expect(await readFile(t.path, 'utf8')).toBe(before);
    await t.update({ kind: 'evidence', value: evidence('image', true), assets: [asset] });
    const caseBefore = inquiryCase(t.current().document.workspace);
    expect(t.current().document.schemaVersion).toBe('contexttrail-research-v1');
    await t.update({ kind: 'material', value: { kind: 'retain', material: t.material('image') } });
    expect(t.current().document.schemaVersion).toBe('contexttrail-research-v2');
    expect(inquiryCase(t.current().document.workspace)).toEqual(caseBefore);
    expect(parseResearchDocument(JSON.parse(await readFile(t.path, 'utf8')))).toEqual(t.current().document);
    const v2 = t.current().document;
    expect(() => parseResearchDocument({ ...v2, schemaVersion: 'contexttrail-research-v1' })).toThrow('versions do not match');
    expect(() => parseWorkspace({ ...v2.workspace, schemaVersion: 'contexttrail-inquiry-v1' })).toThrow('require inquiry v2');
  });
  it('persists exact image regions and literal table cells with source context across reopen', async () => {
    const t = await setup(); await t.retain();
    for (const id of ['image', 'table'] as const) await t.update({ kind: 'finding', value: t.finding(id) });
    const reopened = await localResearchService(t.directory).get(t.caseId);
    expect(reopened).toEqual(t.current());
    expect(JSON.stringify(reopened).split(fixture.image.base64)).toHaveLength(2); // Payload appears once despite repeated references.
    const stored = reopened.document.workspace;
    if (stored.schemaVersion !== WORKSPACE_VERSION_V2) throw new Error('Expected v2');
    expect(stored.materials.versions.find(m => m.materialId === 'table')?.content).toEqual(fixture.table);
    expect(reopened.findings.map(f => f.reviewStatus)).toEqual(['current', 'current']);
    const selection = view(reopened, 'table').support[0];
    expect(selection).toMatchObject({ retainedMaterial: { content: { kind: 'table', rowCount: 3, columnCount: 2 } }, currentMaterial: { content: { kind: 'table', rowCount: 3, columnCount: 2 } } });
    expect(view(reopened, 'image').support[0]).toMatchObject({ retainedMaterial: { content: { width: 8, height: 6 } } });
    expect(view(reopened, 'image').limitation).toContain('authenticity');
    const tableAnchor = t.anchor('table');
    if (tableAnchor.kind !== 'table_cell') throw new Error('Expected table cell');
    await t.update({ kind: 'finding', value: { ...t.finding('table', { ...tableAnchor, row: 2, column: 0, value: '' }), id: 'empty-cell' } });
    expect(t.current().findings.find(f => f.finding.id === 'empty-cell')?.reviewStatus).toBe('current');
  });
  it('rejects out-of-bounds, fractional, overflowing and wrong-content anchors without a write', async () => {
    const t = await setup(); await t.retain(); const before = await readFile(t.path, 'utf8');
    const image = t.anchor('image'), table = t.anchor('table');
    const badAnchors = [
      { ...image, x: -1 }, { ...image, y: 6 }, { ...image, width: 7 }, { ...image, width: 0 }, { ...image, height: 1.5 }, { ...image, x: Number.MAX_SAFE_INTEGER, width: 2 },
      { ...table, row: 3 }, { ...table, column: 2 }, { ...table, row: -1 }, { ...table, value: '18 ' }, { ...table, materialDigest: `sha256:${'0'.repeat(64)}` }, { ...image, materialId: 'absent' },
    ];
    for (const [i, anchor] of badAnchors.entries()) await expect(t.service.apply({ kind: 'update', caseId: t.caseId, operationId: `bad-${i}`, expectedRevision: t.current().document.revision, change: { kind: 'finding', value: { ...t.finding('image'), support: [{ evidenceId: anchor.kind === 'image_region' ? 'image' : 'table', relationship: 'context', anchor }] } } })).rejects.toThrow();
    expect(await readFile(t.path, 'utf8')).toBe(before);
  });
  it('stales support on same-dimension replacement, preserves original bytes, and requires review on revert', async () => {
    const t = await setup(); await t.retain(); const original = t.finding('image');
    await t.update({ kind: 'finding', value: original });
    await t.update({ kind: 'material', value: { kind: 'retain', material: t.material('image', 2, { kind: 'image', mimeType: 'image/png', base64: fixture.replacement.base64 }) } });
    expect(view(t.current(), 'image')).toMatchObject({ reviewStatus: 'needs_review', support: [{ status: 'changed', retainedMaterial: { revision: 1 }, currentMaterial: { revision: 2 } }] });
    await t.update({ kind: 'finding', value: original });
    expect(view(t.current(), 'image').reviewStatus).toBe('needs_review');
    await t.update({ kind: 'material', value: { kind: 'retain', material: t.material('image', 3) } });
    expect(view(t.current(), 'image').reviewStatus).toBe('needs_review');
    await expect(t.update({ kind: 'finding', value: t.finding('image') })).rejects.toThrow('changed review rationale');
    const reviewed = t.finding('image'); reviewed.assessment.rationale = 'Reviewed the newly retained revision, without assessing authenticity.';
    await t.update({ kind: 'finding', value: reviewed });
    expect(view(t.current(), 'image').reviewStatus).toBe('current');
    expect(await localResearchService(t.directory).get(t.caseId)).toEqual(t.current());
  });
  it('stales cells on any table-context correction and refuses binding to changed source', async () => {
    const t = await setup(); await t.retain(); await t.update({ kind: 'finding', value: t.finding('table') });
    const originalMaterial = t.material('table', 2);
    await t.update({ kind: 'evidence', value: { ...evidence('table'), title: 'Corrected source title' }, assets: [] });
    expect(view(t.current(), 'table').support[0].status).toBe('changed');
    await expect(t.update({ kind: 'material', value: { kind: 'retain', material: originalMaterial } })).rejects.toThrow('changed source');
    await expect(t.update({ kind: 'finding', value: { ...t.finding('table'), id: 'new-finding' } })).rejects.toThrow('lacks exact');
    await t.update({ kind: 'material', value: { kind: 'retain', material: t.material('table', 2, { ...fixture.table, kind: 'table', columns: ['Year', 'Reported count'] }) } });
    expect(view(t.current(), 'table').support[0].status).toBe('changed');
    const revised = t.finding('table'); revised.assessment.rationale = 'Reviewed the corrected table context.';
    await t.update({ kind: 'finding', value: revised });
    expect(view(t.current(), 'table').reviewStatus).toBe('current');
  });
  it('keeps source-correction warnings after content is reverted until a new material review', async () => {
    const t = await setup(); await t.retain(); await t.update({ kind: 'finding', value: t.finding('table') });
    await t.update({ kind: 'evidence', value: { ...evidence('table'), title: 'Correction' }, assets: [] });
    await t.update({ kind: 'evidence', value: evidence('table'), assets: [] });
    expect(view(t.current(), 'table').support[0].status).toBe('changed');
    await expect(t.update({ kind: 'material', value: { kind: 'retain', material: t.material('table') } })).rejects.toThrow('next revision');
    await t.update({ kind: 'material', value: { kind: 'retain', material: t.material('table', 2) } });
    expect(view(t.current(), 'table').support[0].status).toBe('changed');
    const finding = t.finding('table'); finding.assessment.rationale = 'Re-reviewed the restored source and new material revision.';
    await t.update({ kind: 'finding', value: finding });
    expect(view(t.current(), 'table').support[0].status).toBe('current');
  });
  it('persists explicit withdrawal and missing-source status without erasing historical material', async () => {
    const t = await setup(); await t.retain(); await t.update({ kind: 'finding', value: t.finding('table') });
    await t.update({ kind: 'material', value: { kind: 'withdraw', materialId: 'table', reason: 'Synthetic withdrawal' } });
    expect(view(await localResearchService(t.directory).get(t.caseId), 'table').support[0]).toMatchObject({ status: 'unavailable', reason: 'Synthetic withdrawal', retainedMaterial: { content: { kind: 'table', rowCount: 3, columnCount: 2 } }, currentMaterial: null });
    await expect(t.update({ kind: 'material', value: { kind: 'retain', material: t.material('table', 1) } })).rejects.toThrow('next revision');
    await t.update({ kind: 'material', value: { kind: 'retain', material: t.material('table', 2) } });
    expect(view(t.current(), 'table').support[0].status).toBe('changed');
    const w = t.current().document.workspace, c = inquiryCase(w);
    const missing = applyInquiry(w, { kind: 'update', operationId: 'remove-source', expectedRevision: w.revision, subquestions: [], hypotheses: [], findings: [], caseUpdates: { watchlists: [], familyLinks: [], updates: [{ kind: 'snapshot', caseRecord: { ...c, revision: c.revision + 1, evidence: c.evidence.filter(e => e.id !== 'table') }, removal: { status: 'confirmed', reason: 'Synthetic withdrawal' } }] } });
    expect(missing.findings[0].support[0].status).toBe('unavailable');
  });
  it('rejects image bytes inconsistent with a declared source asset hash', async () => {
    const t = await setup();
    await t.update({ kind: 'evidence', value: evidence('image', true), assets: [{ ...asset, provenance: { ...provenance, contentHash: fixture.image.contentHash } }] });
    await expect(t.update({ kind: 'material', value: { kind: 'retain', material: t.material('image', 1, { kind: 'image', mimeType: 'image/png', base64: fixture.replacement.base64 }) } })).rejects.toThrow('asset digest');
    await t.update({ kind: 'material', value: { kind: 'retain', material: t.material('image') } });
    expect(t.current().document.workspace.schemaVersion).toBe(WORKSPACE_VERSION_V2);
  });
  it('leaves the saved case unchanged when material history reaches its version cap', async () => {
    const t = await setup();
    await t.update({ kind: 'evidence', value: evidence('table'), assets: [] });
    for (let revision = 1; revision <= 32; revision++) await t.update({ kind: 'material', value: { kind: 'retain', material: t.material('table', revision) } });
    const before = await readFile(t.path, 'utf8');
    await expect(t.update({ kind: 'material', value: { kind: 'retain', material: t.material('table', 33) } })).rejects.toThrow('32 versions or 2 MiB');
    expect(await readFile(t.path, 'utf8')).toBe(before);
    expect(await localResearchService(t.directory).get(t.caseId)).toEqual(t.current());
  });
  it('replays retained material edits without duplicating versions or revisions, including after later edits', async () => {
    const t = await setup();
    await t.update({ kind: 'evidence', value: evidence('image', true), assets: [asset] });
    const first = await t.update({ kind: 'material', value: { kind: 'retain', material: t.material('image') } });
    expect(await t.service.apply(first.request)).toEqual(first.report);
    await t.update({ kind: 'finding', value: t.finding('image') });
    expect(await t.service.apply(first.request)).toEqual(t.current());
    const w = t.current().document.workspace;
    if (w.schemaVersion !== WORKSPACE_VERSION_V2) throw new Error('Expected v2');
    expect(w.materials.versions).toHaveLength(1);
    await expect(t.service.apply({ ...first.request, change: { ...first.request.change, extra: 'different operation payload' } })).rejects.toThrow('Operation ID reused');
  });
});
