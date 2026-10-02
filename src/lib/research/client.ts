import { parseClaimReport, invalidateClaimReport, type ClaimReport } from './claim-report';
import type { LocalComparisonResponse } from '../video/matching/application-contract';
import { parseComparisonResponse } from '../video/matching/client';
/** Browser boundary for the opt-in local research service. No retrieval or storage. */
import { parseCaseRecord } from '../cases/parse';
import type { CaseEvidence, CaseRecord, NonEmpty } from '../cases/model';
import type { ExactAnchor, Finding, FindingSupport, Hypothesis, Inquiry, Subquestion } from '../inquiries/model';
import type { MaterialContent, MaterialHead, MaterialStore, RetainedMaterial } from '../inquiries/materials';
import type { Basis, SourceDependencyReport, SuppliedCitation } from '../source-dependencies/report';
import type { ResearchApplicationRequest } from './service';

export interface ResearchCaseSummary { caseId: string; question: string; revision: number; createdAt: string }
export interface ResearchMaterialReference {
  materialId: string; revision: number; digest: string; evidenceId: string;
  content: { kind: 'image'; mimeType: 'image/png'; width: number; height: number } | { kind: 'table'; rowCount: number; columnCount: number };
}
export interface ResearchFindingSupport extends FindingSupport {
  status: 'current' | 'changed' | 'unavailable';
  reason: string | null;
  evidence: CaseEvidence | null;
  retainedMaterial: ResearchMaterialReference | null;
  currentMaterial: ResearchMaterialReference | null;
  historicalText: { caseRevision: number; evidence: CaseEvidence } | null;
}
export interface ResearchFindingView {
  finding: Finding; reviewStatus: 'current' | 'needs_review';
  support: ResearchFindingSupport[]; limitation: string;
}
export interface ResearchHistoryView {
  revision: number; inquiry: Inquiry; subquestions: Subquestion[]; hypotheses: Hypothesis[]; findings: Finding[];
}
export type ResearchDependencies = Pick<SourceDependencyReport, 'caseId' | 'caseRevision' | 'sources' | 'citationChecks' | 'sharedCitations' | 'duplicatePassages' | 'independence' | 'limits'>;
export interface ResearchCaseView extends ResearchCaseSummary {
  questionId: string; workspaceRevision: number;
  subquestions: Subquestion[]; hypotheses: Hypothesis[];
  caseRecord: CaseRecord; caseHistory: CaseRecord[];
  anchorSources: Array<{ evidenceId: string; evidenceDigest: string }>;
  findingViews: ResearchFindingView[];
  history: ResearchHistoryView[];
  /** Accepted operation IDs and digests. History revisions are workspace revisions. */
  changes: Array<{ operationId: string; digest: string }>;
  materials: MaterialStore;
  citations: SuppliedCitation[];
  dependencies: ResearchDependencies;
  comparison: LocalComparisonResponse | null;
  claimReport: ClaimReport | null;
  claimReportCase: CaseRecord | null;
  reportStatus: 'current' | 'stale' | 'none';
}
export interface ResearchClientOptions { signal?: AbortSignal }
export class ResearchClientError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message); this.name = 'ResearchClientError';
  }
}

