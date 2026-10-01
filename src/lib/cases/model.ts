/** Persisted case v1. References describe evidence; they do not fetch or retain media. */
export const CASE_SCHEMA_VERSION = 'contexttrail-case-v1';
export type NonEmpty<T> = [T, ...T[]];

export type Assessment =
  | { status: 'observed'; evidenceIds: NonEmpty<string>; method: string }
  | { status: 'inferred'; evidenceIds: NonEmpty<string>; method: string; rationale: string }
  | { status: 'unknown'; reason: string };

/** A reported publication date is not a verified event date or original upload. */
export interface DateObservation {
  value: string;
  precision: 'instant' | 'day' | 'month' | 'year';
  source: {
    kind: 'page_json_ld' | 'page_meta' | 'page_time' | 'search_metadata' | 'retrieval_log' | 'user_statement';
    url: string | null;
    /** Value retained by the source adapter, which may already be normalized. */
    recordedValue: string;
  };
}
export type SourcedDate =
  | { status: 'observed'; observation: DateObservation }
  | { status: 'inferred'; observation: DateObservation; rationale: string }
  | { status: 'disputed'; observations: DateObservation[]; reason: string }
  | { status: 'unknown'; reason: string };

export interface Provenance {
  method: 'user_submission' | 'retrieval' | 'page_extraction' | 'model_assessment' | 'manual';
  toolVersion: string | null;
  capturedAt: string | null;
  retrievedAt: string | null;
  rights: 'unknown' | 'user_provided' | 'public_reference';
  /** Public access alone is never permission to retain a copy. */
  retention: 'reference_only' | 'not_retained';
  contentHash: string | null;
}

export type MediaSpan =
  | { kind: 'whole' }
  | { kind: 'time'; startMs: number; durationMs: number };
export type AssetLocation =
  | { kind: 'url'; url: string }
  | { kind: 'not_retained' };
interface AssetBase {
  id: string;
  location: AssetLocation;
  provenance: Provenance;
}
export type MediaAsset =
  | (AssetBase & { kind: 'image' })
  | (AssetBase & { kind: 'video'; durationMs: number | null })
  | (AssetBase & { kind: 'audio'; durationMs: number | null });

export interface TextClaim {
  id: string;
  kind: 'text';
  text: string;
  language: string | null;
  provenance: Provenance;
}

export interface CaseEvidence {
  id: string;
  sourceUrl: string;
  title: string | null;
  content:
    | { kind: 'text'; text: string; attribution: 'page_quote' | 'search_snippet' | 'classification_context' }
    | { kind: 'media'; assetId: string; span: MediaSpan }
    | { kind: 'reference' };
  publicationDate: SourcedDate;
  provenance: Provenance;
}

/** Unknown identity remains a candidate occurrence, never a confirmed sighting. */
export interface MediaOccurrence {
  id: string;
  assetId: string;
  span: MediaSpan;
  sourceEvidenceId: string;
  identity: Assessment;
}

export type CaseRelation = {
  id: string;
  assessment: Assessment;
} & (
  | { kind: 'evidence_claim'; evidenceId: string; claimId: string; relationship: 'supports' | 'challenges' | 'context' }
  | { kind: 'claim_claim'; fromClaimId: string; toClaimId: string; relationship: 'paraphrase' | 'translation' | 'contradiction' }
  | { kind: 'occurrence_occurrence'; fromOccurrenceId: string; toOccurrenceId: string; relationship: 'repost' | 'quotation' | 'source_link' | 'similar_media' }
);

export interface CaseRecord {
  schemaVersion: typeof CASE_SCHEMA_VERSION;
  id: string;
  revision: number;
  /** Case creation, separate from source publication and retrieval time. */
  createdAt: string;
  claims: TextClaim[];
  assets: MediaAsset[];
  evidence: CaseEvidence[];
  occurrences: MediaOccurrence[];
  relations: CaseRelation[];
  coverage: {
    scope: 'retrieved_evidence';
    completeness: 'partial' | 'unknown';
    omittedEvidenceCount: number;
    originalPublication: { status: 'unknown'; reason: string };
    limitations: string[];
    searches: Array<{ engine: string; attempted: number; returned: number; retained: number; searchId: string | null }>;
  };
}
