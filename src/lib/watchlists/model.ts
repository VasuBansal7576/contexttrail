import type { CaseEvidence, CaseRecord, CaseRelation, NonEmpty } from '../cases/model';

export const COLLECTION_VERSION = 'contexttrail-collection-v1';
export interface Watchlist {
  id: string;
  scope: { kind: 'public_topic' | 'public_organization' | 'product' | 'incident' | 'research_question'; label: string; description: string };
  /** Literal phrases, not semantic matches. A match makes no truth judgment. */
  phrases: NonEmpty<string>;
  sourceHosts: NonEmpty<string>;
}
export interface EvidenceRef { caseId: string; evidenceId: string }
export interface ClaimRef { caseId: string; claimId: string }
export interface FamilyLink {
  id: string;
  familyId: string;
  from: ClaimRef;
  to: ClaimRef;
  relationship: 'paraphrase' | 'translation' | 'contradiction';
  assessment:
    | { status: 'reviewed'; reviewer: string; rationale: string }
    | { status: 'inferred'; method: string; rationale: string };
  support: NonEmpty<EvidenceRef>;
}
export interface SavedFamilyLink {
  link: FamilyLink;
  /** Content bindings prevent a revision from silently preserving apparent support. */
  bindings: { from: string; to: string; support: string[] };
}
export interface CaseCollection {
  schemaVersion: typeof COLLECTION_VERSION;
  cases: CaseRecord[];
  caseHistory: CaseRecord[];
  watchlists: Watchlist[];
  familyLinks: SavedFamilyLink[];
  relationReviewRequired: Array<{ caseId: string; relationId: string; reason: string }>;
}
export type CaseUpdate =
  | { kind: 'snapshot'; caseRecord: CaseRecord; removal: { status: 'confirmed'; reason: string } | { status: 'not_confirmed' } }
  | { kind: 'retrieval_failed'; caseId: string; reason: string };
export interface UpdateRequest {
  watchlists: Watchlist[];
  familyLinks: FamilyLink[];
  updates: CaseUpdate[];
}
export type EvidenceChange =
  | { kind: 'added'; evidenceId: string; after: string }
  | { kind: 'changed'; evidenceId: string; before: string; after: string }
  | { kind: 'removed'; evidenceId: string; before: string; reason: string };
export interface ChangeNotice {
  id: string;
  watchlistId: string;
  caseId: string;
  revision: number;
  changes: EvidenceChange[];
  affectedRelationIds: string[];
  evidence: Array<{ evidenceId: string; before: CaseEvidence | null; after: CaseEvidence | null }>;
  relationChanges: Array<{ relationId: string; before: CaseRelation | null; after: CaseRelation | null }>;
  limitation: string;
}
