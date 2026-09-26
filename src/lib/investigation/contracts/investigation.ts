/**
 * Public investigation/result types (spec §1.7, §3.7–3.8, §20.2, §22, §24, §33).
 *
 * Trace mode never carries a claim status. Claim-check mode returns exactly
 * one conservative status selected by deterministic policy — never by a model.
 */

import type {
  DatePrecision,
  DateStatus,
  EvidenceCandidate,
  ExcerptSource,
  IdentityEvidence,
  MediaRelationship,
  PublishedAtSource,
  ReportingOrigin,
  ReportingOriginStatus,
  RetrievalKind,
  RetrievalRecord,
} from "./evidence";
import type { EvidenceJudgment } from "./judgment";

export type InvestigationMode = "trace" | "claim_check";

/** §1.7B — the only four claim statuses. */
export type ClaimStatus =
  | "CONTEXT_CONFLICT"
  | "POSSIBLE_CONTEXT_CONFLICT"
  | "NO_CONFLICT_FOUND"
  | "INSUFFICIENT_EVIDENCE";

export type TraceHeadline =
  | "MEDIA_HISTORY_RECONSTRUCTED"
  | "LIMITED_MEDIA_HISTORY_FOUND";

/**
 * §20.2 — connector between adjacent items in the displayed dated sequence.
 * "uncertain" and "unexamined" both break asserted continuity; neither may be
 * presented as a resolved transition.
 */
export type TimelineConnectorKind =
  | "start"
  | "same_context"
  | "different_context"
  | "uncertain"
  | "unexamined";

export interface TimelineConnector {
  kind: TimelineConnectorKind;
  /** Occurrence this connector arrives from; null for the first item. */
  fromOccurrenceId: string | null;
}

/**
 * One entry in the evidence timeline. Dated, usable-precision core evidence
 * lives in `timeline`; everything else lives in `undatedEvidence` so that
 * unknown dates never enter the dated chronology.
 */
export interface TimelineItem {
  /** Stable occurrence identity; equals the evidence candidate id. */
  occurrenceId: string;
  evidenceId: string;
  /** ISO day-precision observed date; null when unknown/disputed. */
  observedAt: string | null;
  datePrecision: DatePrecision;
  dateStatus: DateStatus;
  title: string | null;
  sourceUrl: string;
  canonicalUrl: string;
  domain: string;
  registrableDomain: string;
  mediaRelationship: MediaRelationship | null;
  /** Segment this item belongs to; null when segmentation was not resolved. */
  contextSegmentIndex: number | null;
  /** Connector arriving at this item; null when not part of the compared run. */
  incomingConnector: TimelineConnector | null;
  /** True on the later endpoint of the first strong DIFFERENT_CONTEXT edge. */
  isFirstObservedDivergencePoint: boolean;
  /* ---- display/provenance surface (§3.11, §3.14, §34) ---------------- */
  /** Retrieved image for this occurrence (result image else thumbnail). */
  imageUrl: string | null;
  /** Bounded excerpt actually used for classification/display (§18.3). */
  excerpt: string | null;
  excerptSource: ExcerptSource;
  /** Which source supplied the resolved publication date (§19.2). */
  publishedAtSource: PublishedAtSource;
  /** Reporting-origin status for badge display (§13). */
  reportingOriginStatus: ReportingOriginStatus;
  /** Strong context-relationship label from Jev when decisive, else null. */
  contextLabel:
    | "SAME_CONTEXT"
    | "DIFFERENT_CONTEXT"
    | "HISTORICAL_REFERENCE"
    | "UNCLEAR"
    | null;
  serpPosition: number | null;
  /** ISO timestamp of the first retrieval record for this candidate. */
  retrievedAt: string | null;
  /** Retrieval kind that produced this candidate (§34 "retrieval engine"). */
  engine: RetrievalKind | null;
  /** Provider result type of the first retrieval record. */
  resultType: string | null;
  /** Jev model version when classified (§34), else null. */
  jevModel: string | null;
}

/** §20.2 / §22 — the first observed context divergence marker. */
export interface Divergence {
  fromOccurrenceId: string;
  toOccurrenceId: string;
  /** Observed date of the later occurrence — never a guessed change time. */
  observedAt: string;
  earlierTransitionsUnresolved: boolean;
}

export interface ComparisonCoverage {
  /** Dated core occurrences eligible for pairwise comparison. */
  eligible: number;
  /** Occurrences actually selected into the compared sequence (max 8). */
  selected: number;
  /** Adjacent pairs that produced a decisive comparison. */
  comparedPairs: number;
}

/** §33 — deterministic takeaway codes; UI renders fixed copy per code. */
export type TakeawayCode =
  | "temporal_conflict"
  | "location_conflict"
  | "historical_reuse"
  | "no_current_media_corroboration";

