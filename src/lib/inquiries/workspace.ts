import { createHash } from 'node:crypto';
import { CASE_SCHEMA_VERSION, type CaseEvidence, type CaseRecord } from '../cases/model';
import { parseCaseRecord } from '../cases/parse';
import { applyUpdates, emptyCollection, evidenceDigest } from '../watchlists/collection';
import { WORKSPACE_VERSION, type ExactAnchor, type Finding, type InquiryWorkspace, type ResearchState } from './model';
import { parseInquiryRequest, parseWorkspace } from './parse';
function canonical(v: unknown): string { if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`; if (v && typeof v === 'object') return `{${Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`; return JSON.stringify(v) ?? 'null'; }
function digest(v: unknown): string { return `sha256:${createHash('sha256').update(canonical(v)).digest('hex')}`; }
function research(w: InquiryWorkspace): ResearchState { return { inquiry: w.inquiry, subquestions: w.subquestions, hypotheses: w.hypotheses, findings: w.findings }; }
function anchorMatches(c: CaseRecord, e: CaseEvidence, a: ExactAnchor): boolean {
  if (a.kind === 'text') return e.content.kind === 'text' && e.content.text.slice(a.start, a.start + a.quote.length) === a.quote;
  if (e.content.kind !== 'media') return false;
  const asset = c.assets.find(asset => e.content.kind === 'media' && asset.id === e.content.assetId);
  if (!asset || asset.kind === 'image') return false;
  const end = a.startMs + a.durationMs;
  if (!Number.isSafeInteger(end)) return false;
  if (asset.durationMs !== null && end > asset.durationMs) return false;
  return e.content.span.kind === 'time' ? a.startMs >= e.content.span.startMs && end <= e.content.span.startMs + e.content.span.durationMs : asset.durationMs !== null;
}
function bind(w: InquiryWorkspace, f: Finding): string[] {
  const c = w.collection.cases.find(c => c.id === w.inquiry.caseId);
  if (!c) throw new Error('Missing inquiry case');
  return f.support.map(s => { const e = c.evidence.find(e => e.id === s.evidenceId); if (!e || !anchorMatches(c, e, s.anchor)) throw new Error(`Finding ${f.id} lacks exact evidence at ${s.evidenceId}`); return evidenceDigest(c, e); });
}
export function findingViews(w: InquiryWorkspace) {
  const c = w.collection.cases.find(c => c.id === w.inquiry.caseId);
  return w.findings.map(({ finding, bindings }) => {
    const support = finding.support.map((s, i) => { const evidence = c?.evidence.find(e => e.id === s.evidenceId) ?? null; const status = !evidence || !c ? 'unavailable' : evidenceDigest(c, evidence) !== bindings[i] || !anchorMatches(c, evidence, s.anchor) ? 'changed' : 'current'; return { ...s, status, evidence }; });
    return { finding, reviewStatus: support.every(s => s.status === 'current') ? 'current' : 'needs_review', support, limitation: 'Operator-supplied assessment. Matching content does not prove entailment or truth.' };
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
