/**
 * Deterministic final status policy (spec §21) and trace/claim result
 * assembly (§22, §33).
 *
 * There is no weighted truth score and no model selects the final status.
 * All gates below are conservative: unresolved reporting origins cannot
 * satisfy corroboration, visual leads cannot establish provenance, and
 * uncertainty defaults to INSUFFICIENT_EVIDENCE / limited history.
 */

import type { EvidenceCandidate } from "./contracts/evidence";
import {
  RELEVANCE_THRESHOLD,
  STRONG_RELATION_THRESHOLD,
} from "./contracts/judgment";
import type {
  ClaimStatus,
  ComparisonCoverage,
  Divergence,
  InvestigationResult,
  LimitationCode,
  Takeaway,
  TimelineItem,
} from "./contracts/investigation";
import { predatesClaim } from "./dates";
import { countSourceDomains } from "./domain";
import { isCoreOccurrence } from "./identity";
import {
  coreOccurrences,
  reportingGroupCount,
  satisfiesCorroborationGate,
  unresolvedOriginCount,
} from "./reporting-origins";

export function isRelevant(c: EvidenceCandidate): boolean {
  return (c.judgment?.relevance ?? 0) >= RELEVANCE_THRESHOLD;
}

/**
 * §21.1 — strong conflict evidence requires relevance >= .70, a core media
 * relationship, and at least one strong contradiction signal.
 */
export function isQualifyingConflict(c: EvidenceCandidate): boolean {
  if (!isRelevant(c) || !isCoreOccurrence(c)) return false;
  const j = c.judgment;
  if (j === null) return false;
  return (
    (j.contextRelation?.differentContext ?? 0) >= STRONG_RELATION_THRESHOLD ||
    (j.claimRelation?.contradicts ?? 0) >= STRONG_RELATION_THRESHOLD ||
    (j.locationRelation?.differentLocation ?? 0) >= STRONG_RELATION_THRESHOLD
  );
}

/** §21.4 — a strong SAME_CONTEXT or SUPPORTS judgment on a core occurrence. */
export function hasStrongSupport(c: EvidenceCandidate): boolean {
  if (!isRelevant(c) || !isCoreOccurrence(c)) return false;
  const j = c.judgment;
  if (j === null) return false;
  return (
    (j.contextRelation?.sameContext ?? 0) >= STRONG_RELATION_THRESHOLD ||
    (j.claimRelation?.supports ?? 0) >= STRONG_RELATION_THRESHOLD
  );
}

/**
 * §21.2's identity requirement on a corroborating pair: at least one
 * EXACT_MATCH, or two NEAR_MATCHes that both passed the stronger identity
 * gate (guaranteed by `isCoreOccurrence`) and satisfy the corroboration rule.
 */
function pairSatisfiesIdentityGate(
  a: EvidenceCandidate,
  b: EvidenceCandidate,
): boolean {
  if (a.mediaRelationship === "EXACT_MATCH") return true;
  if (b.mediaRelationship === "EXACT_MATCH") return true;
  return (
    a.mediaRelationship === "NEAR_MATCH" &&
    b.mediaRelationship === "NEAR_MATCH"
  );
}

export interface ClaimPolicyResult {
  status: ClaimStatus;
  qualifyingConflictIds: string[];
  /** Why a stronger status was withheld — deterministic reason codes. */
  limitations: LimitationCode[];
}

/**
 * §21 — evaluate the deterministic claim status over the full candidate pool.
 *
 * CONTEXT_CONFLICT          >=2 qualifying conflicts across >=2 registrable
 *                           domains and >=2 separately evidenced reporting
 *                           groups, with the §21.2 identity condition.
 * POSSIBLE_CONTEXT_CONFLICT exactly one qualifier, or multiple qualifiers
 *                           without corroboration.
 * NO_CONFLICT_FOUND         >=3 relevant core occurrences, >=2 domains, >=2
 *                           evidenced groups, 0 qualifiers, >=1 strong
 *                           support — always carries the caveat that this
 *                           does not prove the claim true.
 * INSUFFICIENT_EVIDENCE     everything else; preferred when uncertain.
 */