export interface Takeaway {
  code: TakeawayCode;
  /** Evidence IDs supporting this takeaway; a takeaway never stands alone. */
  evidenceIds: string[];
}

/**
 * Deterministic limitation reason codes surfaced in "Evidence limits" and
 * Analysis (§3.8, §29). Bounded vocabulary — no generated prose.
 */
export type LimitationCode =
  | "exact_match_retrieval_unavailable"
  | "no_exact_occurrences_returned"
  | "web_context_unavailable"
  | "news_unavailable"
  | "about_this_image_unavailable"
  | "semantic_classification_unavailable"
  | "semantic_classification_partial"
  | "reporting_origins_unresolved"
  | "unverified_visual_leads_present"
  | "near_match_verifier_disabled"
  | "page_fetch_partial_failure"
  | "insufficient_dated_occurrences"
  | "comparison_coverage_incomplete"
  | "claim_date_unresolved"
  | "disputed_dates_present"
  | "unknown_dates_present";

export interface SharedResultMetrics {
  /** Earliest usable observed date among core occurrences; never "original". */
  earliestObservedOccurrence: string | null;
  /** Distinct registrable domains among core visual occurrences. Not "independent sources". */
  sourceDomainCount: number;
  /** Resolved reporting-origin groups among core occurrences. */
  reportingGroupCount: number;
  /** Remaining core candidates with unresolved reporting origin. */
  unresolvedOriginCount: number;
  /** Null unless the displayed dated run has complete, decisive comparisons. */
  contextSegmentCount: number | null;
  firstObservedContextDivergence: Divergence | null;
  comparisonCoverage: ComparisonCoverage;
  limitations: LimitationCode[];
  undatedEvidence: TimelineItem[];
  timeline: TimelineItem[];
}

/** §22 — Trace-mode result. Never carries claim statuses. */
export interface TraceResult extends SharedResultMetrics {
  mode: "trace";
  headline: TraceHeadline;
}

/** §21 — Claim-check result: one conservative deterministic status. */
export interface ClaimResult extends SharedResultMetrics {
  mode: "claim_check";
  status: ClaimStatus;
  claim: string;
  /** Parsed claim date (ISO day) or null when absent/ambiguous. */
  claimDate: string | null;
  /**
   * Mandatory caveat flag (§21.4): when true the UI must show
   * "This does not prove the claim is true." Always true for
   * NO_CONFLICT_FOUND; never meaningful to omit.
   */
  doesNotProveClaimTrue: boolean;
  /** §29 — false when the claim-side Google Search request failed. */
  webContextAvailable: boolean;
  takeaways: Takeaway[];
}

export type InvestigationResult = TraceResult | ClaimResult;

/** Public projection of EvidenceJudgment for `evidence.classified` events. */
export type PublicJudgment = EvidenceJudgment;

/**
 * Public projection of EvidenceCandidate for `evidence.discovered` events
 * (§24.2). Preserves raw identity, retrieval, reporting-origin, and
 * uncertainty fields (§10–11); full page text is replaced by the bounded
 * excerpt actually used for classification (§18.3).
 */
export interface PublicEvidenceCandidate {
  id: string;
  retrievalKind: RetrievalKind;
  sourceUrl: string;
  canonicalUrl: string;
  domain: string;
  registrableDomain: string;
  title: string | null;
  snippet: string | null;
  serpPosition: number | null;
  serpSearchId: string | null;
  publishedAt: string | null;
  publishedAtSource: PublishedAtSource;
  datePrecision: DatePrecision;
  dateStatus: DateStatus;
  thumbnailUrl: string | null;
  resultImageUrl: string | null;
  mediaRelationship: MediaRelationship | null;
  identityEvidence: IdentityEvidence;
  reportingOrigin: ReportingOrigin;
  excerptSource: ExcerptSource;
  excerpt: string | null;
  retrievals: RetrievalRecord[];
}

export function toPublicCandidate(
  c: EvidenceCandidate,
  excerpt: string | null,
): PublicEvidenceCandidate {
  const { pageText: _pageText, judgment: _judgment, ...rest } = c;
  return { ...rest, excerpt };
}

/** §24 — parsed request input for POST /api/investigate. */
export interface InvestigationInput {
  /** Optional user claim; absent/empty means Trace mode. */
  claim: string | null;
  /** IANA timezone from the browser. */
  timezone: string;
  /** Browser locale. */
  locale: string;
  /** Client-preprocessed image bytes (<= ~450 KB client target). */
  media: Uint8Array;
}

export function modeForInput(input: Pick<InvestigationInput, "claim">): InvestigationMode {
  return input.claim != null && input.claim.trim().length > 0
    ? "claim_check"
    : "trace";
}
