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
  IdentityBasis,
  IdentityEvidence,
  JevDistributions,
  MediaRelationship,
  PageMetadata,
  PublishedAtSource,
  ReportingOrigin,
  ReportingOriginBasis,
  ReportingOriginStatus,
  RetrievalKind,
  RetrievalRecord,
} from "./evidence";
import type {
  ClaimRelation,
  ContextRelation,
  EvidenceJudgment,
  PairwiseContextJudgment,
} from "./judgment";

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
  /** Resolved origin group when shared/separate, else null. */
  reportingOriginGroupId: string | null;
  /** Why this origin status was assigned — bounded reason codes (§13). */
  reportingOriginBasis: ReportingOriginBasis[];
  /** How the media identity was established (§11), for inspection. */
  identityBasis: IdentityBasis;
  /** Identity method plus the verifier/config identifier that produced
   *  it — null supportId when no verifier ran (§13.3). */
  identityBasisDetail: { method: IdentityBasis; supportId: string | null } | null;
  /** Publication-date provenance — the selected value plus every rejected
   *  JSON-LD candidate and why, so the date stays inspectable (§19.2). */
  dateProvenance: {
    value: string | null;
    precision: DatePrecision;
    source: PublishedAtSource;
    entityBinding: string | null;
    rejectedCandidates: Array<{ value: string; reason: string }>;
  };
  /** Reporting-origin provenance — status, group membership, the exact
   *  retrieved attribution spans, and the grouping basis codes (§13.1). */
  originSupport: {
    status: ReportingOriginStatus;
    groupId: string | null;
    attributionSpans: Array<{ text: string; relation: string }>;
    groupingReason: ReportingOriginBasis[];
  };
  /** Human-readable attribution for the displayed excerpt — e.g.
   *  "Extracted page excerpt", "Search snippet",
   *  "Composite page excerpt (title/snippet/body)". Null for raw labels. */
  displayAttribution: string | null;
  /** The bounded composite text sent to the classifier — keyed separately
   *  from `excerpt` and never rendered as a quote (§13.4, §18.3). */
  classificationContext: string | null;
  /** §14 comparison selection — whether this item entered the compared
   *  run and which adjacent pair ids it was compared in. */
  comparisonSelection: { selected: boolean; comparedPairIds: string[] };
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
  /** §34 — the actual provider search ids this occurrence was retrieved
   *  under (deduped, retrieval order); empty when none were reported —
   *  identifiers are never invented. */
  searchIds: string[];
  /** §34 — the verified per-question Jev distributions behind this
   *  item's classification; null unless a verified pinned-model
   *  judgment exists. Never unverified or synthesized numbers. */
  jevDistributions: JevDistributions | null;
  /** §18.2 — source-bound JSON-LD/OpenGraph metadata retained by the
   *  deep read; null when none was retained. */
  pageMetadata: PageMetadata | null;
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
  /** Adjacent pairs for which a pairwise comparison was performed. */
  comparedPairs: number;
  /** Dated core items actually displayed in the chronology — includes
   *  month/year-precision items ordered as intervals (§20.2). */
  displayedDatedCore: number;
  /** Ordered ids of the adjacent pairs actually compared (§14). */
  comparedPairIds: string[];
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

/** One retrieval operation row — what was attempted, what returned, and
 *  how much survived into the investigated pool (§34 "request/operation
 *  log"). Counts only; no params, no provider payloads. */
export interface RequestLogEntry {
  engine: string;
  attempted: number;
  returned: number;
  retained: number;
  durationMs: number;
  /** §34 — the actual SerpApi search id for this attempt; null when the
   *  provider returned none. Identifiers only, never payloads. */
  searchId: string | null;
}

/** One resolved reporting-origin group: its members and the basis codes
 *  that grouped them (§13). Unresolved candidates never join a group —
 *  they are listed separately in `unresolvedCandidateIds`. */
export interface ReportingGroupSummary {
  groupId: string;
  memberIds: string[];
  reason: ReportingOriginBasis[];
}

/** One deterministic policy gate evaluation — the gate, whether it
 *  passed, a bounded detail string, and the evidence ids it rested on
 *  (§21). Never generated prose. */
export interface PolicyReason {
  gate: string;
  passed: boolean;
  detail: string;
  supportIds: string[];
}

/** §34 — one evaluated adjacent comparison in the displayed order. The
 *  distribution is the actual pairwise Jev answer — null when the pair
 *  was unexamined (interval overlap, budget, deadline); never invented. */
