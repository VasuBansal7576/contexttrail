/**
 * Raw evidence contract (spec §11) plus media-relationship, identity,
 * reporting-origin, and date-uncertainty fields (§10).
 *
 * These types are the evidence-truth surface of the product. No field may be
 * silently dropped or "helpfully" filled in: unknown stays unknown, disputed
 * stays disputed, and unverified visual matches stay VISUAL_LEAD.
 */

export type RetrievalKind =
  | "lens_exact"
  | "lens_visual"
  | "lens_about_image"
  | "google_search"
  | "source_link"
  | "google_news";

/**
 * §10.2 — every visual candidate has one of these relationships.
 * EXACT_MATCH: provider-reported by a validated Lens exact_matches collection.
 * NEAR_MATCH:  passed the stronger local spatial identity gate (§10.3).
 * VISUAL_LEAD: everything else; may guide investigation but never
 *              independently establishes provenance.
 */
export type MediaRelationship = "EXACT_MATCH" | "NEAR_MATCH" | "VISUAL_LEAD";

export type IdentityBasis =
  | "lens_exact_collection"
  | "local_spatial_verification"
  | "unverified"
  /** Contextual web/news evidence — never claimed as a media sighting. */
  | "contextual";

export type VerificationStatus =
  | "provider_reported"
  | "passed"
  | "failed"
  | "ambiguous"
  | "unavailable";

export interface IdentityEvidence {
  basis: IdentityBasis;
  /** Hamming distance of the 64-bit dHash screen; null when not screened. */
  hashDistance: number | null;
  /** Pinned spatial-verifier version; required for NEAR_MATCH. */
  verifierVersion: string | null;
  /** Pinned verifier configuration ID; required for NEAR_MATCH. */
  verifierConfigId: string | null;
  verificationStatus: VerificationStatus;
  /** Measured comparison values for the spatial verifier; required for NEAR_MATCH. */
  comparisonMetrics: Record<string, number> | null;
}

/**
 * §13 — reporting-origin screening. `separate_origin_evidenced` requires
 * retrieved, inspectable attribution/source material; domain differences or
 * model probabilities alone can never set it.
 */
export type ReportingOriginStatus =
  | "separate_origin_evidenced"
  | "shared_origin"
  | "unresolved";

/**
 * Bounded reason codes for reporting-origin decisions (§13).
 * These are reason codes, not generated explanations.
 */
export type ReportingOriginBasis =
  | "explicit_syndication_attribution"
  | "common_originating_report"
  | "article_text_duplication"
  | "shared_named_provider"
  | "separate_reporting_evidence"
  | "origin_unresolved_missing_evidence";

export interface ReportingOrigin {
  groupId: string;
  status: ReportingOriginStatus;
  basis: ReportingOriginBasis[];
  evidenceIds: string[];
  /** Inspector-visible attribution spans that produced this status —
   *  the exact retrieved sentences and how they were used (§13). */
  attributionSpans: Array<{ text: string; relation: string }>;
}

export type PublishedAtSource =
  | "page_json_ld"
  | "page_meta"
  | "page_time"
  | "serpapi"
  | null;

export type DatePrecision = "day" | "month" | "year" | "unknown";
export type DateStatus = "usable" | "disputed" | "unknown";

export type ExcerptSource = "page_text" | "page_composite" | "serp_snippet" | null;

export interface RetrievalRecord {
  kind: RetrievalKind;
  searchId: string | null;
  resultType: string;
  retrievedAt: string;
}

import type { EvidenceJudgment } from "./judgment";

/**
 * §18.2 — descriptive metadata retained from a JSON-LD publication entity
 * that binds to the fetched page (page_url / main_entity / root_entity).
 * Bounded allowlist: trimmed/capped strings and name lists only — never
 * full subtrees, and never from contradicted or unbound nested entities.
 */
export interface JsonLdEntityMetadata {
  /** Which page-binding tier this entity satisfied. */
  binding: "page_url" | "main_entity" | "root_entity";
  types: string[];
  headline: string | null;
  author: string[];
  publisher: string | null;
  description: string | null;
}

/** §18.2 — source-bound page metadata retained from a deep read. */
export interface PageMetadata {
  jsonLd: JsonLdEntityMetadata[];
  openGraph: Record<string, string>;
}

/** §34 — the verified per-question Jev distributions behind a judgment.
 *  Present only when `judgment` exists — construction requires a verified
 *  pinned-model identity, so these are never invented or unverified. */
export interface JevDistributions {
  relevance: number;
  pageRole: EvidenceJudgment["pageRole"];
  contextRelation: EvidenceJudgment["contextRelation"];
  claimRelation: EvidenceJudgment["claimRelation"];
  locationRelation: EvidenceJudgment["locationRelation"];
}

/**
 * §11 — the raw evidence candidate. Retain disputed-date candidates and the
 * reason for rejection; never promote a month/year date to a day; never let a
 * hash-only check claim NEAR_MATCH; never let a navigation flag claim
 * EXACT_MATCH.
 */
export interface EvidenceCandidate {
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

  thumbnailUrl: string | null;
  resultImageUrl: string | null;

  mediaRelationship: MediaRelationship | null;
  identityEvidence: IdentityEvidence;

  reportingOrigin: ReportingOrigin;

  datePrecision: DatePrecision;
  dateStatus: DateStatus;
  excerptSource: ExcerptSource;
  retrievals: RetrievalRecord[];

  /** Which JSON-LD binding tier produced the selected page date —
   *  "page_url" | "main_entity" | "root_entity" — else null. */
  dateEntityBinding?: string | null;
  /** JSON-LD dates rejected for this page, with binding reasons (§19.2). */
  rejectedDateCandidates?: Array<{ value: string; reason: string }>;
  /** Source-bound JSON-LD/OpenGraph metadata retained by the deep read
   *  (§18.2); null until a page is fetched, absent on failure. */
  pageMetadata?: PageMetadata | null;
  pageText: string | null;

  judgment: EvidenceJudgment | null;
}
