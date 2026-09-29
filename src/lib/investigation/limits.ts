/**
 * Frozen numeric limits: search budgets (§7), concurrency (§27),
 * timeouts (§28), retention/deep-read/divergence bounds (§10.3, §14, §18, §20).
 * These are hard application invariants — no code may silently exceed them.
 */

/** §7.1 — Claim-check: 5 base searches + at most 1 adaptive expansion. */
export const CLAIM_BASE_SEARCHES = 5;
/** §7.2 — Trace: 3 base searches + at most 1 adaptive expansion. */
export const TRACE_BASE_SEARCHES = 3;
/** Both modes: exactly one optional adaptive slot, never more. */
export const MAX_ADAPTIVE_SEARCHES = 1;
export const CLAIM_MAX_SEARCHES = CLAIM_BASE_SEARCHES + MAX_ADAPTIVE_SEARCHES; // 6
export const TRACE_MAX_SEARCHES = TRACE_BASE_SEARCHES + MAX_ADAPTIVE_SEARCHES; // 4

/** The image upload is bounded to one attempt and is not a search request. */
export const MAX_IMAGE_UPLOAD_ATTEMPTS = 1;

/** §27 — bounded parallelism. */
export const CONCURRENCY = {
  serpapiSearch: 4,
  jev: 8,
  pageFetch: 5,
  resultImageVerificationFetch: 4,
} as const;

/** §28 — per-operation timeouts in milliseconds. */
export const TIMEOUTS = {
  serpapiSearchMs: 12_000,
  serpapiImageUploadMs: 8_000,
  jevMs: 8_000,
  pageFetchMs: 5_000,
  imageFetchMs: 3_000,
  /** Whole-investigation hard cutoff; finalize with available evidence. */
  investigationDeadlineMs: 55_000,
} as const;

/** §14 — per-kind retention before classification. */
export const RETENTION_CAPS = {
  lens_exact: 8,
  lens_visual: 8,
  lens_about_image: 5,
  google_search: 5,
  google_news: 5,
} as const;

/** §14 — max candidates sent to Jev after URL deduplication. */
export const MAX_JEV_CANDIDATES = 24;

/** §10.3 — at most eight retrieved images get the identity screen. */
export const MAX_IDENTITY_SCREENED_IMAGES = 8;
/** §10.3 — dHash Hamming distance that makes an image *eligible* only. */
export const DHASH_HAMMING_ELIGIBILITY = 8;
export const RESULT_IMAGE_FETCH_MAX_BYTES = 1_048_576; // 1 MB

/** §18 — deep-read path. */
export const MAX_DEEP_READ_PAGES = 5;
export const PAGE_FETCH_MAX_BYTES = 2_097_152; // 2 MB
export const PAGE_FETCH_MAX_REDIRECTS = 3;
export const EXCERPT_MAX_CHARS = 8_000;

/** §20 — pairwise divergence works on at most 8 dated core occurrences. */
export const MAX_DIVERGENCE_OCCURRENCES = 8;

/** §19.3 — timezone buffer for temporal-conflict checks. */
export const TEMPORAL_CONFLICT_BUFFER_MS = 24 * 60 * 60 * 1_000;
