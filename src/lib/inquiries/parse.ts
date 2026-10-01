import { list, object, parseCollection, parseRequest, unique } from '../watchlists/parse';
import { WORKSPACE_VERSION, type ExactAnchor, type Finding, type Hypothesis, type Inquiry, type InquiryRequest, type InquiryWorkspace, type ResearchState, type SavedFinding, type Subquestion } from './model';
function text(v: unknown): string { if (typeof v !== 'string' || !v.trim() || v.length > 20000) throw new Error('Expected nonempty bounded text'); return v; }
function id(v: unknown): string { const s = text(v); if (s.length > 256) throw new Error('ID exceeds 256 characters'); return s; }
function integer(v: unknown, min = 0): number { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min) throw new Error('Expected safe integer'); return v; }
function choice<const T extends string>(v: unknown, choices: readonly T[]): T { for (const c of choices) if (v === c) return c; throw new Error('Unsupported inquiry value'); }
function inquiry(v: unknown): Inquiry { const o = object(v); return { kind: choice(o.kind, ['inquiry']), id: id(o.id), caseId: id(o.caseId), question: text(o.question) }; }
function subquestion(v: unknown): Subquestion { const o = object(v); return { kind: choice(o.kind, ['subquestion']), id: id(o.id), question: text(o.question) }; }
function hypothesis(v: unknown): Hypothesis { const o = object(v); return { kind: choice(o.kind, ['hypothesis']), id: id(o.id), questionId: id(o.questionId), explanation: text(o.explanation) }; }
function anchor(v: unknown): ExactAnchor { const o = object(v), kind = choice(o.kind, ['text', 'time']); return kind === 'text' ? { kind, start: integer(o.start), quote: text(o.quote) } : { kind, startMs: integer(o.startMs), durationMs: integer(o.durationMs, 1) }; }
export function parseFinding(v: unknown): Finding {
  const o = object(v), a = object(o.assessment);
  const [first, ...rest] = list(o.support, value => { const s = object(value); return { evidenceId: id(s.evidenceId), relationship: choice(s.relationship, ['supports', 'challenges', 'context']), anchor: anchor(s.anchor) }; });
  if (!first) throw new Error('A finding requires exact evidence');
  return { kind: choice(o.kind, ['finding']), id: id(o.id), questionId: id(o.questionId), text: text(o.text), assessment: { kind: choice(a.kind, ['source_statement', 'operator_inference']), reviewer: text(a.reviewer), rationale: text(a.rationale) }, support: [first, ...rest] };
}
function digest(v: unknown): string { const s = text(v); if (!/^sha256:[a-f0-9]{64}$/.test(s)) throw new Error('Invalid evidence digest'); return s; }
function savedFinding(v: unknown): SavedFinding { const o = object(v), finding = parseFinding(o.finding), bindings = list(o.bindings, digest); if (bindings.length !== finding.support.length) throw new Error('Missing finding bindings'); return { finding, bindings }; }
function research(v: unknown): ResearchState {
  const o = object(v), result = { inquiry: inquiry(o.inquiry), subquestions: unique(list(o.subquestions, subquestion), s => s.id), hypotheses: unique(list(o.hypotheses, hypothesis), h => h.id), findings: unique(list(o.findings, savedFinding), f => f.finding.id) };
  unique([result.inquiry.id, ...result.subquestions.map(s => s.id), ...result.hypotheses.map(h => h.id), ...result.findings.map(f => f.finding.id)], s => s);
  const questions = new Set([result.inquiry.id, ...result.subquestions.map(s => s.id)]);
  for (const entry of [...result.hypotheses, ...result.findings.map(f => f.finding)]) if (!questions.has(entry.questionId)) throw new Error('Missing question reference');
  return result;
}
export function parseWorkspace(v: unknown): InquiryWorkspace {
  const o = object(v), result = { schemaVersion: choice(o.schemaVersion, [WORKSPACE_VERSION]), revision: integer(o.revision, 1), ...research(o), collection: parseCollection(o.collection), history: list(o.history, value => { const h = object(value); return { revision: integer(h.revision, 1), research: research(h.research) }; }), applied: unique(list(o.applied, value => { const a = object(value); return { operationId: id(a.operationId), digest: digest(a.digest) }; }), a => a.operationId) };
  if (!result.collection.cases.some(c => c.id === result.inquiry.caseId)) throw new Error('Missing inquiry case');
  return result;
}
export function parseInquiryRequest(v: unknown): InquiryRequest {
  const o = object(v), kind = choice(o.kind, ['start', 'update']), operationId = id(o.operationId);
  if (kind === 'start') return { kind, operationId, inquiry: inquiry(o.inquiry), createdAt: text(o.createdAt) };
  return { kind, operationId, expectedRevision: integer(o.expectedRevision, 1), caseUpdates: parseRequest(o.caseUpdates), subquestions: unique(list(o.subquestions, subquestion), s => s.id), hypotheses: unique(list(o.hypotheses, hypothesis), h => h.id), findings: unique(list(o.findings, parseFinding), f => f.id) };
}
