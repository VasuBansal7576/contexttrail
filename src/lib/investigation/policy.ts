/**
 * Deterministic final status policy (spec §21) and trace/claim result
 * assembly (§22, §33).
 *
 * There is no weighted truth score and no model selects the final status.
 * All gates below are conservative: unresolved reporting origins cannot
 * satisfy corroboration, visual leads cannot establish provenance, and
 * uncertainty defaults to INSUFFICIENT_EVIDENCE / limited history.
 */

import { deriveReport, type PageReadOutcome } from "./report";
import type { EvidenceCandidate } from "./contracts/evidence";
import {
  RELEVANCE_THRESHOLD,
  STRONG_RELATION_THRESHOLD,
} from "./contracts/judgment";
import type {
  ClaimStatus,
  ClaimStatusBasis,
  InvestigationResult,
  LimitationCode,
  PolicyReason,
  RequestLogEntry,
  Takeaway,
  TimelineItem,
} from "./contracts/investigation";
import {
  toProvenanceProjection,
  type ProvenanceGraph,
} from "./provenance-graph";
import { predatesClaim } from "./dates";
import { countSourceDomains } from "./domain";
import { isCoreOccurrence } from "./identity";
import {
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
  /** Why the status was assigned — bounded deterministic codes. */
  basis: ClaimStatusBasis[];
  /** Every gate evaluated, pass or fail, with its supporting ids (§21). */
  gates: PolicyReason[];
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
  const gates: PolicyReason[] = [];
  gates.push({
    gate: "qualifying_conflicts",
    passed: qualifying.length >= 2,
    detail: `${qualifying.length} qualifying conflict candidate(s); >=2 required for CONTEXT_CONFLICT`,
    supportIds: qualifying.map((c) => c.id),
  });

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
    gates.push({
      gate: "corroborating_pair",
      passed: conflictPair !== null,
      detail:
        conflictPair !== null
          ? "corroborating pair across distinct domains and separately evidenced reporting groups"
          : "no pair across distinct domains + separately evidenced reporting groups satisfying the identity gate",
      supportIds: conflictPair === null ? [] : conflictPair.map((c) => c.id),
    });
    if (conflictPair !== null) {
      return {
        status: "CONTEXT_CONFLICT",
        qualifyingConflictIds: qualifying.map((c) => c.id),
        limitations,
        basis: ["qualifying_conflicts_corroborated"],
        gates,
      };
    }
    if (qualifying.some((c) => c.reportingOrigin.status === "unresolved")) {
      limitations.push("reporting_origins_unresolved");
    }
    return {
      status: "POSSIBLE_CONTEXT_CONFLICT",
      qualifyingConflictIds: qualifying.map((c) => c.id),
      limitations,
      basis: ["conflicts_without_corroboration"],
      gates,
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
      basis: ["single_qualifying_conflict"],
      gates,
    };
  }

  const relevantCore = candidates.filter((c) => isRelevant(c) && isCoreOccurrence(c));
  const domainCount = countSourceDomains(relevantCore);
  const groups = reportingGroupCount(relevantCore);
  const unresolved = unresolvedOriginCount(relevantCore);
  const corroboration = satisfiesCorroborationGate(relevantCore);
  const strongSupport = relevantCore.filter(hasStrongSupport);

  gates.push(
    {
      gate: "relevant_core_coverage",
      passed: relevantCore.length >= 3,
      detail: `${relevantCore.length} relevant core occurrence(s); >=3 required`,
      supportIds: relevantCore.map((c) => c.id),
    },
    {
      gate: "distinct_domains",
      passed: domainCount >= 2,
      detail: `${domainCount} registrable domain(s) among relevant core; >=2 required`,
      supportIds: relevantCore.map((c) => c.id),
    },
    {
      gate: "distinct_reporting_groups",
      passed: groups >= 2,
      detail: `${groups} resolved reporting group(s) among relevant core; >=2 required`,
      supportIds: relevantCore
        .filter((c) => c.reportingOrigin.status !== "unresolved")
        .map((c) => c.id),
    },
    {
      gate: "corroborating_pair",
      passed: corroboration.satisfied,
      detail: corroboration.satisfied
        ? "corroborating pair across distinct domains and separately evidenced groups"
        : "no corroborating pair across distinct domains + separately evidenced groups",
      supportIds: corroboration.pairIds ?? [],
    },
    {
      gate: "strong_support",
      passed: strongSupport.length > 0,
      detail: `${strongSupport.length} strong support judgment(s); >=1 required`,
      supportIds: strongSupport.map((c) => c.id),
    },
  );

  if (unresolved > 0) limitations.push("reporting_origins_unresolved");

  if (
    relevantCore.length >= 3 &&
    domainCount >= 2 &&
    groups >= 2 &&
    corroboration.satisfied &&
    strongSupport.length > 0
  ) {
    return {
      status: "NO_CONFLICT_FOUND",
      qualifyingConflictIds: [],
      limitations,
      basis: ["corroborated_no_conflict"],
      gates,
    };
  }

  return {
    status: "INSUFFICIENT_EVIDENCE",
    qualifyingConflictIds: [],
    limitations,
    basis: ["insufficient_qualifying_evidence"],
    gates,
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
  pageReads?: PageReadOutcome[];
  candidates: readonly EvidenceCandidate[];
  timeline: TimelineItem[];
  supportingEvidence: TimelineItem[];
  contextualEvidence: TimelineItem[];
  undatedEvidence: TimelineItem[];
  limitations: LimitationCode[];
  /** Per-operation retrieval accounting (§34). */
  requestLog: RequestLogEntry[];
  /** §23 — the authoritative provenance graph this result derives from.
   *  It owns segment membership, coverage, comparisons, the first
   *  observed divergence and context-segment count; the summary
   *  projection reads those owned fields, never parallel inputs. */
  graph: ProvenanceGraph;
}