function fail(path: string, message = 'unexpected value'): never {
  throw new ResearchClientError(0, 'INVALID_RESPONSE', `Invalid research response at ${path}: ${message}`);
}
function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(path, 'expected object');
  return value as Record<string, unknown>;
}
function text(value: unknown, path: string, max = 20_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) return fail(path, 'expected bounded nonempty text');
  return value;
}
const id = (value: unknown, path: string) => text(value, path, 256);
const nullableText = (value: unknown, path: string) => value === null ? null : text(value, path);
function integer(value: unknown, path: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return fail(path, 'expected bounded integer');
  return value;
}
function choice<const T extends string>(value: unknown, values: readonly T[], path: string): T {
  for (const item of values) if (item === value) return item;
  return fail(path, 'unsupported value');
}
function list<T>(value: unknown, path: string, parse: (item: unknown, path: string) => T, max = 1000): T[] {
  if (!Array.isArray(value) || value.length > max) return fail(path, 'expected bounded array');
  return value.map((item, index) => parse(item, `${path}[${index}]`));
}
function unique<T>(values: T[], key: (value: T) => string, path: string): T[] {
  if (new Set(values.map(key)).size !== values.length) return fail(path, 'duplicate identity');
  return values;
}
function nonempty<T>(values: T[], path: string): NonEmpty<T> {
  const [first, ...rest] = values;
  return first === undefined ? fail(path, 'expected at least one item') : [first, ...rest];
}
function digest(value: unknown, path: string): string {
  const result = text(value, path, 71);
  return /^sha256:[a-f0-9]{64}$/.test(result) ? result : fail(path, 'expected SHA-256 digest');
}
function timestamp(value: unknown, path: string): string {
  const result = text(value, path, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(result) || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString().slice(0, 19) !== result.slice(0, 19)) return fail(path, 'expected valid UTC timestamp');
  return result;
}
function url(value: unknown, path: string): string {
  const result = text(value, path, 4096);
  try {
    const parsed = new URL(result);
    if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) return result;
  } catch { /* Reject below. No URL is fetched by parsing it. */ }
  return fail(path, 'expected HTTP(S) URL without credentials');
}
function inquiry(value: unknown, path: string): Inquiry {
  const v = object(value, path);
  return { kind: choice(v.kind, ['inquiry'], path), id: id(v.id, `${path}.id`), caseId: id(v.caseId, `${path}.caseId`), question: text(v.question, `${path}.question`) };
}
function subquestion(value: unknown, path: string): Subquestion {
  const v = object(value, path);
  return { kind: choice(v.kind, ['subquestion'], path), id: id(v.id, `${path}.id`), question: text(v.question, `${path}.question`) };
}
function hypothesis(value: unknown, path: string): Hypothesis {
  const v = object(value, path);
  return { kind: choice(v.kind, ['hypothesis'], path), id: id(v.id, `${path}.id`), questionId: id(v.questionId, `${path}.questionId`), explanation: text(v.explanation, `${path}.explanation`) };
}
function anchor(value: unknown, path: string): ExactAnchor {
  const v = object(value, path), kind = choice(v.kind, ['text', 'time', 'image_region', 'table_cell'], path);
  switch (kind) {
    case 'text': {
      const start = integer(v.start, `${path}.start`), quote = text(v.quote, `${path}.quote`);
      integer(start + quote.length, path);
      return { kind, start, quote };
    }
    case 'time': {
      const startMs = integer(v.startMs, `${path}.startMs`), durationMs = integer(v.durationMs, `${path}.durationMs`, 1);
      integer(startMs + durationMs, path);
      return { kind, startMs, durationMs };
    }
    case 'image_region': {
      const x = integer(v.x, `${path}.x`), y = integer(v.y, `${path}.y`), width = integer(v.width, `${path}.width`, 1), height = integer(v.height, `${path}.height`, 1);
      integer(x + width, path); integer(y + height, path);
      return { kind, materialId: id(v.materialId, `${path}.materialId`), materialDigest: digest(v.materialDigest, `${path}.materialDigest`), x, y, width, height };
    }
    case 'table_cell': return { kind, materialId: id(v.materialId, `${path}.materialId`), materialDigest: digest(v.materialDigest, `${path}.materialDigest`), row: integer(v.row, `${path}.row`), column: integer(v.column, `${path}.column`), value: cell(v.value, `${path}.value`) };
  }
}
function support(value: unknown, path: string): FindingSupport {
  const v = object(value, path);
  return { evidenceId: id(v.evidenceId, `${path}.evidenceId`), relationship: choice(v.relationship, ['supports', 'challenges', 'context'], `${path}.relationship`), anchor: anchor(v.anchor, `${path}.anchor`) };
}
function finding(value: unknown, path: string): Finding {
  const v = object(value, path), assessment = object(v.assessment, `${path}.assessment`);
  return { kind: choice(v.kind, ['finding'], path), id: id(v.id, `${path}.id`), questionId: id(v.questionId, `${path}.questionId`), text: text(v.text, `${path}.text`),
    assessment: { kind: choice(assessment.kind, ['source_statement', 'operator_inference'], `${path}.assessment.kind`), reviewer: text(assessment.reviewer, `${path}.assessment.reviewer`), rationale: text(assessment.rationale, `${path}.assessment.rationale`) },
    support: nonempty(list(v.support, `${path}.support`, support), `${path}.support`) };
}
function history(value: unknown, path: string): ResearchHistoryView {
  const v = object(value, path), research = object(v.research, `${path}.research`);
  return { revision: integer(v.revision, `${path}.revision`, 1), inquiry: inquiry(research.inquiry, `${path}.inquiry`),
    subquestions: list(research.subquestions, `${path}.subquestions`, subquestion), hypotheses: list(research.hypotheses, `${path}.hypotheses`, hypothesis),
    findings: list(research.findings, `${path}.findings`, (item, p) => finding(object(item, p).finding, `${p}.finding`)) };
}
function cell(value: unknown, path: string): string {
  return typeof value === 'string' && value.length <= 20_000 ? value : fail(path, 'expected bounded string cell');
}
function materialContent(value: unknown, path: string): MaterialContent {
  const v = object(value, path);
  if (v.kind === 'table') {
    const columns = list(v.columns, `${path}.columns`, cell, 64), rows = list(v.rows, `${path}.rows`, (row, p) => list(row, p, cell, 64));
    if (!columns.length || !rows.length || columns.length * rows.length > 10_000 || rows.some(row => row.length !== columns.length)) return fail(path, 'invalid table dimensions');
    return { kind: 'table', columns, rows };
  }
  const kind = choice(v.kind, ['image'], `${path}.kind`), mimeType = choice(v.mimeType, ['image/png'], `${path}.mimeType`);
  const base64 = text(v.base64, `${path}.base64`, 4 * Math.ceil(256 * 1024 / 3));
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64) || !base64.startsWith('iVBORw0KGgo')) return fail(path, 'invalid PNG encoding');
  const width = integer(v.width, `${path}.width`, 1, 2048), height = integer(v.height, `${path}.height`, 1, 2048);
  if (width * height > 1024 * 1024) return fail(path, 'image exceeds pixel limit');
  // The service validates PNG bytes and cryptographic bindings; the UI checks its DTO.
  return { kind, mimeType, base64, width, height };
}
function material(value: unknown, path: string): RetainedMaterial {
  const v = object(value, path);
  return { materialId: id(v.materialId, `${path}.materialId`), revision: integer(v.revision, `${path}.revision`, 1), evidenceId: id(v.evidenceId, `${path}.evidenceId`), evidenceDigest: digest(v.evidenceDigest, `${path}.evidenceDigest`), capturedAt: timestamp(v.capturedAt, `${path}.capturedAt`), rights: choice(v.rights, ['user_provided'], `${path}.rights`), content: materialContent(v.content, `${path}.content`), digest: digest(v.digest, `${path}.digest`) };
}
function materialStore(value: unknown, path: string): MaterialStore {
  const v = object(value, path), versions = unique(list(v.versions, `${path}.versions`, material, 32), m => m.digest, path);
  unique(versions, m => JSON.stringify([m.materialId, m.revision]), path);
  const heads = unique(list(v.heads, `${path}.heads`, (value, p): MaterialHead => {
    const h = object(value, p), materialId = id(h.materialId, `${p}.materialId`);
    const status = choice(h.status, ['available', 'unavailable'], `${p}.status`);
    if (status === 'unavailable') return { materialId, status, reason: text(h.reason, `${p}.reason`) };
    const boundDigest = digest(h.digest, `${p}.digest`);
    if (!versions.some(m => m.materialId === materialId && m.digest === boundDigest)) return fail(p, 'missing material version');
    return { materialId, status, digest: boundDigest, sourceStatus: choice(h.sourceStatus, ['bound', 'changed'], `${p}.sourceStatus`) };
  }), h => h.materialId, path);
  for (const version of versions) if (!heads.some(h => h.materialId === version.materialId)) return fail(path, 'missing material head');
  for (const head of heads) if (!versions.some(m => m.materialId === head.materialId)) return fail(path, 'missing material history');
  return { versions, heads };
}
function materialReference(value: unknown, path: string): ResearchMaterialReference | null {
  if (value === null) return null;
  const v = object(value, path), c = object(v.content, `${path}.content`);
  const kind = choice(c.kind, ['image', 'table'], `${path}.content.kind`);
  return { materialId: id(v.materialId, `${path}.materialId`), revision: integer(v.revision, `${path}.revision`, 1), digest: digest(v.digest, `${path}.digest`), evidenceId: id(v.evidenceId, `${path}.evidenceId`),
    content: kind === 'image' ? { kind, mimeType: choice(c.mimeType, ['image/png'], `${path}.mimeType`), width: integer(c.width, `${path}.width`, 1, 2048), height: integer(c.height, `${path}.height`, 1, 2048) } : { kind, rowCount: integer(c.rowCount, `${path}.rowCount`, 1, 1000), columnCount: integer(c.columnCount, `${path}.columnCount`, 1, 64) } };
}
function findingView(value: unknown, path: string, record: CaseRecord, caseHistory: CaseRecord[]): ResearchFindingView {
  const v = object(value, path), parsedFinding = finding(v.finding, `${path}.finding`);
  const supports = list(v.support, `${path}.support`, (value, p): ResearchFindingSupport => {
    const s = object(value, p), parsed = support(value, p), status = choice(s.status, ['current', 'changed', 'unavailable'], `${p}.status`);
    const evidence = record.evidence.find(e => e.id === parsed.evidenceId) ?? null;
    if (s.evidence === null ? evidence !== null : !evidence || object(s.evidence, `${p}.evidence`).id !== evidence.id) return fail(p, 'support evidence does not match current case');
    if (!evidence && status !== 'unavailable') return fail(p, 'missing evidence cannot be current');
    const retained = parsed.anchor.kind === 'image_region' || parsed.anchor.kind === 'table_cell';
    let historicalText: ResearchFindingSupport['historicalText'] = null;
    if (s.historicalText !== undefined && s.historicalText !== null) {
      const reference = object(s.historicalText, `${p}.historicalText`);
      const caseRevision = integer(reference.caseRevision, `${p}.historicalText.caseRevision`, 1);
      const evidenceId = id(reference.evidenceId, `${p}.historicalText.evidenceId`);
      const prior = caseHistory.find(c => c.id === record.id && c.revision === caseRevision)?.evidence.find(e => e.id === evidenceId);
      if (status === 'current' || parsed.anchor.kind !== 'text' || evidenceId !== parsed.evidenceId || !prior || prior.content.kind !== 'text' || prior.content.text.slice(parsed.anchor.start, parsed.anchor.start + parsed.anchor.quote.length) !== parsed.anchor.quote) return fail(p, 'invalid historical text reference');
      historicalText = { caseRevision, evidence: prior };
    }
    return { ...parsed, status, evidence, historicalText, reason: retained ? nullableText(s.reason, `${p}.reason`) : null,
      retainedMaterial: retained ? materialReference(s.retainedMaterial, `${p}.retainedMaterial`) : null,
      currentMaterial: retained ? materialReference(s.currentMaterial, `${p}.currentMaterial`) : null };
  });
  if (JSON.stringify(supports.map(({ evidenceId, relationship, anchor }) => ({ evidenceId, relationship, anchor }))) !== JSON.stringify(parsedFinding.support)) return fail(path, 'finding support differs from saved anchors');
  const reviewStatus = choice(v.reviewStatus, ['current', 'needs_review'], `${path}.reviewStatus`);
  if ((reviewStatus === 'current') !== supports.every(s => s.status === 'current')) return fail(path, 'inconsistent finding review status');
  return { finding: parsedFinding, support: supports, reviewStatus, limitation: text(v.limitation, `${path}.limitation`) };
}
function checkMaterialReferences(findings: ResearchFindingView[], store: MaterialStore): void {
  for (const view of findings) for (const support of view.support) {
    const anchor = support.anchor;
    if (anchor.kind !== 'image_region' && anchor.kind !== 'table_cell') continue;
    for (const reference of [support.retainedMaterial, support.currentMaterial]) {
      if (!reference) continue;
      const material = store.versions.find(m => m.materialId === reference.materialId && m.digest === reference.digest);
      if (!material || material.materialId !== anchor.materialId || reference.revision !== material.revision || reference.evidenceId !== material.evidenceId) fail('findings.material', 'reference does not match retained material');
      const content = material.content;
      const expected = content.kind === 'image' ? { kind: content.kind, mimeType: content.mimeType, width: content.width, height: content.height } : { kind: content.kind, rowCount: content.rows.length, columnCount: content.columns.length };
      if (JSON.stringify(reference.content) !== JSON.stringify(expected)) fail('findings.material', 'reference dimensions differ from retained material');
    }
    if (support.retainedMaterial && support.retainedMaterial.digest !== anchor.materialDigest) fail('findings.material', 'retained digest differs from exact anchor');
    if (support.status === 'current' && (!support.retainedMaterial || support.currentMaterial?.digest !== anchor.materialDigest)) fail('findings.material', 'current support lacks its bound material');
  }
}
function basis(value: unknown, path: string): Basis {
  const v = object(value, path), status = choice(v.status, ['observed', 'inferred', 'unknown'], `${path}.status`);
  if (status === 'unknown') return { status, reason: text(v.reason, `${path}.reason`) };
  const method = text(v.method, `${path}.method`);
  return status === 'observed' ? { status, method } : { status, method, rationale: text(v.rationale, `${path}.rationale`) };
}
function citation(value: unknown, path: string): SuppliedCitation {
  const v = object(value, path), q = v.quote === null ? null : object(v.quote, `${path}.quote`);
  return { id: id(v.id, `${path}.id`), fromEvidenceId: id(v.fromEvidenceId, `${path}.fromEvidenceId`), targetUrl: url(v.targetUrl, `${path}.targetUrl`), targetRole: choice(v.targetRole, ['primary', 'unspecified'], `${path}.targetRole`), claimId: v.claimId === null ? null : id(v.claimId, `${path}.claimId`), quote: q === null ? null : { text: text(q.text, `${path}.quote.text`), start: q.start === null ? null : integer(q.start, `${path}.quote.start`) } };
}
function dependencies(value: unknown, path: string, record: CaseRecord): ResearchDependencies {
  const v = object(value, path);
  choice(v.schemaVersion, ['contexttrail-source-dependencies-v1'], `${path}.schemaVersion`);
  const caseId = id(v.caseId, `${path}.caseId`), caseRevision = integer(v.caseRevision, `${path}.caseRevision`, 1);
  if (caseId !== record.id || caseRevision !== record.revision) return fail(path, 'dependency report belongs to a different case revision');
  return { caseId, caseRevision,
    sources: list(v.sources, `${path}.sources`, (value, p) => { const s = object(value, p); return { id: id(s.id, `${p}.id`), url: url(s.url, `${p}.url`), evidenceIds: list(s.evidenceIds, `${p}.evidenceIds`, id), identity: basis(s.identity, `${p}.identity`) }; }),
    citationChecks: list(v.citationChecks, `${path}.citationChecks`, (value, p) => {
      const c = object(value, p), claimId = c.claim === null ? null : id(object(c.claim, `${p}.claim`).id, `${p}.claim.id`);
      const claim = claimId === null ? null : record.claims.find(item => item.id === claimId) ?? fail(`${p}.claim`, 'unknown claim');
      return { id: id(c.id, `${p}.id`), citation: citation(c.citation, `${p}.citation`), citationExistence: basis(c.citationExistence, `${p}.citationExistence`), documentCitationExistence: basis(c.documentCitationExistence, `${p}.documentCitationExistence`), sourceIdentity: basis(c.sourceIdentity, `${p}.sourceIdentity`), targetSourceId: id(c.targetSourceId, `${p}.targetSourceId`), targetEvidenceIds: list(c.targetEvidenceIds, `${p}.targetEvidenceIds`, id), claim,
        quoteChecks: list(c.quoteChecks, `${p}.quoteChecks`, (value, q) => {
          const check = object(value, q);
          const common = { evidenceId: id(check.evidenceId, `${q}.evidenceId`), evidenceBinding: digest(check.evidenceBinding, `${q}.evidenceBinding`), result: choice(check.result, ['unknown', 'exact_match', 'not_found_in_retained_passage', 'offset_mismatch'], `${q}.result`), basis: basis(check.basis, `${q}.basis`), matchedStart: check.matchedStart === null ? null : integer(check.matchedStart, `${q}.matchedStart`) };
          if (check.attribution === undefined) {
            if (common.matchedStart !== null || common.result !== 'unknown') return fail(q, 'quote result lacks retained text attribution');
            return { ...common, matchedStart: null };
          }
          if ((common.result === 'exact_match') !== (common.matchedStart !== null)) return fail(q, 'inconsistent quote match offset');
          return { ...common, attribution: choice(check.attribution, ['page_quote', 'search_snippet', 'classification_context'], `${q}.attribution`) };
        }, 10_000), quoteCoverage: basis(c.quoteCoverage, `${p}.quoteCoverage`), entailment: basis(c.entailment, `${p}.entailment`) };
    }),
    sharedCitations: list(v.sharedCitations, `${path}.sharedCitations`, (value, p) => {
      const c = object(value, p), dependency = basis(c.dependency, `${p}.dependency`);
      if (dependency.status !== 'inferred') return fail(p, 'shared citations describe inferred dependence');
      return { id: id(c.id, `${p}.id`), targetSourceId: id(c.targetSourceId, `${p}.targetSourceId`), targetUrl: url(c.targetUrl, `${p}.targetUrl`), evidenceIds: list(c.evidenceIds, `${p}.evidenceIds`, id), citationIds: list(c.citationIds, `${p}.citationIds`, id), observation: basis(c.observation, `${p}.observation`), dependency, primaryStatus: basis(c.primaryStatus, `${p}.primaryStatus`) };
    }),
    duplicatePassages: list(v.duplicatePassages, `${path}.duplicatePassages`, (value, p) => { const d = object(value, p); return { id: id(d.id, `${p}.id`), evidenceIds: list(d.evidenceIds, `${p}.evidenceIds`, id), passage: text(d.passage, `${p}.passage`), observation: basis(d.observation, `${p}.observation`), copying: basis(d.copying, `${p}.copying`) }; }),
    independence: basis(v.independence, `${path}.independence`), limits: list(v.limits, `${path}.limits`, text) };
}

