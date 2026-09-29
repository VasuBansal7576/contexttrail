/**
 * Adaptive expansion policy (spec §8, §8.1, §8.2).
 *
 * The graph is adaptive but bounded: models never invent search loops, there
 * is at most one expansion per investigation, and the same conservative
 * checks drive early stopping and final policy.
 */

import type { EvidenceCandidate } from "./contracts/evidence";
import type { AdaptiveSearchSlot } from "./budget";
import { isCoreOccurrence } from "./identity";
import {
  evaluateClaimPolicy,
  isQualifyingConflict,
} from "./policy";
import { satisfiesCorroborationGate } from "./reporting-origins";

export type ExpansionReason =
  | "already_conclusive"
  | "insufficient_evidence"
  | "corroboration_limited"
  | "weak_context_evidence"
  | "trace_coverage_unmet"
  | "no_grounded_query";

export interface ExpansionDecision {
  /** Whether the adaptive slot should be spent at all. */
  expand: boolean;
  reason: ExpansionReason;
}

/**
 * §8.1/§8.2 — Claim-check expansion decision over the current pool.
 *
 * Stop when deterministic policy already has enough for CONTEXT_CONFLICT or
 * NO_CONFLICT_FOUND *with* the cross-domain/separately-evidenced-origin rule
 * satisfied. Expand when the state would be INSUFFICIENT_EVIDENCE, when
 * conflict corroboration is limited to one group or origins are unresolved,
 * or when visual evidence exists but context evidence is weak.
 */
export function decideClaimExpansion(
  candidates: readonly EvidenceCandidate[],
): ExpansionDecision {
  const policy = evaluateClaimPolicy(candidates);
  const qualifying = candidates.filter(isQualifyingConflict);

  if (policy.status === "CONTEXT_CONFLICT" || policy.status === "NO_CONFLICT_FOUND") {
    return { expand: false, reason: "already_conclusive" };
  }

  if (policy.status === "INSUFFICIENT_EVIDENCE") {
    return { expand: true, reason: "insufficient_evidence" };
  }

  // POSSIBLE_CONTEXT_CONFLICT: expand when corroboration is limited to one
  // reporting group or origins remain unresolved.
  const corroborated = satisfiesCorroborationGate(qualifying).satisfied;
  const originsUnresolved = qualifying.some(
    (c) => c.reportingOrigin.status === "unresolved",
  );
  if (!corroborated || originsUnresolved || qualifying.length === 1) {
    return { expand: true, reason: "corroboration_limited" };
  }

  const hasVisual = candidates.some((c) => c.mediaRelationship !== null);
  const weakContext = qualifying.every(
    (c) =>
      (c.judgment?.contextRelation?.differentContext ?? 0) < 0.75 &&
      (c.judgment?.contextRelation?.sameContext ?? 0) < 0.75,
  );
  if (hasVisual && weakContext) {
    return { expand: true, reason: "weak_context_evidence" };
  }

  return { expand: false, reason: "already_conclusive" };
}

/**
 * §8.1/§8.2 — Trace mode skips its optional search once at least two
 * relevant core occurrences from two source domains have usable dates and
 * classified context evidence. This is a coverage stop, not an independence
 * claim.
 */
export function decideTraceExpansion(
  candidates: readonly EvidenceCandidate[],
  groundedQueryAvailable: boolean,
): ExpansionDecision {
  const datedCoreDomains = new Set(
    candidates
      .filter(
        (c) =>
          isCoreOccurrence(c) &&
          c.judgment !== null &&
          (c.judgment.relevance ?? 0) >= 0.7 &&
          c.publishedAt !== null &&
          c.dateStatus === "usable" &&
          c.datePrecision === "day",
      )
      .map((c) => c.registrableDomain),
  );
  if (datedCoreDomains.size >= 2) {
    return { expand: false, reason: "already_conclusive" };
  }
  return groundedQueryAvailable
    ? { expand: true, reason: "trace_coverage_unmet" }
    : { expand: false, reason: "no_grounded_query" };
}

export interface ClaimExpansionChoice {
  slot: AdaptiveSearchSlot;
  /** Query params for the reserved slot. */
  params: Record<string, string>;
}

/**
 * §8 — Claim-check expansion priority, at most one search:
 *   1. Lens type=all refined with q=claim
 *   2. Google Search on strongest Lens related_content.query
 *   3. Google Search on quoted title + domain of strongest historical anchor
 */
export function chooseClaimExpansion(input: {
  claim: string;
  relatedContentQueries: readonly string[];
  strongestHistoricalAnchor: { title: string; domain: string } | null;
}): ClaimExpansionChoice | null {
  if (input.claim.trim() !== "") {
    return {
      slot: "adaptive_lens_refined",
      params: { engine: "google_lens", type: "all", q: input.claim },
    };
  }
  const related = input.relatedContentQueries.find((q) => q.trim() !== "");
  if (related !== undefined) {
    return {
      slot: "adaptive_google_search",
      params: { engine: "google", q: related },
    };
  }
  if (input.strongestHistoricalAnchor !== null) {
    const { title, domain } = input.strongestHistoricalAnchor;
    return {
      slot: "adaptive_google_search",
      params: { engine: "google", q: `"${title}" ${domain}` },
    };
  }
  return null;
}

/**
 * §7.2 — Trace mode's only expansion is the optional Google Search on the
 * best related-content query. No grounded query -> no expansion.
 */
export function chooseTraceExpansion(
  relatedContentQueries: readonly string[],
): ClaimExpansionChoice | null {
  const related = relatedContentQueries.find((q) => q.trim() !== "");
  if (related === undefined) return null;
  return {
    slot: "adaptive_google_search",
    params: { engine: "google", q: related },
  };
}
