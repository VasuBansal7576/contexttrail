/** Synthetic source removal through the supported inquiry snapshot contract. */
import { inquiryCase, researchWorkflow, reviewResearch } from './workflow';
import { applyInquiry } from '../inquiries/workspace';
import type { CaseEvidence } from '../cases/model';
import type { ExactAnchor, Finding } from '../inquiries/model';
export function historicalEvidenceFixture(kind: 'text' | 'image' | 'table', state: 'missing' | 'changed' | 'withdrawn' = 'missing') {
  let report = researchWorkflow({ kind: 'start', operationId: `historical-${kind}-${state}`, question: 'What does the original source record?', createdAt: '2026-10-01T00:00:00Z' });
  function update(change: unknown) { report = researchWorkflow({ kind: 'update', operationId: `edit-${report.document.revision}`, expectedRevision: report.document.revision, document: report.document, change }); }
  const evidence: CaseEvidence = { id: 'original-source', title: `Synthetic original ${kind}`, sourceUrl: 'https://example.com/historical-source', content: kind === 'text' ? { kind: 'text', text: 'Before the exact saved quote after.', attribution: 'page_quote' } : kind === 'image' ? { kind: 'media', assetId: 'original-image', span: { kind: 'whole' } } : { kind: 'reference' }, publicationDate: { status: 'unknown', reason: 'Synthetic data only.' }, provenance: { method: 'user_submission', rights: 'user_provided', retention: 'reference_only', toolVersion: null, contentHash: null, capturedAt: '2026-10-01T00:00:00Z', retrievedAt: '2026-09-30T00:00:00Z' } };
  update({ kind: 'evidence', value: evidence, assets: kind === 'image' ? [{ id: 'original-image', kind: 'image', location: { kind: 'not_retained' }, provenance: evidence.provenance }] : [] });
  let anchor: ExactAnchor = { kind: 'text', start: 7, quote: 'the exact saved quote' };
  if (kind !== 'text') {
    const content = kind === 'table' ? { kind: 'table', columns: ['Period', 'Count'], rows: [['2025', '12'], ['2026', '18']] } : { kind: 'image', mimeType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAYAAAD+Bd/7AAAALElEQVR4AX3BQQ2AABADsJJMwt57498gOLj24f2KoiiKoog5xZxiTjGnmNMPhN8CX95XlDwAAAAASUVORK5CYII=' };
    update({ kind: 'material', value: { kind: 'retain', material: { materialId: 'original-material', revision: 1, evidenceId: evidence.id, evidenceDigest: report.anchorSources[0].evidenceDigest, capturedAt: '2026-10-01T01:00:00Z', rights: 'user_provided', content } } });
    const workspace = report.document.workspace;
    if (workspace.schemaVersion !== 'contexttrail-inquiry-v2') throw new Error('Missing synthetic material');
    const material = workspace.materials.versions[0];
    anchor = kind === 'image' ? { kind: 'image_region', materialId: material.materialId, materialDigest: material.digest, x: 2, y: 1, width: 6, height: 5 } : { kind: 'table_cell', materialId: material.materialId, materialDigest: material.digest, row: 1, column: 1, value: '18' };
  }
  const finding: Finding = { kind: 'finding', id: 'original-finding', questionId: report.document.workspace.inquiry.id, text: 'Synthetic finding from an exact selection.', assessment: { kind: 'operator_inference', reviewer: 'Offline reviewer', rationale: 'Inspect the retained original without making a truth claim.' }, support: [{ evidenceId: evidence.id, relationship: 'context', anchor }] };
  update({ kind: 'finding', value: finding });
  if (state === 'changed') update({ kind: 'evidence', value: { ...evidence, title: 'Corrected current source', content: kind === 'text' ? { kind: 'text', text: 'Corrected current passage.', attribution: 'page_quote' } : evidence.content, provenance: { ...evidence.provenance, capturedAt: '2026-10-02T00:00:00Z' } }, assets: [] });
  else if (state === 'withdrawn' && kind !== 'text') update({ kind: 'material', value: { kind: 'withdraw', materialId: 'original-material', reason: 'Synthetic withdrawal; retain history for review.' } });
  else {
    const workspace = report.document.workspace, current = inquiryCase(workspace);
    const removed = { ...current, revision: current.revision + 1, evidence: [] };
    report.document.workspace = applyInquiry(workspace, { kind: 'update', operationId: 'confirmed-source-removal', expectedRevision: workspace.revision, caseUpdates: { updates: [{ kind: 'snapshot', caseRecord: removed, removal: { status: 'confirmed', reason: 'Synthetic confirmed removal.' } }], watchlists: [], familyLinks: [] }, subquestions: [], hypotheses: [], findings: [] }).workspace;
    report.document.revision += 1;
    report = reviewResearch(report.document);
  }
  return report;
}
