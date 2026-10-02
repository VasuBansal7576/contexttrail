import type { LocalComparisonResponse } from '../video/matching/application-contract';
import { parseSavedComparison } from './saved-comparison';
/** Stateless manual-workflow adapter. No retrieval, storage, provider, or credential access. */
import { createHash } from 'node:crypto';
import type { CaseEvidence, CaseRecord, MediaAsset } from '../cases/model';
import { parseCaseRecord } from '../cases/parse';
import { WORKSPACE_VERSION, WORKSPACE_VERSION_V2, type Finding, type Hypothesis, type InquiryRequest, type InquiryWorkspace, type Subquestion } from '../inquiries/model';
import type { MaterialEditInput } from '../inquiries/materials';
import { evidenceDigest } from '../watchlists/collection';
import { parseWorkspace } from '../inquiries/parse';
import { applyInquiry, findingViews } from '../inquiries/workspace';
import { sourceDependencyReport, type SuppliedCitation } from '../source-dependencies/report';
import { object } from '../watchlists/parse';

export class ResearchOperationConflict extends Error {}

export const RESEARCH_VERSION = 'contexttrail-research-v1';
export const RESEARCH_VERSION_V2 = 'contexttrail-research-v2';
export const RESEARCH_VERSION_V3 = "contexttrail-research-v3";
interface ResearchDocumentBase {
  /** Includes citation-only edits, which do not alter inquiry semantics. */
  revision: number;
  workspace: InquiryWorkspace;
  citations: SuppliedCitation[];
  applied: Array<{ operationId: string; digest: string }>;
}
export type ResearchDocument = ResearchDocumentBase & (
  | { schemaVersion: typeof RESEARCH_VERSION | typeof RESEARCH_VERSION_V2 }
  | { schemaVersion: typeof RESEARCH_VERSION_V3; comparison: LocalComparisonResponse }
);
export type ResearchChange =
  | { kind: 'subquestion'; value: Subquestion }
  | { kind: 'hypothesis'; value: Hypothesis }
  | { kind: 'evidence'; value: CaseEvidence; assets: MediaAsset[] }
  | { kind: 'finding'; value: Finding }
  | { kind: 'material'; value: MaterialEditInput }
  | { kind: 'citation'; value: SuppliedCitation };
