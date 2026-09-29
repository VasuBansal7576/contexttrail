/**
 * Pairwise context divergence (spec §20, §20.2).
 *
 * Deterministic rules:
 * - work on at most 8 dated core occurrences, sorted chronologically;
 * - selection keeps earliest + latest, then prefers distinct source
 *   domains/reporting groups with chronological position and candidate ID
 *   as stable tie-breakers;
 * - SAME_CONTEXT >= .75 connects within a segment; DIFFERENT_CONTEXT >= .75
 *   starts a new segment; anything else (unclear, missing, not performed)
 *   breaks asserted continuity and is never smoothed over;
 * - `contextSegmentCount` is exposed only when every displayed adjacent
 *   comparison is decisive; otherwise null ("Unresolved");
 * - the first strong DIFFERENT_CONTEXT edge is the first observed context
 *   divergence, marked on the later occurrence with its observed date —
 *   never a guessed change time;
 * - dates too imprecise to order cannot create an ordered divergence edge.
 */

import type { DatePrecision, EvidenceCandidate } from "./contracts/evidence";
import {
  classifyPairwise,
  type PairwiseContextJudgment,
} from "./contracts/judgment";
import type {
  ComparisonCoverage,
  Divergence,
  TimelineConnector,
} from "./contracts/investigation";
import { isCoreOccurrence } from "./identity";
import { MAX_DIVERGENCE_OCCURRENCES } from "./limits";

/** Day-precision interval an observed date value covers (§20.2 ordering). */
export function dateInterval(
  publishedAt: string,
  precision: DatePrecision,
): { start: string; end: string } {
  if (precision === "month" && /^\d{4}-\d{2}$/.test(publishedAt)) {
    const y = Number(publishedAt.slice(0, 4));
    const m = Number(publishedAt.slice(5, 7));
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const mm = String(m).padStart(2, "0");
    return { start: `${publishedAt}-01`, end: `${y}-${mm}-${String(last).padStart(2, "0")}` };
  }
  if (precision === "year" && /^\d{4}$/.test(publishedAt)) {
    return { start: `${publishedAt}-01-01`, end: `${publishedAt}-12-31` };
  }
  return { start: publishedAt, end: publishedAt };
}

/** Strict ordering: `a` is fully before `b`, no interval overlap. */
export function strictlyBefore(a: EvidenceCandidate, b: EvidenceCandidate): boolean {
  const ia = dateInterval(a.publishedAt ?? "", a.datePrecision);
  const ib = dateInterval(b.publishedAt ?? "", b.datePrecision);
  return ia.end < ib.start;
}

/** Chronological sort key — interval start, then end, then stable id. */
export function chronoCompare(a: EvidenceCandidate, b: EvidenceCandidate): number {
  const ia = dateInterval(a.publishedAt ?? "", a.datePrecision);
  const ib = dateInterval(b.publishedAt ?? "", b.datePrecision);
  return (
    ia.start.localeCompare(ib.start) ||
    ia.end.localeCompare(ib.end) ||
    a.id.localeCompare(b.id)
  );
}

/**
 * Occurrences usable in the dated core sequence (§20.2). Usable dates of
 * ANY known precision are eligible — the displayed timeline shows them,
 * so coverage must count them. Ordering between adjacent items uses
 * intervals; overlapping (unorderable) pairs cannot assert transitions.
 */
export function datedCoreOccurrences(
  candidates: readonly EvidenceCandidate[],
): EvidenceCandidate[] {
  return candidates
    .filter(
      (c) =>
        isCoreOccurrence(c) &&
        c.dateStatus === "usable" &&
        c.datePrecision !== "unknown" &&
        c.publishedAt !== null,
    )
    .sort(chronoCompare);
}

/**
 * §20 — select at most `max` dated core occurrences deterministically.
 * Keeps earliest and latest; fills the middle preferring candidates that
 * introduce a new registrable domain or reporting group, with chronological
 * position and ID as tie-breakers.
 */
