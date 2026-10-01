/** Stateless manual-workflow adapter. No retrieval, storage, provider, or credential access. */
import { createHash } from 'node:crypto';
import type { CaseEvidence, CaseRecord, MediaAsset } from '../cases/model';
import { parseCaseRecord } from '../cases/parse';
import type { Finding, Hypothesis, InquiryRequest, InquiryWorkspace, Subquestion } from '../inquiries/model';
import { parseWorkspace } from '../inquiries/parse';
import { applyInquiry, findingViews } from '../inquiries/workspace';
import { sourceDependencyReport, type SuppliedCitation } from '../source-dependencies/report';
import { object } from '../watchlists/parse';

export class ResearchOperationConflict extends Error {}

export const RESEARCH_VERSION = 'contexttrail-research-v1';
export interface ResearchDocument {
  schemaVersion: typeof RESEARCH_VERSION;
  /** Includes citation-only edits, which do not alter inquiry semantics. */
  revision: number;
  workspace: InquiryWorkspace;
  citations: SuppliedCitation[];
  applied: Array<{ operationId: string; digest: string }>;
}
export type ResearchChange =
  | { kind: 'subquestion'; value: Subquestion }
  | { kind: 'hypothesis'; value: Hypothesis }
  | { kind: 'evidence'; value: CaseEvidence; assets: MediaAsset[] }
  | { kind: 'finding'; value: Finding }
  | { kind: 'citation'; value: SuppliedCitation };
export type ResearchRequest =
  | { kind: 'start'; operationId: string; question: string; createdAt: string }
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
  if (o.schemaVersion !== RESEARCH_VERSION) throw new Error('Unsupported research version. Keep the original file; it has not been changed.');
  const workspace = parseWorkspace(o.workspace);
  const report = sourceDependencyReport({ caseRecord: inquiryCase(workspace), citations: o.citations });
  if (!Array.isArray(o.applied) || o.applied.length > 1000) throw new Error('Invalid research operation history');
  const applied = o.applied.map(value => { const a = object(value); const digest = text(a.digest); if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid research operation digest'); return { operationId: operationId(a.operationId), digest }; });
  if (new Set(applied.map(a => a.operationId)).size !== applied.length) throw new Error('Duplicate research operation IDs');
  return { schemaVersion: RESEARCH_VERSION, revision: revision(o.revision), workspace, citations: report.citationChecks.map(check => check.citation), applied };
}
export function reviewResearch(document: ResearchDocument) {
  return { document, findings: findingViews(document.workspace), dependencies: sourceDependencyReport({ caseRecord: inquiryCase(document.workspace), citations: document.citations }) };
}
export type ResearchReview = ReturnType<typeof reviewResearch>;

export function researchWorkflow(input: unknown): ResearchReview {
  const request = object(input);
  if (request.kind === 'read') return reviewResearch(parseResearchDocument(request.document));
  const id = operationId(request.operationId);
  if (request.kind === 'start') {
    const workspace = applyInquiry(null, { kind: 'start', operationId: id, inquiry: { kind: 'inquiry', id: `question:${id}`, caseId: `case:${id}`, question: text(request.question) }, createdAt: text(request.createdAt) }).workspace;
    return reviewResearch({ schemaVersion: RESEARCH_VERSION, revision: 1, workspace, citations: [], applied: [{ operationId: id, digest: digest({ kind: 'start', question: text(request.question), createdAt: text(request.createdAt) }) }] });
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
  document.revision += 1;
  document.applied.push({ operationId: id, digest: requestDigest });
  return reviewResearch(parseResearchDocument(document));
}
