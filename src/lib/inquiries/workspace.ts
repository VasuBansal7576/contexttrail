import { createHash } from 'node:crypto';
import { CASE_SCHEMA_VERSION, type CaseEvidence, type CaseRecord } from '../cases/model';
import { parseCaseRecord } from '../cases/parse';
import { applyUpdates, emptyCollection, evidenceDigest } from '../watchlists/collection';
import { WORKSPACE_VERSION, WORKSPACE_VERSION_V2, type ExactAnchor, type Finding, type InquiryWorkspace, type ResearchState } from './model';
import { parseInquiryRequest, parseWorkspace } from './parse';
import { applyMaterialEdits, invalidateMaterialSources, materialHash, type MaterialStore, type RetainedMaterial } from './materials';
function canonical(v: unknown): string { if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`; if (v && typeof v === 'object') return `{${Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`; return JSON.stringify(v) ?? 'null'; }
function digest(v: unknown): string { return `sha256:${createHash('sha256').update(canonical(v)).digest('hex')}`; }
function research(w: InquiryWorkspace): ResearchState { return { inquiry: w.inquiry, subquestions: w.subquestions, hypotheses: w.hypotheses, findings: w.findings }; }
function anchorMatches(c: CaseRecord, e: CaseEvidence, a: Extract<ExactAnchor, { kind: 'text' | 'time' }>): boolean {
  if (a.kind === 'text') return e.content.kind === 'text' && e.content.text.slice(a.start, a.start + a.quote.length) === a.quote;
  if (e.content.kind !== 'media') return false;
  const asset = c.assets.find(asset => e.content.kind === 'media' && asset.id === e.content.assetId);
  if (!asset || asset.kind === 'image') return false;
  const end = a.startMs + a.durationMs;
  if (!Number.isSafeInteger(end)) return false;
  if (asset.durationMs !== null && end > asset.durationMs) return false;
  return e.content.span.kind === 'time' ? a.startMs >= e.content.span.startMs && end <= e.content.span.startMs + e.content.span.durationMs : asset.durationMs !== null;
}
type RetainedAnchor = Extract<ExactAnchor, { kind: 'image_region' | 'table_cell' }>;
/** Payloads live once in the workspace store, not once per supporting finding. */
function materialReference(material: RetainedMaterial | null) {
  if (!material) return null;
  const content = material.content;
  return { materialId: material.materialId, revision: material.revision, digest: material.digest, evidenceId: material.evidenceId,
    content: content.kind === 'image' ? { kind: content.kind, mimeType: content.mimeType, width: content.width, height: content.height } : { kind: content.kind, rowCount: content.rows.length, columnCount: content.columns.length } };
}
function materialSupport(store: MaterialStore | null, c: CaseRecord | undefined, e: CaseEvidence | null, a: RetainedAnchor) {
  const retainedMaterial = store?.versions.find(m => m.materialId === a.materialId && m.digest === a.materialDigest) ?? null;
  const head = store?.heads.find(h => h.materialId === a.materialId);
  const currentMaterial = head?.status === 'available' ? store?.versions.find(m => m.digest === head.digest) ?? null : null;
  const detail = { retainedMaterial: materialReference(retainedMaterial), currentMaterial: materialReference(currentMaterial) };
  if (!c || !e) return { ...detail, status: 'unavailable' as const, reason: 'Source evidence is missing.', binding: null };
  if (!head || head.status === 'unavailable' || !currentMaterial || !retainedMaterial) return { ...detail, status: 'unavailable' as const, reason: head?.status === 'unavailable' ? head.reason : 'Retained material is missing.', binding: null };
  const binding = materialHash({ evidence: evidenceDigest(c, e), material: currentMaterial.digest });
  if (head.sourceStatus === 'changed' || currentMaterial.evidenceId !== e.id || currentMaterial.evidenceDigest !== evidenceDigest(c, e) || currentMaterial.digest !== a.materialDigest) return { ...detail, status: 'changed' as const, reason: 'The retained material or its source evidence changed. Review the original selection.', binding };
  const content = currentMaterial.content;
  const matches = a.kind === 'image_region'
    ? content.kind === 'image' && a.x + a.width <= content.width && a.y + a.height <= content.height
    : content.kind === 'table' && a.row < content.rows.length && a.column < content.columns.length && content.rows[a.row][a.column] === a.value;
  return { ...detail, status: matches ? 'current' as const : 'changed' as const, reason: matches ? null : 'Selection is outside the retained content or its exact cell value differs.', binding };
}
function bind(w: InquiryWorkspace, f: Finding): string[] {
  const c = w.collection.cases.find(c => c.id === w.inquiry.caseId);
  if (!c) throw new Error('Missing inquiry case');
  return f.support.map(s => {
    const e = c.evidence.find(e => e.id === s.evidenceId);
    if (s.anchor.kind === 'image_region' || s.anchor.kind === 'table_cell') {
      const resolved = materialSupport(w.schemaVersion === WORKSPACE_VERSION_V2 ? w.materials : null, c, e ?? null, s.anchor);
      if (resolved.status !== 'current' || resolved.binding === null) throw new Error(`Finding ${f.id} lacks exact evidence at ${s.evidenceId}: ${resolved.reason}`);
      return resolved.binding;
    }
    if (!e || !anchorMatches(c, e, s.anchor)) throw new Error(`Finding ${f.id} lacks exact evidence at ${s.evidenceId}`);
    return evidenceDigest(c, e);
  });
}
export function findingViews(w: InquiryWorkspace) {
  const c = w.collection.cases.find(c => c.id === w.inquiry.caseId);
  return w.findings.map(({ finding, bindings }) => {
    const support = finding.support.map((s, i) => {
      const evidence = c?.evidence.find(e => e.id === s.evidenceId) ?? null;
      if (s.anchor.kind === 'image_region' || s.anchor.kind === 'table_cell') {
        const { binding, ...resolved } = materialSupport(w.schemaVersion === WORKSPACE_VERSION_V2 ? w.materials : null, c, evidence, s.anchor);
        return { ...s, ...resolved, historicalText: null, status: resolved.status === 'current' && binding !== bindings[i] ? 'changed' : resolved.status, evidence };
      }
      const status = !evidence || !c ? 'unavailable' : evidenceDigest(c, evidence) !== bindings[i] || !anchorMatches(c, evidence, s.anchor) ? 'changed' : 'current';
      let historicalText: { caseRevision: number; evidenceId: string } | null = null;
      if (status !== 'current' && s.anchor.kind === 'text') {
        for (const previous of [...w.collection.caseHistory].filter(r => r.id === w.inquiry.caseId).sort((a, b) => b.revision - a.revision)) {
          const old = previous.evidence.find(e => e.id === s.evidenceId);
          if (old && evidenceDigest(previous, old) === bindings[i] && anchorMatches(previous, old, s.anchor)) {
            historicalText = { caseRevision: previous.revision, evidenceId: old.id }; break;
          }
        }
      }
      return { ...s, status, evidence, historicalText };
    });
    return { finding, reviewStatus: support.every(s => s.status === 'current') ? 'current' : 'needs_review', support, limitation: 'Operator-supplied assessment. Matching content does not prove entailment or truth. A selected image region does not establish image authenticity; supplied table data is not independently verified.' };
  });
}
export function applyInquiry(workspaceInput: unknown | null, requestInput: unknown) {
  const request = parseInquiryRequest(requestInput), requestDigest = digest(request);
  let workspace = workspaceInput === null ? null : parseWorkspace(workspaceInput);
  const applied = workspace?.applied.find(a => a.operationId === request.operationId);
  if (applied) { if (applied.digest !== requestDigest) throw new Error('Operation ID reused with different input'); if (!workspace) throw new Error('Missing workspace'); return { workspace, notices: [], failures: [], findings: findingViews(workspace), replayed: true }; }
  if (request.kind === 'start') {
    if (workspace) throw new Error('Workspace already exists');
    const caseRecord = parseCaseRecord({ schemaVersion: CASE_SCHEMA_VERSION, id: request.inquiry.caseId, revision: 1, createdAt: request.createdAt, claims: [], assets: [], evidence: [], occurrences: [], relations: [], coverage: { scope: 'retrieved_evidence', completeness: 'unknown', omittedEvidenceCount: 0, originalPublication: { status: 'unknown', reason: 'Open inquiry has no origin assertion.' }, limitations: ['Manual local investigation. No search or model analysis has run.'], searches: [] } });
    workspace = { schemaVersion: WORKSPACE_VERSION, revision: 1, inquiry: request.inquiry, subquestions: [], hypotheses: [], findings: [], history: [], applied: [{ operationId: request.operationId, digest: requestDigest }], collection: { ...emptyCollection(), cases: [caseRecord] } };
    return { workspace: parseWorkspace(workspace), notices: [], failures: [], findings: [], replayed: false };
  }
  if (!workspace) throw new Error('Start an inquiry first');
  if (request.expectedRevision !== workspace.revision) throw new Error('Conflicting workspace revision');
  const previousResearch = research(workspace), result = applyUpdates(workspace.collection, request.caseUpdates);
  workspace.collection = result.collection;
  if (workspace.schemaVersion === WORKSPACE_VERSION_V2) {
    const caseId = workspace.inquiry.caseId, c = workspace.collection.cases.find(c => c.id === caseId);
    if (!c) throw new Error('Missing inquiry case');
    workspace.materials = invalidateMaterialSources(workspace.materials, c);
  }
  if (request.materialEdits?.length) {
    const caseId = workspace.inquiry.caseId;
    const c = workspace.collection.cases.find(c => c.id === caseId);
    if (!c) throw new Error('Missing inquiry case');
    const materials = applyMaterialEdits(workspace.schemaVersion === WORKSPACE_VERSION_V2 ? workspace.materials : { versions: [], heads: [] }, c, request.materialEdits);
    workspace = { ...workspace, schemaVersion: WORKSPACE_VERSION_V2, materials };
  }
  function upsert<T extends { id: string }>(old: T[], edits: T[]): T[] { const ids = new Set(edits.map(e => e.id)); return [...old.filter(e => !ids.has(e.id)), ...edits]; }
  workspace.subquestions = upsert(workspace.subquestions, request.subquestions);
  workspace.hypotheses = upsert(workspace.hypotheses, request.hypotheses);
  for (const finding of request.findings) {
    const old = workspace.findings.find(f => f.finding.id === finding.id);
    // Identical resubmission cannot erase a stale-source warning. A new assessment needs an explicit changed rationale.
    if (old && canonical(old.finding) === canonical(finding)) continue;
    if (old && old.finding.assessment.rationale === finding.assessment.rationale) throw new Error('Revised finding requires a changed review rationale');
    const saved = { finding, bindings: bind(workspace, finding) };
    workspace.findings = [...workspace.findings.filter(f => f.finding.id !== finding.id), saved];
  }
  workspace.history.push({ revision: workspace.revision, research: previousResearch });
  workspace.revision += 1;
  workspace.applied.push({ operationId: request.operationId, digest: requestDigest });
  workspace = parseWorkspace(workspace);
  return { workspace, notices: result.notices, failures: result.failures, findings: findingViews(workspace), replayed: false };
}
