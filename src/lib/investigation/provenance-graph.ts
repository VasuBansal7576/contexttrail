/**
 * Internal provenance graph (spec §23).
 *
 * The typed relation structure that drives BOTH the timeline and the
 * result summary: Media → Occurrence → Source Domain, Occurrence →
 * Context Segment, DIVERGES_TO edges between segments, and Claim →
 * Claim Context → compared-with segments.
 *
 * Membership policy is the conservative one already established:
 * `partitionOccurrences` owns the single dated/core/lead/contextual
 * derivation that `buildTimeline` projects, and `graphMetrics` reuses the
 * same domain/group helpers the policy uses — the graph records
 * relationships, it does not invent new eligibility.
 */

import type {
  DatePrecision,
  EvidenceCandidate,
} from "./contracts/evidence";
import type {
  ClaimRelation,
  ContextRelation,
} from "./contracts/judgment";
import type {
  ComparisonCoverage,
  ComparisonRecord,
  Divergence,
  ProvenanceProjection,
  ReportingGroupSummary,
  TimelineConnector,
} from "./contracts/investigation";
import {
  buildContextSegments,
  chronoCompare,
  selectDatedCoreOccurrences,
} from "./divergence";
import type { PairwiseContextJudgment } from "./contracts/judgment";
import { isCoreOccurrence } from "./identity";
import { countSourceDomains } from "./domain";
import {
  coreOccurrences,
  reportingGroupCount,
  unresolvedOriginCount,
} from "./reporting-origins";

/* ------------------------- canonical occurrence partition ------------------------- */

export interface OccurrencePartition {
  /** Dated core occurrences (EXACT_MATCH / verified NEAR_MATCH). */
  datedCore: EvidenceCandidate[];
  /** Dated non-core visual leads — supporting, never core. */
  datedLead: EvidenceCandidate[];
  /** Dated contextual web/news evidence (no media identity). */
  datedContextual: EvidenceCandidate[];
  /** Unknown/disputed dates and non-dated candidates. */
  undated: EvidenceCandidate[];
}

/**
 * The one occurrence partition the product uses — the graph's occurrence
 * roles and the timeline's buckets are the same derivation, so neither
 * can silently disagree with the other.
 */
export function partitionOccurrences(
  candidates: readonly EvidenceCandidate[],
): OccurrencePartition {
  const datedCore: EvidenceCandidate[] = [];
  const datedLead: EvidenceCandidate[] = [];
  const datedContextual: EvidenceCandidate[] = [];
  const undated: EvidenceCandidate[] = [];
  for (const c of candidates) {
    if (
      c.publishedAt !== null &&
      c.dateStatus === "usable" &&
      c.datePrecision !== "unknown"
    ) {
      if (isCoreOccurrence(c)) datedCore.push(c);
      else if (c.mediaRelationship === "VISUAL_LEAD") datedLead.push(c);
      else datedContextual.push(c);
    } else {
      undated.push(c);
    }
  }
  datedCore.sort(chronoCompare);
  datedLead.sort(chronoCompare);
  datedContextual.sort(chronoCompare);
  return { datedCore, datedLead, datedContextual, undated };
}

/* ------------------------------ typed graph nodes ------------------------------ */

export type ProvenanceOccurrenceRole = "core" | "lead" | "contextual";

export interface ProvenanceOccurrence {
  /** Occurrence id — equals the evidence candidate id. */
  id: string;
  /** Edge O → S: the registrable source domain node id. */
  domainId: string;
  /** Edge O → K: context-segment node id, null when continuity was
   *  unresolved or the occurrence was not in the compared run. */
  segmentId: string | null;
  role: ProvenanceOccurrenceRole;
  /** True when the occurrence carries a usable, known-precision date. */
  dated: boolean;
}

export interface ProvenanceSourceDomain {
  id: string;
  domain: string;
  occurrenceIds: string[];
}

export interface ProvenanceContextSegment {
  id: string;
  index: number;
  occurrenceIds: string[];
}

/** K → K DIVERGES_TO edge — the real decisive divergence relation between
 *  two occurrences. Segment endpoints are null when that side's segment
 *  continuity was unresolved: the verified local divergence is preserved,
 *  no segment or earlier continuity is invented (G2). Only decisive
 *  different_context edges exist; uncertain/unexamined transitions
 *  produce none. */
export interface ProvenanceDivergenceEdge {
  pairId: string;
  fromOccurrenceId: string;
  toOccurrenceId: string;
  fromSegmentId: string | null;
  toSegmentId: string | null;
  /** Observed date of the later occurrence — never a guessed time. */
  observedAt: string;
  /** True on the first observed divergence (§20.2). */
  firstObserved: boolean;
  earlierTransitionsUnresolved: boolean;
}