export type ResearchRequest =
  | { kind: 'start'; operationId: string; question: string; createdAt: string }
  | { kind: 'import_case'; operationId: string; question: string; createdAt: string; caseRecord: CaseRecord }
  | { kind: 'import_comparison'; operationId: string; question: string; createdAt: string; comparison: LocalComparisonResponse }
  | { kind: 'read'; document: ResearchDocument }
  | { kind: 'update'; operationId: string; expectedRevision: number; document: ResearchDocument; change: ResearchChange };

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 20_000) throw new Error('Expected nonempty bounded text');
  return value;
}
function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error('Invalid research revision');
  return value;
}
function operationId(value: unknown): string {
  const result = text(value);
  if (result.length > 200) throw new Error('Operation ID exceeds 200 characters');
  return result;
}
function digest(value: unknown): string { return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`; }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => `${JSON.stringify(key)}:${canonical(val)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function inquiryCase(workspace: InquiryWorkspace): CaseRecord {
  const record = workspace.collection.cases.find(item => item.id === workspace.inquiry.caseId);
  if (!record) throw new Error('Missing inquiry case');
  return record;
}
export function parseResearchDocument(value: unknown): ResearchDocument {
  const o = object(value);
  if (o.schemaVersion !== RESEARCH_VERSION && o.schemaVersion !== RESEARCH_VERSION_V2 && o.schemaVersion !== RESEARCH_VERSION_V3) throw new Error('Unsupported research version. Keep the original file; it has not been changed.');
  const workspace = parseWorkspace(o.workspace);
  if (o.schemaVersion !== RESEARCH_VERSION_V3 && (o.schemaVersion === RESEARCH_VERSION) !== (workspace.schemaVersion === WORKSPACE_VERSION)) throw new Error('Research and inquiry versions do not match');
  const report = sourceDependencyReport({ caseRecord: inquiryCase(workspace), citations: o.citations });
  if (!Array.isArray(o.applied) || o.applied.length > 1000) throw new Error('Invalid research operation history');
  const applied = o.applied.map(value => { const a = object(value); const digest = text(a.digest); if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid research operation digest'); return { operationId: operationId(a.operationId), digest }; });
  if (new Set(applied.map(a => a.operationId)).size !== applied.length) throw new Error('Duplicate research operation IDs');
  const base = { revision: revision(o.revision), workspace, citations: report.citationChecks.map(check => check.citation), applied };
  return o.schemaVersion === RESEARCH_VERSION_V3 ? { ...base, schemaVersion: o.schemaVersion, comparison: parseSavedComparison(o.comparison) } : { ...base, schemaVersion: o.schemaVersion };
}
export function reviewResearch(document: ResearchDocument) {
  const record = inquiryCase(document.workspace);
  return { document, anchorSources: record.evidence.map(e => ({ evidenceId: e.id, evidenceDigest: evidenceDigest(record, e) })), findings: findingViews(document.workspace), dependencies: sourceDependencyReport({ caseRecord: inquiryCase(document.workspace), citations: document.citations }) };
}
export type ResearchReview = ReturnType<typeof reviewResearch>;

export function researchWorkflow(input: unknown): ResearchReview {
  const request = object(input);
  if (request.kind === 'read') return reviewResearch(parseResearchDocument(request.document));
  const id = operationId(request.operationId);
  if (request.kind === 'start' || request.kind === 'import_case' || request.kind === 'import_comparison') {
    const workspace = applyInquiry(null, { kind: 'start', operationId: id, inquiry: { kind: 'inquiry', id: `question:${id}`, caseId: `case:${id}`, question: text(request.question) }, createdAt: text(request.createdAt) }).workspace;
    const imported = request.kind === 'import_case' ? parseCaseRecord(request.caseRecord) : null;
    if (imported) {
      workspace.inquiry.caseId = imported.id;
      workspace.collection.cases = [imported];
    }
    const comparison = request.kind === 'import_comparison' ? parseSavedComparison(request.comparison) : null;
    return reviewResearch(parseResearchDocument({ schemaVersion: comparison ? RESEARCH_VERSION_V3 : RESEARCH_VERSION, ...(comparison ? { comparison } : {}), revision: 1, workspace, citations: [], applied: [{ operationId: id, digest: digest({ kind: request.kind, question: text(request.question), createdAt: text(request.createdAt), ...(imported ? { caseRecord: imported } : {}), ...(comparison ? { comparison } : {}) }) }] }));
  }
  if (request.kind !== 'update') throw new Error('Unsupported research request');
  const document = parseResearchDocument(request.document), change = object(request.change);
  const requestDigest = digest({ kind: 'update', expectedRevision: request.expectedRevision, change });
  const previous = document.applied.find(item => item.operationId === id);
  if (previous) {
    if (previous.digest !== requestDigest) throw new ResearchOperationConflict('Operation ID reused with different input');
    return reviewResearch(document);
  }
  if (revision(request.expectedRevision) !== document.revision) throw new Error('Conflicting research revision. Reopen the latest saved case.');
  const update: InquiryRequest = { kind: 'update', operationId: id, expectedRevision: document.workspace.revision, caseUpdates: { updates: [], watchlists: [], familyLinks: [] }, subquestions: [], hypotheses: [], findings: [] };
  // Domain parsers validate unknown edits through applyInquiry, never unchecked casts.
  let workspaceInput: unknown = update;
  switch (change.kind) {
    case 'subquestion': workspaceInput = { ...update, subquestions: [change.value] }; break;
    case 'hypothesis': workspaceInput = { ...update, hypotheses: [change.value] }; break;
    case 'finding': workspaceInput = { ...update, findings: [change.value] }; break;
    case 'material': workspaceInput = { ...update, materialEdits: [change.value] }; break;
    case 'evidence': {
      const record = inquiryCase(document.workspace), evidence = object(change.value);
      if (!Array.isArray(change.assets)) throw new Error('Expected media assets');
      const ids = change.assets.map(value => text(object(value).id));
      const next = parseCaseRecord({ ...record, revision: record.revision + 1, evidence: [...record.evidence.filter(item => item.id !== evidence.id), change.value], assets: [...record.assets.filter(asset => !ids.includes(asset.id)), ...change.assets] });
      update.caseUpdates.updates.push({ kind: 'snapshot', caseRecord: next, removal: { status: 'not_confirmed' } });
      break;
    }
    case 'citation': {
      const citation = object(change.value);
      const report = sourceDependencyReport({ caseRecord: inquiryCase(document.workspace), citations: [...document.citations.filter(item => item.id !== citation.id), change.value] });
      document.citations = report.citationChecks.map(check => check.citation);
      break;
    }
    default: throw new Error('Unsupported research edit');
  }
  if (change.kind !== 'citation') document.workspace = applyInquiry(document.workspace, workspaceInput).workspace;
  if (document.schemaVersion !== RESEARCH_VERSION_V3 && document.workspace.schemaVersion === WORKSPACE_VERSION_V2) document.schemaVersion = RESEARCH_VERSION_V2;
  document.revision += 1;
  document.applied.push({ operationId: id, digest: requestDigest });
  return reviewResearch(parseResearchDocument(document));
}
