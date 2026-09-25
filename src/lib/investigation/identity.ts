/**
 * Media-relationship policy (spec §6.3, §6.4, §10.2, §10.3, §29).
 *
 * The identity invariants are enforced here, not assumed:
 * - EXACT_MATCH requires a validated Lens exact_matches occurrence entry
 *   (basis `lens_exact_collection`, status `provider_reported`). A visual
 *   result's `exact_matches: true` flag or `serpapi_exact_matches_link` is a
 *   navigation signal only — it never confers exact-occurrence identity.
 * - NEAR_MATCH requires the pinned local spatial verifier to have passed
 *   with recorded metrics. A hash-distance pass alone never qualifies.
 * - Everything else stays VISUAL_LEAD: it may guide investigation but does
 *   not independently establish provenance, and is never promoted to
 *   compensate for a failed exact-match request.
 */

import type {
  EvidenceCandidate,
  IdentityEvidence,
  MediaRelationship,
  VerificationStatus,
} from "./contracts/evidence";
import {
  DHASH_HAMMING_ELIGIBILITY,
  MAX_IDENTITY_SCREENED_IMAGES,
} from "./limits";

export { MAX_IDENTITY_SCREENED_IMAGES, DHASH_HAMMING_ELIGIBILITY };

/** §6.3 — distinguishable states of the dedicated exact-match retrieval. */
export type ExactMatchCollectionState =
  | "validated_occurrences"
  | "empty"
  | "malformed"
  | "unavailable";

export interface ExactMatchCollectionResult {
  state: ExactMatchCollectionState;
  /** Raw occurrence entries that carried a usable link. */
  entries: Array<{ link: string; raw: Record<string, unknown> }>;
}

/**
 * Classify a dedicated Lens type=exact_matches response.
 * - `requestFailed` -> "unavailable" ("Exact-match retrieval unavailable").
 * - missing/non-array collection -> "malformed".
 * - empty or no entries with a usable link -> "empty" ("No exact occurrences
 *   returned"). These stay distinct per §29.
 */
export function classifyExactMatchCollection(input: {
  requestFailed: boolean;
  collection: unknown;
}): ExactMatchCollectionResult {
  if (input.requestFailed) {
    return { state: "unavailable", entries: [] };
  }
  if (!Array.isArray(input.collection)) {
    return { state: "malformed", entries: [] };
  }
  const entries = input.collection
    .filter(
      (e): e is Record<string, unknown> =>
        typeof e === "object" && e !== null,
    )
    .flatMap((raw) => {
      const link =
        typeof raw.link === "string"
          ? raw.link
          : typeof raw.source === "string"
            ? raw.source
            : null;
      return link === null || link === "" ? [] : [{ link, raw }];
    });
  if (entries.length === 0) {
    return { state: input.collection.length === 0 ? "empty" : "malformed", entries: [] };
  }
  return { state: "validated_occurrences", entries };
}

/** Local identity-verification outcome for one retrieved image (§10.3). */
export interface LocalVerification {
  hashDistance: number | null;
  verificationStatus: Exclude<VerificationStatus, "provider_reported">;
  verifierVersion: string | null;
  verifierConfigId: string | null;
  comparisonMetrics: Record<string, number> | null;
}

export interface MediaRelationshipInput {
  /** True only for validated entries of a Lens exact_matches collection. */
  fromValidatedExactCollection: boolean;
  /** Local screen + spatial verification result, when performed. */
  verification: LocalVerification | null;
}

export interface MediaRelationshipResult {
  mediaRelationship: MediaRelationship;
  identityEvidence: IdentityEvidence;
}

/**
 * Resolve a visual candidate's media relationship under the §10 invariants.
 * hash pass + verifier pass -> NEAR_MATCH; everything else -> VISUAL_LEAD.
 */
export function resolveMediaRelationship(
  input: MediaRelationshipInput,
): MediaRelationshipResult {
  if (input.fromValidatedExactCollection) {
    return {
      mediaRelationship: "EXACT_MATCH",
      identityEvidence: {
        basis: "lens_exact_collection",
        hashDistance: input.verification?.hashDistance ?? null,
        verifierVersion: null,
        verifierConfigId: null,
        verificationStatus: "provider_reported",
        comparisonMetrics: null,
      },
    };
  }

  const v = input.verification;
  const hashEligible =
    v !== null &&
    v.hashDistance !== null &&
    v.hashDistance <= DHASH_HAMMING_ELIGIBILITY;
  const verifierPassed =
    v?.verificationStatus === "passed" &&
    v.verifierVersion !== null &&
    v.verifierConfigId !== null &&
    v.comparisonMetrics !== null;

  if (hashEligible && verifierPassed && v !== null) {
    return {
      mediaRelationship: "NEAR_MATCH",
      identityEvidence: {
        basis: "local_spatial_verification",
        hashDistance: v.hashDistance,
        verifierVersion: v.verifierVersion,
        verifierConfigId: v.verifierConfigId,
        verificationStatus: "passed",
        comparisonMetrics: v.comparisonMetrics,
      },
    };
  }

  const verifierRan =
    v !== null &&
    (v.verificationStatus === "passed" ||
      v.verificationStatus === "failed" ||
      v.verificationStatus === "ambiguous");

  return {
    mediaRelationship: "VISUAL_LEAD",
    identityEvidence: {
      basis: verifierRan ? "local_spatial_verification" : "unverified",
      hashDistance: v?.hashDistance ?? null,
      verifierVersion: v?.verifierVersion ?? null,
      verifierConfigId: v?.verifierConfigId ?? null,
      verificationStatus: v?.verificationStatus ?? "unavailable",
      comparisonMetrics: v?.comparisonMetrics ?? null,
    },
  };
}

/**
 * Re-derive the relationship a candidate is *entitled* to from its recorded
 * identity evidence and retrieval provenance, demoting any inconsistent
 * claim to VISUAL_LEAD. Apply after merge/dedupe so a malformed upstream
 * record cannot smuggle in EXACT_MATCH or hash-only NEAR_MATCH.
 */
export function enforceIdentityInvariants(
  c: Pick<
    EvidenceCandidate,
    "mediaRelationship" | "identityEvidence" | "retrievals"
  >,
): MediaRelationship | null {
  const rel = c.mediaRelationship;
  if (rel === null) return null;

  if (rel === "EXACT_MATCH") {
    const hasExactRetrieval = c.retrievals.some(
      (r) => r.kind === "lens_exact",
    );
    const ok =
      c.identityEvidence.basis === "lens_exact_collection" &&
      c.identityEvidence.verificationStatus === "provider_reported" &&
      hasExactRetrieval;
    return ok ? "EXACT_MATCH" : "VISUAL_LEAD";
  }

  if (rel === "NEAR_MATCH") {
    const e = c.identityEvidence;
    const ok =
      e.basis === "local_spatial_verification" &&
      e.verificationStatus === "passed" &&
      e.verifierVersion !== null &&
      e.verifierConfigId !== null &&
      e.comparisonMetrics !== null &&
      e.hashDistance !== null &&
      e.hashDistance <= DHASH_HAMMING_ELIGIBILITY;
    return ok ? "NEAR_MATCH" : "VISUAL_LEAD";
  }

  return "VISUAL_LEAD";
}

/** §20 — core occurrences are EXACT_MATCH or verified NEAR_MATCH only. */
export function isCoreOccurrence(
  c: Pick<EvidenceCandidate, "mediaRelationship">,
): boolean {
  return c.mediaRelationship === "EXACT_MATCH" || c.mediaRelationship === "NEAR_MATCH";
}