function sourceLinkedReport(input: ResultAssemblyInput, claimMode: boolean) {
  return deriveReport({
    candidates: input.candidates,
    items: [...input.timeline, ...input.supportingEvidence, ...input.contextualEvidence, ...input.undatedEvidence],
    coverage: input.graph.coverage,
    earliestObservedOccurrence: input.graph.metrics.earliestObservedOccurrence,
    pageReads: input.pageReads,
    claimMode,
  });
}

/** Assemble the shared metrics both result modes carry. All
 *  chronology/coverage/relation fields come from the owned provenance
 *  graph — no caller-supplied parallel derivation is accepted (§23). */
export function sharedMetrics(input: ResultAssemblyInput) {
  const graph = input.graph;
  const m = graph.metrics;

  return {
    earliestObservedOccurrence: m.earliestObservedOccurrence,
    sourceDomainCount: m.sourceDomainCount,
    reportingGroupCount: m.reportingGroupCount,
    unresolvedOriginCount: m.unresolvedOriginCount,
    contextSegmentCount: graph.contextSegmentCount,
    firstObservedContextDivergence: graph.firstObservedDivergence,
    comparisonCoverage: graph.coverage,
    requestLog: input.requestLog,
    reportingGroups: m.reportingGroups,
    unresolvedCandidateIds: m.unresolvedCandidateIds,
    comparisons: graph.comparisons,
    provenance: toProvenanceProjection(graph),
    limitations: input.limitations,
    undatedEvidence: input.undatedEvidence,
    supportingEvidence: input.supportingEvidence,
    contextualEvidence: input.contextualEvidence,
    timeline: input.timeline,
  };
}

/**
 * §22 — Trace-mode result. Trace mode never returns claim statuses.
 * The strong headline requires a real reconstructed chronology: at least
 * two relevant core occurrences AND at least two dated core occurrences
 * actually displayed in the timeline. Relevant-but-undated core evidence
 * cannot assert a reconstructed history — it yields the limited headline
 * alongside the `insufficient_dated_occurrences` limitation (L1).
 */
export function buildTraceResult(input: ResultAssemblyInput): InvestigationResult {
  const relevantCore = input.candidates.filter(
    (c) => isCoreOccurrence(c) && isRelevant(c),
  );
  return {
    mode: "trace",
    sourceLinkedReport: sourceLinkedReport(input, false),
    headline:
      relevantCore.length >= 2 && input.graph.coverage.displayedDatedCore >= 2
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
    sourceLinkedReport: sourceLinkedReport(input, true),
    status: policy.status,
    statusBasis: policy.basis,
    policyReasons: policy.gates,
    claim: input.claim,
    claimDate: input.claimDate,
    doesNotProveClaimTrue: true,
    webContextAvailable: input.webContextAvailable,
    takeaways: input.takeaways,
    ...sharedMetrics({ ...input, limitations }),
  };
}