export function selectDatedCoreOccurrences(
  datedCore: readonly EvidenceCandidate[],
  max = MAX_DIVERGENCE_OCCURRENCES,
): EvidenceCandidate[] {
  const sorted = [...datedCore].sort(chronoCompare);
  if (sorted.length <= max) return sorted;
  if (max < 2) return sorted.slice(0, max);

  const selected: EvidenceCandidate[] = [sorted[0], sorted[sorted.length - 1]];
  const selectedIds = new Set(selected.map((c) => c.id));
  const seenDomains = new Set(selected.map((c) => c.registrableDomain));
  const seenGroups = new Set(
    selected
      .filter((c) => c.reportingOrigin.status !== "unresolved")
      .map((c) => c.reportingOrigin.groupId),
  );

  const middle = sorted.slice(1, -1);
  const novelty = (c: EvidenceCandidate): number =>
    (seenDomains.has(c.registrableDomain) ? 0 : 1) +
    (c.reportingOrigin.status !== "unresolved" &&
    !seenGroups.has(c.reportingOrigin.groupId)
      ? 1
      : 0);

  // Stable ordering of the middle by chronological position + id, evaluated
  // greedily so each pick refreshes novelty.
  const remaining = [...middle];
  while (selected.length < max && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = novelty(remaining[0]);
    for (let i = 1; i < remaining.length; i++) {
      const score = novelty(remaining[i]);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    const [pick] = remaining.splice(bestIdx, 1);
    if (selectedIds.has(pick.id)) continue;
    selected.push(pick);
    selectedIds.add(pick.id);
    seenDomains.add(pick.registrableDomain);
    if (pick.reportingOrigin.status !== "unresolved") {
      seenGroups.add(pick.reportingOrigin.groupId);
    }
  }

  return selected.sort(chronoCompare);
}

export function pairKey(a: string, b: string): string {
  return `${a}|${b}`;
}

export interface PairwiseOutcome {
  kind: TimelineConnector["kind"];
  /** Raw judgment when one was performed; null = comparison not performed. */
  judgment: PairwiseContextJudgment | null;
}

export interface SegmentResult {
  /** occurrenceId -> segment index; null when continuity was unresolved. */
  segmentOf: Map<string, number | null>;
  /** occurrenceId -> connector arriving at it, including the previous
   *  selected occurrence it diverges/connects from. */
  connectorOf: Map<string, TimelineConnector>;
  contextSegmentCount: number | null;
  firstObservedContextDivergence: Divergence | null;
  coverage: ComparisonCoverage;
  /** occurrenceId -> pair ids it was an endpoint of where a pairwise
   *  comparison was actually performed (§14). */
  comparedPairsFor: Map<string, string[]>;
  /** §34 — every evaluated adjacent pair in the displayed order: the
   *  connector it produced and the actual pairwise distribution (null
   *  when the comparison was not performed — never invented). */
  comparisons: Array<{
    pairId: string;
    fromOccurrenceId: string;
    toOccurrenceId: string;
    connector: Exclude<TimelineConnector["kind"], "start">;
    distribution: PairwiseContextJudgment | null;
  }>;
  /** §23/G2 — every decisive DIVERGES_TO relation, keyed on the real
   *  occurrence endpoints. Segment indices are null when global
   *  continuity was unresolved for that side — a verified local
   *  divergence is preserved rather than dropped, and no segment or
   *  earlier continuity is invented. `firstObserved` marks the edge the
   *  §20.2 first-observed divergence names. */
  divergenceEdges: Array<{
    pairId: string;
    fromOccurrenceId: string;
    toOccurrenceId: string;
    fromSegmentIndex: number | null;
    toSegmentIndex: number | null;
    observedAt: string;
    firstObserved: boolean;
    earlierTransitionsUnresolved: boolean;
  }>;
}

/**
 * §20.2 — walk the selected chronological sequence, segment it on decisive
 * edges, and find the first observed divergence.
 *
 * `judgments` maps pairKey(from,to) to the pairwise Jev outcome; a missing
 * entry means the comparison was not performed.
 */
export function buildContextSegments(
  eligible: readonly EvidenceCandidate[],
  selected: readonly EvidenceCandidate[],
  judgments: ReadonlyMap<string, PairwiseContextJudgment | null>,
): SegmentResult {
  const segmentOf = new Map<string, number | null>();
  const connectorOf = new Map<string, TimelineConnector>();
  const comparedPairsFor = new Map<string, string[]>();
  const comparisons: SegmentResult["comparisons"] = [];
  const divergenceEdges: SegmentResult["divergenceEdges"] = [];
  const recordComparedPair = (a: string, b: string) => {
    const pk = pairKey(a, b);
    comparedPairsFor.set(a, [...(comparedPairsFor.get(a) ?? []), pk]);
    comparedPairsFor.set(b, [...(comparedPairsFor.get(b) ?? []), pk]);
  };
  let segmentIdx = 0;
  let comparedPairs = 0;
  const comparedPairIds: string[] = [];
  let firstDivergence: Divergence | null = null;
  // An exact segment count needs complete adjacent coverage of the
  // eligible run — a sampled sequence that skips occurrences can never
  // claim one (§20.2).
  const fullCoverage = selected.length === eligible.length;
  const selectedIds = new Set(selected.map((c) => c.id));
  // True when an eligible occurrence strictly before `cur` (in the
  // chronological eligible order) was not selected — its adjacent
  // transitions were never examined.
  const skippedBefore = (cur: EvidenceCandidate): boolean => {
    const curIdx = eligible.findIndex((e) => e.id === cur.id);
    if (curIdx <= 0) return false;
    return eligible.slice(0, curIdx).some((e) => !selectedIds.has(e.id));
  };
  let earlierUnresolved = false;
  let allDecisive = selected.length > 0 && fullCoverage;

  if (selected.length === 0) {
    return {
      segmentOf,
      connectorOf,
      contextSegmentCount: null,
      firstObservedContextDivergence: null,
      coverage: {
        eligible: eligible.length,
        selected: 0,
        comparedPairs: 0,
        displayedDatedCore: eligible.length,
        comparedPairIds: [],
      },
      comparedPairsFor,
      comparisons,
      divergenceEdges,
    };
  }

  segmentOf.set(selected[0].id, segmentIdx);

  for (let i = 1; i < selected.length; i++) {
    const prev = selected[i - 1];
    const cur = selected[i];

    // An adjacent pair whose date intervals overlap is not strictly
    // ordered — equal same-day dates and imprecise windows cannot
    // manufacture an ordered transition or a divergence edge.
    if (!strictlyBefore(prev, cur)) {
      connectorOf.set(cur.id, { kind: "unexamined", fromOccurrenceId: prev.id });
      comparisons.push({
        pairId: pairKey(prev.id, cur.id),
        fromOccurrenceId: prev.id,
        toOccurrenceId: cur.id,
        connector: "unexamined",
        distribution: null,
      });
      allDecisive = false;
      earlierUnresolved = true;
      segmentOf.set(cur.id, null);
      continue;
    }

    const j = judgments.get(pairKey(prev.id, cur.id)) ?? null;

    let kind: TimelineConnector["kind"];
    if (j === null) {
      kind = "unexamined";
    } else {
      comparedPairs += 1;
      comparedPairIds.push(pairKey(prev.id, cur.id));
      recordComparedPair(prev.id, cur.id);
      const rel = classifyPairwise(j);
      kind =
        rel === "SAME_CONTEXT"
          ? "same_context"
          : rel === "DIFFERENT_CONTEXT"
            ? "different_context"
            : "uncertain";
    }
    connectorOf.set(cur.id, { kind, fromOccurrenceId: prev.id });
    comparisons.push({
      pairId: pairKey(prev.id, cur.id),
      fromOccurrenceId: prev.id,
      toOccurrenceId: cur.id,
      connector: kind,
      distribution: j,
    });

    if (kind === "same_context") {
      // Continue the current segment only if it is still asserted.
      segmentOf.set(cur.id, segmentOf.get(prev.id) ?? null);
    } else if (kind === "different_context") {
      segmentIdx += 1;
      segmentOf.set(cur.id, segmentIdx);
      // The decisive relation is recorded on the occurrence endpoints
      // regardless of either side's segment resolution — a verified
      // B→C divergence survives an unresolved A→B transition (G2).
      const unresolved = earlierUnresolved || skippedBefore(cur);
      divergenceEdges.push({
        pairId: pairKey(prev.id, cur.id),
        fromOccurrenceId: prev.id,
        toOccurrenceId: cur.id,
        fromSegmentIndex: segmentOf.get(prev.id) ?? null,
        toSegmentIndex: segmentOf.get(cur.id) ?? null,
        observedAt: cur.publishedAt ?? "",
        firstObserved: firstDivergence === null && cur.publishedAt !== null,
        earlierTransitionsUnresolved: unresolved,
      });
      if (firstDivergence === null && cur.publishedAt !== null) {
        firstDivergence = {
          fromOccurrenceId: prev.id,
          toOccurrenceId: cur.id,
          observedAt: cur.publishedAt,
          // Unresolved means an *earlier* transition is unexamined —
          // either an uncertain edge already walked, or an eligible
          // occurrence skipped by sampling before this divergence.
          earlierTransitionsUnresolved: unresolved,
        };
      }
    } else {
      // uncertain / unexamined: continuity is broken, no new segment is
      // asserted, and later clear edges cannot retroactively repair it.
      allDecisive = false;
      earlierUnresolved = true;
      segmentOf.set(cur.id, null);
    }
  }

  return {
    segmentOf,
    connectorOf,
    contextSegmentCount: allDecisive ? segmentIdx + 1 : null,
    firstObservedContextDivergence: firstDivergence,
    coverage: {
      eligible: eligible.length,
      selected: selected.length,
      comparedPairs,
      // Filled by the caller once the displayed chronology is built —
      // buildContextSegments only knows the eligible run.
      displayedDatedCore: eligible.length,
      comparedPairIds,
    },
    comparedPairsFor,
    comparisons,
    divergenceEdges,
  };
}
