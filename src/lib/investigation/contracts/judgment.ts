/**
 * EvidenceJudgment (spec §15.5) and the frozen semantic thresholds (§17).
 *
 * Jev produces probability distributions; deterministic policy (§21) consumes
 * them. No model output may directly select a final status.
 */

export const RELEVANCE_THRESHOLD = 0.7;
export const STRONG_RELATION_THRESHOLD = 0.75;

export interface ContextRelation {
  sameContext: number;
  differentContext: number;
  historicalReference: number;
  unclear: number;
}

export interface PageRole {
  reporting: number;
  factCheck: number;
  socialRepost: number;
  aggregator: number;
  commentary: number;
  other: number;
}

export interface ClaimRelation {
  supports: number;
  contradicts: number;
  neutral: number;
  insufficient: number;
}

export interface LocationRelation {
  sameLocation: number;
  differentLocation: number;
  locationNotStated: number;
  unclear: number;
}

/**
 * §15.5 — per-candidate semantic judgment.
 * In Trace mode contextRelation (claim comparison), claimRelation, and
 * locationRelation are null; pairwise context classification handles
 * segmentation instead.
 */
export interface EvidenceJudgment {
  relevance: number;
  contextRelation: ContextRelation | null;
  pageRole: PageRole;
  claimRelation: ClaimRelation | null;
  locationRelation: LocationRelation | null;
  model: "jev-1.13.0";
  schemaVersion: "contexttrail-evidence-v1";
}

/**
 * §20.1 — pairwise context comparison between two dated core occurrences.
 * Strong at >= STRONG_RELATION_THRESHOLD.
 */
export interface PairwiseContextJudgment {
  sameContext: number;
  differentContext: number;
  unclear: number;
}

export type PairwiseRelation = "SAME_CONTEXT" | "DIFFERENT_CONTEXT" | "UNCLEAR";

export function classifyPairwise(
  j: PairwiseContextJudgment,
): PairwiseRelation {
  if (j.differentContext >= STRONG_RELATION_THRESHOLD) return "DIFFERENT_CONTEXT";
  if (j.sameContext >= STRONG_RELATION_THRESHOLD) return "SAME_CONTEXT";
  return "UNCLEAR";
}