export function evaluateClaimPolicy(
  candidates: readonly EvidenceCandidate[],
): ClaimPolicyResult {
  const qualifying = candidates.filter(isQualifyingConflict);
  const limitations: LimitationCode[] = [];

  if (qualifying.length >= 2) {
    // Corroborating pair: distinct domains + distinct separately evidenced
    // groups + the §21.2 identity condition.
    const separatelyEvidenced = qualifying.filter(
      (c) => c.reportingOrigin.status === "separate_origin_evidenced",
    );
    let conflictPair: [EvidenceCandidate, EvidenceCandidate] | null = null;
    for (let i = 0; i < separatelyEvidenced.length && conflictPair === null; i++) {
      for (let j = i + 1; j < separatelyEvidenced.length; j++) {
        const a = separatelyEvidenced[i];
        const b = separatelyEvidenced[j];
        if (
          a.registrableDomain !== b.registrableDomain &&
          a.reportingOrigin.groupId !== b.reportingOrigin.groupId &&
          pairSatisfiesIdentityGate(a, b)
        ) {
          conflictPair = [a, b];
          break;
        }
      }
    }
    if (conflictPair !== null) {
      return {
        status: "CONTEXT_CONFLICT",
        qualifyingConflictIds: qualifying.map((c) => c.id),
        limitations,
      };
    }
    if (qualifying.some((c) => c.reportingOrigin.status === "unresolved")) {
      limitations.push("reporting_origins_unresolved");
    }
    return {
      status: "POSSIBLE_CONTEXT_CONFLICT",
      qualifyingConflictIds: qualifying.map((c) => c.id),
      limitations,
    };
  }

  if (qualifying.length === 1) {
    if (qualifying[0].reportingOrigin.status === "unresolved") {
      limitations.push("reporting_origins_unresolved");
    }
    return {
      status: "POSSIBLE_CONTEXT_CONFLICT",
      qualifyingConflictIds: [qualifying[0].id],
      limitations,
    };
  }

  const relevantCore = candidates.filter((c) => isRelevant(c) && isCoreOccurrence(c));
  const domainCount = countSourceDomains(relevantCore);
  const groups = reportingGroupCount(relevantCore);
  const unresolved = unresolvedOriginCount(relevantCore);
  const corroborated = satisfiesCorroborationGate(relevantCore).satisfied;

  if (unresolved > 0) limitations.push("reporting_origins_unresolved");

  if (
    relevantCore.length >= 3 &&
    domainCount >= 2 &&
    groups >= 2 &&
    corroborated &&
    relevantCore.some(hasStrongSupport)
  ) {
    return {
      status: "NO_CONFLICT_FOUND",
      qualifyingConflictIds: [],
      limitations,
    };
  }

  return {
    status: "INSUFFICIENT_EVIDENCE",
    qualifyingConflictIds: [],
    limitations,
  };
}

/** §33 — deterministic takeaways, max three, each with evidence IDs. */
export function deriveTakeaways(input: {
  candidates: readonly EvidenceCandidate[];
  claimDate: string | null;
  claimDatePrecision?: "day" | "month" | "year" | "unknown";
  hasCurrentNewsResults: boolean;
}): Takeaway[] {
  const out: Takeaway[] = [];

  const predating = input.candidates.filter(
    (c) =>
      isCoreOccurrence(c) &&
      isRelevant(c) &&
      predatesClaim(
        c.publishedAt,
        c.datePrecision,
        c.dateStatus,
        input.claimDate,
        input.claimDatePrecision ?? "day",
      ),
  );
  if (predating.length > 0) {
    out.push({
      code: "temporal_conflict",
      evidenceIds: predating.map((c) => c.id),
    });
  }

  const differentLocation = input.candidates.filter(
    (c) =>
      isCoreOccurrence(c) &&
      isRelevant(c) &&
      (c.judgment?.locationRelation?.differentLocation ?? 0) >=
        STRONG_RELATION_THRESHOLD,
  );
  if (differentLocation.length > 0) {
    out.push({
      code: "location_conflict",
      evidenceIds: differentLocation.map((c) => c.id),
    });
  }

  // A historical-reuse takeaway asserts the media circulated before the
  // claim — it needs a core occurrence (real media identity) AND temporal
  // support (a usable date that predates the claim). An undated or
  // contextual lead cannot assert media history.
  const historical = input.candidates.filter(
    (c) =>
      isCoreOccurrence(c) &&
      isRelevant(c) &&
      (c.judgment?.contextRelation?.historicalReference ?? 0) >=
        STRONG_RELATION_THRESHOLD &&
      predatesClaim(
        c.publishedAt,
        c.datePrecision,
        c.dateStatus,
        input.claimDate,
        input.claimDatePrecision ?? "day",
      ),
  );
  if (historical.length > 0) {
    out.push({
      code: "historical_reuse",
      evidenceIds: historical.map((c) => c.id),
    });
  }

  if (
    input.hasCurrentNewsResults &&
    !input.candidates.some(
      (c) => c.retrievalKind === "google_news" && isCoreOccurrence(c),
    )
  ) {
    out.push({ code: "no_current_media_corroboration", evidenceIds: [] });
  }

  return out.slice(0, 3);
}

