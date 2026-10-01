import type { NonEmpty } from '../cases/model';
import type { CaseCollection, UpdateRequest } from '../watchlists/model';

export const WORKSPACE_VERSION = 'contexttrail-inquiry-v1';
export interface Inquiry { kind: 'inquiry'; id: string; caseId: string; question: string }
export interface Subquestion { kind: 'subquestion'; id: string; question: string }
export interface Hypothesis { kind: 'hypothesis'; id: string; questionId: string; explanation: string }
/** UTF-16 offsets into the retained evidence text, or milliseconds relative to the media. */
export type ExactAnchor =
  | { kind: 'text'; start: number; quote: string }
  | { kind: 'time'; startMs: number; durationMs: number };
export interface FindingSupport { evidenceId: string; relationship: 'supports' | 'challenges' | 'context'; anchor: ExactAnchor }
export interface Finding {
  kind: 'finding'; id: string; questionId: string; text: string;
  assessment: { kind: 'source_statement' | 'operator_inference'; reviewer: string; rationale: string };
  support: NonEmpty<FindingSupport>;
}
export interface SavedFinding { finding: Finding; bindings: string[] }
export interface ResearchState { inquiry: Inquiry; subquestions: Subquestion[]; hypotheses: Hypothesis[]; findings: SavedFinding[] }
export interface InquiryWorkspace extends ResearchState {
  schemaVersion: typeof WORKSPACE_VERSION;
  revision: number;
  collection: CaseCollection;
  history: Array<{ revision: number; research: ResearchState }>;
  applied: Array<{ operationId: string; digest: string }>;
}
export type InquiryRequest =
  | { kind: 'start'; operationId: string; inquiry: Inquiry; createdAt: string }
  | { kind: 'update'; operationId: string; expectedRevision: number; caseUpdates: UpdateRequest; subquestions: Subquestion[]; hypotheses: Hypothesis[]; findings: Finding[] };