export function parseResearchCaseList(value: unknown): ResearchCaseSummary[] {
  const v = object(value, 'response');
  return unique(list(v.cases, 'cases', (value, p) => {
    const c = object(value, p);
    return { caseId: id(c.caseId, `${p}.caseId`), question: text(c.question, `${p}.question`), revision: integer(c.revision, `${p}.revision`, 1), createdAt: timestamp(c.createdAt, `${p}.createdAt`) };
  }, 10_000), c => c.caseId, 'cases');
}
/** Project only UI-consumed fields. Server-side validation remains authoritative. */
export function parseResearchCaseView(value: unknown): ResearchCaseView {
  const v = object(value, 'response'), document = object(v.document, 'document'), workspace = object(document.workspace, 'workspace');
  const version = choice(document.schemaVersion, ['contexttrail-research-v1', 'contexttrail-research-v2', 'contexttrail-research-v3'], 'document.schemaVersion');
  const workspaceVersion = choice(workspace.schemaVersion, ['contexttrail-inquiry-v1', 'contexttrail-inquiry-v2'], 'workspace.schemaVersion');
  if (version !== 'contexttrail-research-v3' && (version === 'contexttrail-research-v1') !== (workspaceVersion === 'contexttrail-inquiry-v1')) return fail('workspace.schemaVersion', 'incompatible versions');
  const question = inquiry(workspace.inquiry, 'workspace.inquiry'), collection = object(workspace.collection, 'collection');
  choice(collection.schemaVersion, ['contexttrail-collection-v1'], 'collection.schemaVersion');
  let cases: CaseRecord[], caseHistory: CaseRecord[];
  try {
    cases = unique(list(collection.cases, 'collection.cases', parseCaseRecord), c => c.id, 'collection.cases');
    caseHistory = list(collection.caseHistory, 'collection.caseHistory', parseCaseRecord).filter(c => c.id === question.caseId);
  } catch (error) {
    if (error instanceof ResearchClientError) throw error;
    return fail('collection', error instanceof Error ? error.message : 'invalid case records');
  }
  const caseRecord = cases.find(c => c.id === question.caseId) ?? fail('collection.cases', 'missing inquiry case');
  const subquestions = unique(list(workspace.subquestions, 'subquestions', subquestion), s => s.id, 'subquestions');
  const hypotheses = unique(list(workspace.hypotheses, 'hypotheses', hypothesis), h => h.id, 'hypotheses');
  const questionIds = new Set([question.id, ...subquestions.map(s => s.id)]);
  if (questionIds.size !== subquestions.length + 1 || hypotheses.some(h => !questionIds.has(h.questionId))) return fail('hypotheses', 'unknown or duplicate question identity');
  const findingViews = unique(list(v.findings, 'findings', (item, p) => findingView(item, p, caseRecord, caseHistory)), f => f.finding.id, 'findings');
  if (findingViews.some(f => !questionIds.has(f.finding.questionId))) return fail('findings', 'unknown question');
  const anchorSources = unique(list(v.anchorSources, 'anchorSources', (value, p) => {
    const a = object(value, p); return { evidenceId: id(a.evidenceId, `${p}.evidenceId`), evidenceDigest: digest(a.evidenceDigest, `${p}.evidenceDigest`) };
  }), a => a.evidenceId, 'anchorSources');
  if (anchorSources.length !== caseRecord.evidence.length || anchorSources.some(a => !caseRecord.evidence.some(e => e.id === a.evidenceId))) return fail('anchorSources', 'evidence identities do not match case');
  const changes = unique(list(document.applied, 'changes', (value, p) => { const c = object(value, p); return { operationId: text(c.operationId, `${p}.operationId`, 200), digest: digest(c.digest, `${p}.digest`) }; }), c => c.operationId, 'changes');
  const materials = workspaceVersion === 'contexttrail-inquiry-v2' ? materialStore(workspace.materials, 'materials') : { versions: [], heads: [] };
  checkMaterialReferences(findingViews, materials);
  const citations = unique(list(document.citations, 'citations', citation), c => c.id, 'citations');
  const report = dependencies(v.dependencies, 'dependencies', caseRecord);
  const evidenceIds = new Set(caseRecord.evidence.map(e => e.id));
  const requireEvidence = (ids: string[]) => { if (ids.some(id => !evidenceIds.has(id))) fail('dependencies', 'unknown evidence reference'); };
  for (const source of report.sources) requireEvidence(source.evidenceIds);
  for (const check of report.citationChecks) { requireEvidence([check.citation.fromEvidenceId, ...check.targetEvidenceIds, ...check.quoteChecks.map(q => q.evidenceId)]); }
  for (const group of [...report.sharedCitations, ...report.duplicatePassages]) requireEvidence(group.evidenceIds);
  if (report.citationChecks.length !== citations.length || report.citationChecks.some(check => !citations.some(c => JSON.stringify(c) === JSON.stringify(check.citation)))) return fail('dependencies.citationChecks', 'citation report differs from saved citations');
  const claimReportCase = document.claimReport === undefined ? null : parseCaseRecord(document.claimReportCase ?? caseRecord);
  if (claimReportCase && claimReportCase.id !== caseRecord.id) return fail('claimReportCase', 'different case identity');
  const claimReport = claimReportCase ? parseClaimReport(document.claimReport, claimReportCase, text(object(document.claimReport, 'claimReport').question, 'claimReport.question')) : null;
  if (claimReportCase && !claimReport) return fail('claimReport', 'invalid historical report');
  if (document.claimReportInvalidated !== undefined && typeof document.claimReportInvalidated !== 'boolean') return fail('claimReportInvalidated');
  const reportStatus = !claimReport ? 'none' : !document.claimReportInvalidated && invalidateClaimReport(claimReport, caseRecord, question.question) ? 'current' : 'stale';
  if (v.reportStatus !== undefined && v.reportStatus !== reportStatus) return fail('reportStatus', 'inconsistent report validity');
  return { claimReport, claimReportCase, reportStatus, caseId: question.caseId, questionId: question.id, question: question.question, revision: integer(document.revision, 'document.revision', 1), workspaceRevision: integer(workspace.revision, 'workspace.revision', 1), createdAt: caseRecord.createdAt,
    subquestions, hypotheses, caseRecord, caseHistory, anchorSources, findingViews, history: list(workspace.history, 'history', history), changes,
    materials, citations, dependencies: report, comparison: version === 'contexttrail-research-v3' ? parseComparisonResponse(document.comparison) : null };
}