/** §23/G1 — an actual claim-context → occurrence comparison record: the
 *  per-candidate question the verified model answered about this claim.
 *  Distinct from occurrence↔occurrence pairwise media-context records;
 *  never synthesized — only accepted claim/context distributions appear. */
export interface ProvenanceClaimComparison {
  occurrenceId: string;
  /** O → K edge target; null when the occurrence's segment was
   *  unresolved or it was not in the compared run. */
  segmentId: string | null;
  question: "context_relation" | "claim_relation";
  distribution: ContextRelation | ClaimRelation;
}

export interface ProvenanceClaimContext {
  id: "claim-context";
  claim: string;
  claimDate: string | null;
  claimDatePrecision: DatePrecision;
  /** C → KQ → O/K comparison evidence — one record per verified
   *  claim/context question answered per occurrence. */
  comparisons: ProvenanceClaimComparison[];
  /** KQ → K "compared with" edges — derived solely from real comparison
   *  records above, never from pairwise occurrence judgments. */
  comparedSegmentIds: string[];
}

export interface ProvenanceGraph {
  /** The submitted media asset node (M). */
  media: { id: "media" };
  /** M → O: every investigated occurrence. */
  occurrences: ProvenanceOccurrence[];
  /** O → S: one domain node per registrable domain observed. */
  sourceDomains: ProvenanceSourceDomain[];
  /** O → K: asserted context segments only. */
  contextSegments: ProvenanceContextSegment[];
  /** K → K DIVERGES_TO edges. */
  divergenceEdges: ProvenanceDivergenceEdge[];
  /** C → KQ claim context node; null in Trace mode. */
  claimContext: ProvenanceClaimContext | null;
  /** The shared canonical partition. */
  partition: OccurrencePartition;

  /* ------ canonical relation state — the graph OWNS these (§23) ------ */
  /** O → K raw membership: occurrenceId → segment index, null when
   *  continuity was unresolved. */
  segmentOf: ReadonlyMap<string, number | null>;
  /** Connector arriving at each selected occurrence. */
  connectorOf: ReadonlyMap<string, TimelineConnector>;
  /** occurrenceId → pair ids it was an endpoint of where a pairwise
   *  comparison was actually performed. */
  comparedPairsFor: ReadonlyMap<string, string[]>;
  /** §20.2 first observed divergence — null when none was observed. */
  firstObservedDivergence: Divergence | null;
  /** Segment count only when the displayed run is fully decisive. */
  contextSegmentCount: number | null;
  /** Authoritative comparison coverage — including unresolved/unexamined
   *  relations and `displayedDatedCore` from the owned partition. */
  coverage: ComparisonCoverage;
  /** Every evaluated adjacent pair with its actual distribution (null
   *  when unexamined). */
  comparisons: ComparisonRecord[];

  /** Result-summary metrics derived from this graph's relations. */
  metrics: ProvenanceGraphMetrics;
}

export interface ProvenanceGraphMetrics {
  earliestObservedOccurrence: string | null;
  sourceDomainCount: number;
  reportingGroupCount: number;
  unresolvedOriginCount: number;
  reportingGroups: ReportingGroupSummary[];
  unresolvedCandidateIds: string[];
}

const segmentNodeId = (index: number) => `segment:${index}`;
const domainNodeId = (domain: string) => `domain:${domain}`;

function occurrenceRole(c: EvidenceCandidate): ProvenanceOccurrenceRole {
  if (isCoreOccurrence(c)) return "core";
  return c.mediaRelationship === "VISUAL_LEAD" ? "lead" : "contextual";
}

function isDatedUsable(c: EvidenceCandidate): boolean {
  return (
    c.publishedAt !== null &&
    c.dateStatus === "usable" &&
    c.datePrecision !== "unknown"
  );
}

/**
 * §23 — build the typed internal provenance graph for one investigation.
 * Both the timeline projection and the result summary read from this
 * structure, so the relations they present are the same relations.
 *
 * The graph OWNS the canonical occurrence relationships: the eligible
 * dated core, the deterministic ≤8 selection, segment membership,
 * connectors, coverage, comparisons (including unresolved/unexamined
 * relations), and the first observed divergence are all derived here —
 * from the graph's own partition plus the pairwise judgments that are
 * the raw relation evidence. Callers supply evidence and judgments only;
 * no separately assembled chronology/coverage structure is accepted.
 */
