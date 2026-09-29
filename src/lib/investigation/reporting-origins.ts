/**
 * Reporting-origin screening and the corroboration gate (spec §13).
 *
 * Truth rules encoded here:
 * - `separate_origin_evidenced` requires retrieved, inspectable attribution
 *   or source material; Jev probabilities or domain differences alone can
 *   never set it.
 * - Absence of a detected copy is not evidence of independent reporting:
 *   anything not affirmatively evidenced stays `unresolved`.
 * - Shared-origin copies count as one group; unresolved origins cannot
 *   satisfy the stronger corroboration gate.
 * - Different hostnames alone do not satisfy corroboration.
 */

import type {
  EvidenceCandidate,
  ReportingOrigin,
  ReportingOriginBasis,
} from "./contracts/evidence";
import { isCoreOccurrence } from "./identity";

/** Default state for a candidate whose origin has not been evidenced. */
export function unresolvedOrigin(candidateId: string): ReportingOrigin {
  return {
    groupId: `unresolved:${candidateId}`,
    status: "unresolved",
    basis: ["origin_unresolved_missing_evidence"],
    evidenceIds: [],
    attributionSpans: [],
  };
}

/**
 * Assign candidates to one shared reporting group when inspectable evidence
 * establishes a common origin (explicit syndication attribution, a common
 * originating report, or substantial article-text duplication).
 * `evidenceIds`/`basis` record *why* — the reason is preserved, not hidden.
 */
export function markSharedOrigin(
  candidates: readonly EvidenceCandidate[],
  groupId: string,
  basis: ReportingOriginBasis[],
  evidenceIds: string[],
  attributionSpans: Array<{ text: string; relation: string }> = [],
): void {
  for (const c of candidates) {
    c.reportingOrigin = {
      groupId,
      status: "shared_origin",
      basis,
      evidenceIds,
      attributionSpans,
    };
  }
}

/**
 * Mark one candidate as having a separately evidenced reporting origin.
 * Only call with retrieved, inspectable attribution/source material —
 * never on the strength of domain difference or model judgment alone.
 */
export function markSeparateOriginEvidenced(
  candidate: EvidenceCandidate,
  groupId: string,
  evidenceIds: string[],
  attributionSpans: Array<{ text: string; relation: string }> = [],
): void {
  candidate.reportingOrigin = {
    groupId,
    status: "separate_origin_evidenced",
    basis: ["separate_reporting_evidence"],
    evidenceIds,
    attributionSpans,
  };
}

/** Core (EXACT_MATCH / verified NEAR_MATCH) occurrences only. */
export function coreOccurrences(
  candidates: readonly EvidenceCandidate[],
): EvidenceCandidate[] {
  return candidates.filter(isCoreOccurrence);
}

/** §13 — resolved origin groups among core occurrences. */
export function reportingGroupCount(
  candidates: readonly EvidenceCandidate[],
): number {
  const groups = new Set(
    candidates
      .filter((c) => c.reportingOrigin.status !== "unresolved")
      .map((c) => c.reportingOrigin.groupId),
  );
  return groups.size;
}

/** §13 — remaining unresolved core candidates. */
export function unresolvedOriginCount(
  candidates: readonly EvidenceCandidate[],
): number {
  return candidates.filter((c) => c.reportingOrigin.status === "unresolved")
    .length;
}

export interface CorroborationCheck {
  satisfied: boolean;
  /** Candidate ids forming a satisfying pair, when found. */
  pairIds: [string, string] | null;
}

/**
 * §13 / §21.2 — strong corroboration requires at least two candidates from
 * distinct registrable domains AND distinct reporting groups, each with
 * `separate_origin_evidenced`. Same-domain, shared-origin, and unresolved
 * candidates can never satisfy it.
 */
export function satisfiesCorroborationGate(
  candidates: readonly EvidenceCandidate[],
): CorroborationCheck {
  const eligible = candidates.filter(
    (c) => c.reportingOrigin.status === "separate_origin_evidenced",
  );
  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      const a = eligible[i];
      const b = eligible[j];
      if (
        a.registrableDomain !== b.registrableDomain &&
        a.reportingOrigin.groupId !== b.reportingOrigin.groupId
      ) {
        return { satisfied: true, pairIds: [a.id, b.id] };
      }
    }
  }
  return { satisfied: false, pairIds: null };
}
