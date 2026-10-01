import type { MaterialEdit, MaterialStore } from './materials';
import type { NonEmpty } from '../cases/model';
import type { CaseCollection, UpdateRequest } from '../watchlists/model';

export const WORKSPACE_VERSION = 'contexttrail-inquiry-v1';
export const WORKSPACE_VERSION_V2 = 'contexttrail-inquiry-v2';
export interface Inquiry { kind: 'inquiry'; id: string; caseId: string; question: string }
export interface Subquestion { kind: 'subquestion'; id: string; question: string }
export interface Hypothesis { kind: 'hypothesis'; id: string; questionId: string; explanation: string }
/** UTF-16 offsets into the retained evidence text, or milliseconds relative to the media. */
export type ExactAnchor =
  | { kind: 'text'; start: number; quote: string }
  | { kind: 'time'; startMs: number; durationMs: number }
  | { kind: 'image_region'; materialId: string; materialDigest: string; x: number; y: number; width: number; height: number }
  | { kind: 'table_cell'; materialId: string; materialDigest: string; row: number; column: number; value: string };
export interface FindingSupport { evidenceId: string; relationship: 'supports' | 'challenges' | 'context'; anchor: ExactAnchor }
export interface Finding {
  kind: 'finding'; id: string; questionId: string; text: string;
  assessment: { kind: 'source_statement' | 'operator_inference'; reviewer: string; rationale: string };
  support: NonEmpty<FindingSupport>;
}
export interface SavedFinding { finding: Finding; bindings: string[] }
export interface ResearchState { inquiry: Inquiry; subquestions: Subquestion[]; hypotheses: Hypothesis[]; findings: SavedFinding[] }
interface WorkspaceBase extends ResearchState {
  revision: number;
  collection: CaseCollection;
  history: Array<{ revision: number; research: ResearchState }>;
  applied: Array<{ operationId: string; digest: string }>;
}
export type InquiryWorkspace = WorkspaceBase & (
  | { schemaVersion: typeof WORKSPACE_VERSION }
  | { schemaVersion: typeof WORKSPACE_VERSION_V2; materials: MaterialStore }
);
export type InquiryRequest =
  | { kind: 'start'; operationId: string; inquiry: Inquiry; createdAt: string }
  | { kind: 'update'; operationId: string; expectedRevision: number; caseUpdates: UpdateRequest; subquestions: Subquestion[]; hypotheses: Hypothesis[]; findings: Finding[]; materialEdits?: MaterialEdit[] };