export interface ResultAssemblyInput {
  candidates: readonly EvidenceCandidate[];
  timeline: TimelineItem[];
  supportingEvidence: TimelineItem[];
  contextualEvidence: TimelineItem[];
  undatedEvidence: TimelineItem[];
  coverage: ComparisonCoverage;
  firstObservedContextDivergence: Divergence | null;
  contextSegmentCount: number | null;
  limitations: LimitationCode[];
}

/** Assemble the shared metrics both result modes carry. */
export function sharedMetrics(input: ResultAssemblyInput) {
  const core = coreOccurrences(input.candidates);
  const dated = core
    .filter(
      (c) =>
        c.publishedAt !== null &&
        c.dateStatus === "usable" &&
        c.datePrecision !== "unknown",
    )
    .sort(
      (a, b) =>
        (a.publishedAt ?? "").localeCompare(b.publishedAt ?? "") ||
        a.id.localeCompare(b.id),
    );

  return {
    earliestObservedOccurrence: dated[0]?.publishedAt ?? null,
    sourceDomainCount: countSourceDomains(core),
    reportingGroupCount: reportingGroupCount(core),
    unresolvedOriginCount: unresolvedOriginCount(core),
    contextSegmentCount: input.contextSegmentCount,
    firstObservedContextDivergence: input.firstObservedContextDivergence,
    comparisonCoverage: input.coverage,
    limitations: input.limitations,
    undatedEvidence: input.undatedEvidence,
    supportingEvidence: input.supportingEvidence,
    contextualEvidence: input.contextualEvidence,
    timeline: input.timeline,
  };
}

/**
 * §22 — Trace-mode result. Trace mode never returns claim statuses.
 * Headline is "limited" when fewer than two relevant core occurrences exist.
 */
export function buildTraceResult(input: ResultAssemblyInput): InvestigationResult {
  const relevantCore = input.candidates.filter(
    (c) => isCoreOccurrence(c) && isRelevant(c),
  );
  return {
    mode: "trace",
    headline:
      relevantCore.length >= 2
        ? "MEDIA_HISTORY_RECONSTRUCTED"
        : "LIMITED_MEDIA_HISTORY_FOUND",
    ...sharedMetrics(input),
  };
}

/**
 * §21 — Claim-check result wrapper: runs the deterministic policy and
 * attaches the mandatory caveat flag for NO_CONFLICT_FOUND.
 */
export function buildClaimResult(
  input: ResultAssemblyInput & {
    claim: string;
    claimDate: string | null;
    webContextAvailable: boolean;
    takeaways: Takeaway[];
  },
): InvestigationResult {
  const policy = evaluateClaimPolicy(input.candidates);
  const limitations = [...input.limitations];
  for (const l of policy.limitations) {
    if (!limitations.includes(l)) limitations.push(l);
  }
  return {
    mode: "claim_check",
    status: policy.status,
    claim: input.claim,
    claimDate: input.claimDate,
    doesNotProveClaimTrue: true,
    webContextAvailable: input.webContextAvailable,
    takeaways: input.takeaways,
    ...sharedMetrics({ ...input, limitations }),
  };
}