export function buildProvenanceGraph(input: {
  candidates: readonly EvidenceCandidate[];
  /** Pairwise context judgments keyed `pairKey(from,to)` for the
   *  orderable adjacent pairs of the selected dated core — the raw
   *  relation evidence the graph segments on. `null` when the
   *  divergence stage never ran (partial projection): no segment,
   *  connector, or coverage state is asserted. */
  pairwiseJudgments: ReadonlyMap<string, PairwiseContextJudgment | null> | null;
  claim: string | null;
  claimDate: string | null;
  claimDatePrecision?: DatePrecision;
}): ProvenanceGraph {
  const { candidates, pairwiseJudgments } = input;
  const partition = partitionOccurrences(candidates);
  // Canonical selection and segment walk — owned here so the timeline
  // and summary can never disagree about which occurrences were
  // selected or which relations were examined.
  const segments =
    pairwiseJudgments === null
      ? null
      : buildContextSegments(
          partition.datedCore,
          selectDatedCoreOccurrences(partition.datedCore),
          pairwiseJudgments,
        );

  // O → S edges and domain nodes.
  const domains = new Map<string, ProvenanceSourceDomain>();
  const occurrences: ProvenanceOccurrence[] = candidates.map((c) => {
    const domainId = domainNodeId(c.registrableDomain);
    if (!domains.has(domainId)) {
      domains.set(domainId, {
        id: domainId,
        domain: c.registrableDomain,
        occurrenceIds: [],
      });
    }
    domains.get(domainId)!.occurrenceIds.push(c.id);
    const segIdx = segments?.segmentOf.get(c.id);
    return {
      id: c.id,
      domainId,
      segmentId:
        segIdx === null || segIdx === undefined ? null : segmentNodeId(segIdx),
      role: occurrenceRole(c),
      dated: isDatedUsable(c),
    };
  });

  // O → K segment nodes (asserted segments only).
  const segmentMap = new Map<number, string[]>();
  if (segments !== null) {
    for (const [id, idx] of segments.segmentOf) {
      if (idx === null) continue;
      if (!segmentMap.has(idx)) segmentMap.set(idx, []);
      segmentMap.get(idx)!.push(id);
    }
  }
  const contextSegments: ProvenanceContextSegment[] = [...segmentMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, occurrenceIds]) => ({
      id: segmentNodeId(index),
      index,
      occurrenceIds,
    }));

  // K → K DIVERGES_TO edges — projected from the authoritative edge
  // records on SegmentResult, keyed on real occurrence endpoints. A side
  // whose segment continuity was unresolved carries a null segment id;
  // the verified local divergence is preserved, not dropped (G2).
  const divergenceEdges: ProvenanceDivergenceEdge[] =
    segments === null
      ? []
      : segments.divergenceEdges.map((e) => ({
          pairId: e.pairId,
          fromOccurrenceId: e.fromOccurrenceId,
          toOccurrenceId: e.toOccurrenceId,
          fromSegmentId:
            e.fromSegmentIndex === null ? null : segmentNodeId(e.fromSegmentIndex),
          toSegmentId:
            e.toSegmentIndex === null ? null : segmentNodeId(e.toSegmentIndex),
          observedAt: e.observedAt,
          firstObserved: e.firstObserved,
          earlierTransitionsUnresolved: e.earlierTransitionsUnresolved,
        }));

  // C → KQ → O/K claim context (G1): explicit per-occurrence claim/context
  // comparison records built ONLY from accepted candidate judgments —
  // verified question, actual distribution, real occurrence/segment ids.
  // Occurrence↔occurrence pairwise results live on the top-level
  // `comparisons` contract, not here.
  let claimContext: ProvenanceClaimContext | null = null;
  if (input.claim !== null) {
    const comparisons: ProvenanceClaimComparison[] = [];
    const comparedSegmentIds = new Set<string>();
    for (const c of candidates) {
      const j = c.judgment;
      if (j === null) continue;
      const segIdx = segments?.segmentOf.get(c.id);
      const segmentId =
        segIdx === null || segIdx === undefined ? null : segmentNodeId(segIdx);
      if (j.contextRelation !== null) {
        comparisons.push({
          occurrenceId: c.id,
          segmentId,
          question: "context_relation",
          distribution: j.contextRelation,
        });
        if (segmentId !== null) comparedSegmentIds.add(segmentId);
      }
      if (j.claimRelation !== null) {
        comparisons.push({
          occurrenceId: c.id,
          segmentId,
          question: "claim_relation",
          distribution: j.claimRelation,
        });
        if (segmentId !== null) comparedSegmentIds.add(segmentId);
      }
    }
    claimContext = {
      id: "claim-context",
      claim: input.claim,
      claimDate: input.claimDate,
      claimDatePrecision: input.claimDatePrecision ?? "unknown",
      comparisons,
      comparedSegmentIds: [...comparedSegmentIds],
    };
  }

  // Owned canonical relation state. `displayedDatedCore` is owned here:
  // it equals the partition's dated core, which is exactly what the
  // timeline projects — no caller may patch a conflicting value in.
  const emptySegmentOf: ReadonlyMap<string, number | null> = new Map();
  const emptyConnectorOf: ReadonlyMap<string, TimelineConnector> = new Map();
  const emptyPairsFor: ReadonlyMap<string, string[]> = new Map();
  const coverage: ComparisonCoverage =
    segments === null
      ? {
          eligible: 0,
          selected: 0,
          comparedPairs: 0,
          displayedDatedCore: partition.datedCore.length,
          comparedPairIds: [],
        }
      : {
          ...segments.coverage,
          displayedDatedCore: partition.datedCore.length,
        };

  return {
    media: { id: "media" },
    occurrences,
    sourceDomains: [...domains.values()],
    contextSegments,
    divergenceEdges,
    claimContext,
    partition,
    segmentOf: segments?.segmentOf ?? emptySegmentOf,
    connectorOf: segments?.connectorOf ?? emptyConnectorOf,
    comparedPairsFor: segments?.comparedPairsFor ?? emptyPairsFor,
    firstObservedDivergence: segments?.firstObservedContextDivergence ?? null,
    contextSegmentCount: segments?.contextSegmentCount ?? null,
    coverage,
    comparisons: segments?.comparisons.map((c) => ({ ...c })) ?? [],
    metrics: computeProvenanceMetrics(candidates),
  };
}