export interface ComparisonRecord {
  pairId: string;
  fromOccurrenceId: string;
  toOccurrenceId: string;
  connector: Exclude<TimelineConnectorKind, "start">;
  distribution: PairwiseContextJudgment | null;
}

/** §23 — the public projection of the internal provenance graph that
 *  drives both the timeline and the result summary. Node/edge ids are
 *  typed; an unobserved relation is reported as null/[], never
 *  fabricated. */
export interface ProvenanceProjection {
  /** The submitted media asset node (M). */
  media: { id: "media" };
  /** M → O edges: one per investigated occurrence. */
  occurrences: Array<{
    id: string;
    /** O → S edge target (source-domain node id). */
    domainId: string;
    /** O → K edge target; null when continuity was unresolved or the
     *  occurrence was not in the compared run. */
    segmentId: string | null;
    role: "core" | "lead" | "contextual";
    dated: boolean;
  }>;
  /** O → S: one domain node per registrable domain observed. */
  sourceDomains: Array<{
    id: string;
    domain: string;
    occurrenceIds: string[];
  }>;
  /** O → K: asserted context segments only. */
  contextSegments: Array<{
    id: string;
    index: number;
    occurrenceIds: string[];
  }>;
  /** DIVERGES_TO edges — real decisive divergences between occurrences.
   *  A segment endpoint is null when that side's continuity was
   *  unresolved: the verified local divergence is preserved, and no
   *  segment or earlier continuity is invented (§23/G2). */
  divergenceEdges: Array<{
    pairId: string;
    fromOccurrenceId: string;
    toOccurrenceId: string;
    fromSegmentId: string | null;
    toSegmentId: string | null;
    observedAt: string;
    firstObserved: boolean;
    earlierTransitionsUnresolved: boolean;
  }>;
  /** C → KQ claim context node; null in Trace mode. */
  claimContext: {
    claim: string;
    claimDate: string | null;
    claimDatePrecision: DatePrecision;
    /** C → KQ → O/K claim comparison evidence — one record per verified
     *  claim/context question the model answered about this claim,
     *  carrying the actual distribution. Distinct from
     *  occurrence↔occurrence pairwise records (§23/G1). */
    comparisons: Array<{
      occurrenceId: string;
      /** O → K edge target; null when segment continuity unresolved. */
      segmentId: string | null;
      question: "context_relation" | "claim_relation";
      distribution: ContextRelation | ClaimRelation;
    }>;
    /** KQ → K "compared with" edges — derived solely from the real
     *  comparison records above, never from pairwise judgments. */
    comparedSegmentIds: string[];
  } | null;
}

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
  /** Per-operation retrieval accounting (§34) — attempted/returned/
   *  retained counts per engine/slot. */
  requestLog: RequestLogEntry[];
  /** Resolved reporting-origin groups among core occurrences (§13). */
  reportingGroups: ReportingGroupSummary[];
  /** Core candidates whose reporting origin stayed unresolved (§13). */
  unresolvedCandidateIds: string[];
  /** §34 — every evaluated pairwise comparison in displayed order, with
   *  the actual distribution; empty when none ran. */
  comparisons: ComparisonRecord[];
  /** §23 — the typed public projection of the provenance graph behind
   *  this result's timeline and summary. */
  provenance: ProvenanceProjection;
  limitations: LimitationCode[];
  undatedEvidence: TimelineItem[];
  /** Dated core occurrences (EXACT_MATCH / verified NEAR_MATCH) only. */
  timeline: TimelineItem[];
  /** Dated non-core visual leads — supporting, never core. */
  supportingEvidence: TimelineItem[];
  /** Dated contextual web/news evidence with no media identity. */
  contextualEvidence: TimelineItem[];
}

/** §22 — Trace-mode result. Never carries claim statuses. */
export interface TraceResult extends SharedResultMetrics {
  mode: "trace";
  headline: TraceHeadline;
}

/** Bounded reason codes for the deterministic claim status (§21). */
export type ClaimStatusBasis =
  | "qualifying_conflicts_corroborated"
  | "single_qualifying_conflict"
  | "conflicts_without_corroboration"
  | "corroborated_no_conflict"
  | "insufficient_qualifying_evidence";

/** §21 — Claim-check result: one conservative deterministic status. */
export interface ClaimResult extends SharedResultMetrics {
  mode: "claim_check";
  status: ClaimStatus;
  /** Why the status was assigned — deterministic codes, not prose. */
  statusBasis: ClaimStatusBasis[];
  /** Every gate the deterministic policy evaluated, pass or fail, with
   *  the evidence ids it rested on (§21). */
  policyReasons: PolicyReason[];
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