async function request(path: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(path, { ...init, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  let body: unknown;
  try { body = await response.json(); }
  catch (error) {
    if (init.signal?.aborted) throw error;
    throw new ResearchClientError(response.status, 'INVALID_RESPONSE', `The research service returned an unreadable response (${response.status}). Reopen the case before retrying a save.`);
  }
  if (!response.ok) {
    const error = body !== null && typeof body === 'object' && !Array.isArray(body) ? object(body, 'error') : {};
    throw new ResearchClientError(response.status, typeof error.code === 'string' && error.code.length <= 200 ? error.code : 'REQUEST_FAILED', typeof error.error === 'string' && error.error.trim() && error.error.length <= 20_000 ? error.error : `Research request failed (${response.status}). Reopen the case before retrying.`);
  }
  return body;
}
export async function listResearchCases(options: ResearchClientOptions = {}): Promise<ResearchCaseSummary[]> {
  return parseResearchCaseList(await request('/api/research', { method: 'GET', signal: options.signal }));
}
export async function getResearchCase(caseId: string, options: ResearchClientOptions = {}): Promise<ResearchCaseView> {
  const parsed = parseResearchCaseView(await request(`/api/research?caseId=${encodeURIComponent(id(caseId, 'caseId'))}`, { method: 'GET', signal: options.signal }));
  if (parsed.caseId !== caseId) return fail('caseId', 'the service returned a different case');
  return parsed;
}
async function applyResearch(input: ResearchApplicationRequest, options: ResearchClientOptions): Promise<ResearchCaseView> {
  const parsed = parseResearchCaseView(await request('/api/research', { method: 'POST', signal: options.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }));
  if (input.kind === 'update' && parsed.caseId !== input.caseId) return fail('caseId', 'the service returned a different case');
  return parsed;
}
export function startResearchCase(input: Omit<Extract<ResearchApplicationRequest, { kind: 'start' }>, 'kind'>, options: ResearchClientOptions = {}): Promise<ResearchCaseView> {
  return applyResearch({ ...input, kind: 'start' }, options);
}
export function updateResearchCase(input: Omit<Extract<ResearchApplicationRequest, { kind: 'update' }>, 'kind'>, options: ResearchClientOptions = {}): Promise<ResearchCaseView> {
  return applyResearch({ ...input, kind: 'update' }, options);
}

export function importResearchCase(input: Omit<Extract<ResearchApplicationRequest, { kind: 'import_case' }>, 'kind'>, options: ResearchClientOptions = {}): Promise<ResearchCaseView> {
  return applyResearch({ ...input, kind: 'import_case' }, options);
}

export function importResearchComparison(input: Omit<Extract<ResearchApplicationRequest, { kind: 'import_comparison' }>, 'kind'>, options: ResearchClientOptions = {}): Promise<ResearchCaseView> {
  return applyResearch({ ...input, kind: 'import_comparison' }, options);
}