/**
 * §23 — project the internal graph into the public result surface.
 * Straight typed pass-through: every node id, edge endpoint, and claim
 * context on the wire is exactly the relation the graph recorded.
 */
export function toProvenanceProjection(
  graph: ProvenanceGraph,
): ProvenanceProjection {
  return {
    media: graph.media,
    occurrences: graph.occurrences.map((o) => ({ ...o })),
    sourceDomains: graph.sourceDomains.map((d) => ({
      ...d,
      occurrenceIds: [...d.occurrenceIds],
    })),
    contextSegments: graph.contextSegments.map((s) => ({
      ...s,
      occurrenceIds: [...s.occurrenceIds],
    })),
    divergenceEdges: graph.divergenceEdges.map((e) => ({ ...e })),
    claimContext:
      graph.claimContext === null
        ? null
        : {
            claim: graph.claimContext.claim,
            claimDate: graph.claimContext.claimDate,
            claimDatePrecision: graph.claimContext.claimDatePrecision,
            comparisons: graph.claimContext.comparisons.map((r) => ({
              ...r,
              distribution: { ...r.distribution },
            })),
            comparedSegmentIds: [...graph.claimContext.comparedSegmentIds],
          },
  };
}

/**
 * Result-summary metrics derived from the graph's core-occurrence
 * relations — the same helpers the policy consults, computed once here so
 * the graph, not a parallel derivation, is the shared source (§23).
 */
export function computeProvenanceMetrics(
  candidates: readonly EvidenceCandidate[],
): ProvenanceGraphMetrics {
  const core = coreOccurrences(candidates);
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

  const groups = new Map<string, { memberIds: string[]; reason: Set<string> }>();
  const unresolvedCandidateIds: string[] = [];
  for (const c of core) {
    if (c.reportingOrigin.status === "unresolved") {
      unresolvedCandidateIds.push(c.id);
      continue;
    }
    const g = groups.get(c.reportingOrigin.groupId) ?? {
      memberIds: [],
      reason: new Set<string>(),
    };
    g.memberIds.push(c.id);
    for (const b of c.reportingOrigin.basis) g.reason.add(b);
    groups.set(c.reportingOrigin.groupId, g);
  }

  return {
    earliestObservedOccurrence: dated[0]?.publishedAt ?? null,
    sourceDomainCount: countSourceDomains(core),
    reportingGroupCount: reportingGroupCount(core),
    unresolvedOriginCount: unresolvedOriginCount(core),
    reportingGroups: [...groups.entries()].map(([groupId, g]) => ({
      groupId,
      memberIds: g.memberIds,
      reason: [...g.reason] as ReportingGroupSummary["reason"],
    })),
    unresolvedCandidateIds,
  };
}
