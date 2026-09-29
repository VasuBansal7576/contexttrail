/**
 * Timeline construction (spec §3.11, §20.2, §22, §38.3).
 *
 * Unknown-date and disputed-date evidence never enters the dated timeline —
 * it stays visible in `undatedEvidence`. Uncertain and unexamined connectors
 * are preserved on the items they separate; they are never smoothed into
 * asserted continuity.
 */

import type { EvidenceCandidate, JevDistributions } from "./contracts/evidence";
import type { TimelineItem } from "./contracts/investigation";
import { STRONG_RELATION_THRESHOLD } from "./contracts/judgment";
import type { ProvenanceGraph } from "./provenance-graph";

/** Strong context-relationship label from a Jev judgment, else null. */
function contextLabelOf(c: EvidenceCandidate): TimelineItem["contextLabel"] {
  const rel = c.judgment?.contextRelation;
  if (!rel) return null;
  if (rel.differentContext >= STRONG_RELATION_THRESHOLD) return "DIFFERENT_CONTEXT";
  if (rel.sameContext >= STRONG_RELATION_THRESHOLD) return "SAME_CONTEXT";
  if (rel.historicalReference >= STRONG_RELATION_THRESHOLD) return "HISTORICAL_REFERENCE";
  return null;
}

const DISPLAY_ATTRIBUTION: Record<string, string> = {
  page_text: "Extracted page excerpt",
  serp_snippet: "Search snippet",
  page_composite: "Composite page excerpt (title/snippet/body)",
};

/** §34 — the actual provider search ids this occurrence was retrieved
 *  under (deduped, in retrieval order). Empty when none were reported —
 *  ids are never invented. */
function searchIdsOf(c: EvidenceCandidate): string[] {
  const out: string[] = [];
  for (const id of [c.serpSearchId, ...c.retrievals.map((r) => r.searchId)]) {
    if (id !== null && !out.includes(id)) out.push(id);
  }
  return out;
}

/** §34 — verified per-question Jev distributions; null unless the
 *  candidate carries a judgment (a judgment exists only when the pinned
 *  model identity was verified — the numbers are never fabricated). */
function jevDistributionsOf(c: EvidenceCandidate): JevDistributions | null {
  const j = c.judgment;
  if (j === null) return null;
  return {
    relevance: j.relevance,
    pageRole: j.pageRole,
    contextRelation: j.contextRelation,
    claimRelation: j.claimRelation,
    locationRelation: j.locationRelation,
  };
}

function toTimelineItem(
  c: EvidenceCandidate,
  opts: {
    observedAt: string | null;
    segmentIndex: number | null;
    connector: TimelineItem["incomingConnector"];
    isDivergencePoint: boolean;
    excerpt: string | null;
    classificationContext: string | null;
    comparisonSelection: TimelineItem["comparisonSelection"];
  },
): TimelineItem {
  const firstRetrieval = c.retrievals[0] ?? null;
  return {
    occurrenceId: c.id,
    evidenceId: c.id,
    observedAt: opts.observedAt,
    datePrecision: c.datePrecision,
    dateStatus: c.dateStatus,
    title: c.title,
    sourceUrl: c.sourceUrl,
    canonicalUrl: c.canonicalUrl,
    domain: c.domain,
    registrableDomain: c.registrableDomain,
    mediaRelationship: c.mediaRelationship,
    contextSegmentIndex: opts.segmentIndex,
    incomingConnector: opts.connector,
    isFirstObservedDivergencePoint: opts.isDivergencePoint,
    imageUrl: c.resultImageUrl ?? c.thumbnailUrl,
    excerpt: opts.excerpt ?? c.snippet,
    excerptSource: c.excerptSource,
    publishedAtSource: c.publishedAtSource,
    reportingOriginStatus: c.reportingOrigin.status,
    reportingOriginGroupId:
      c.reportingOrigin.status === "unresolved"
        ? null
        : c.reportingOrigin.groupId,
    reportingOriginBasis: c.reportingOrigin.basis,
    identityBasis: c.identityEvidence.basis,
    identityBasisDetail: {
      method: c.identityEvidence.basis,
      supportId: c.identityEvidence.verifierConfigId,
    },
    dateProvenance: {
      value: c.publishedAt,
      precision: c.datePrecision,
      source: c.publishedAtSource,
      entityBinding: c.dateEntityBinding ?? null,
      rejectedCandidates: c.rejectedDateCandidates ?? [],
    },
    originSupport: {
      status: c.reportingOrigin.status,
      groupId:
        c.reportingOrigin.status === "unresolved"
          ? null
          : c.reportingOrigin.groupId,
      attributionSpans: c.reportingOrigin.attributionSpans,
      groupingReason: c.reportingOrigin.basis,
    },
    displayAttribution:
      c.excerptSource === null ? null : (DISPLAY_ATTRIBUTION[c.excerptSource] ?? null),
    classificationContext: opts.classificationContext,
    comparisonSelection: opts.comparisonSelection,
    contextLabel: contextLabelOf(c),
    serpPosition: c.serpPosition,
    retrievedAt: firstRetrieval?.retrievedAt ?? null,
    engine: firstRetrieval?.kind ?? null,
    resultType: firstRetrieval?.resultType ?? null,
    jevModel: c.judgment?.model ?? null,
    searchIds: searchIdsOf(c),
    jevDistributions: jevDistributionsOf(c),
    pageMetadata: c.pageMetadata ?? null,
  };
}

export interface BuiltTimeline {
  /** Dated core occurrences (EXACT_MATCH / verified NEAR_MATCH) only. */
  timeline: TimelineItem[];
  /** Dated non-core visual leads — supporting, never core. */
  supportingEvidence: TimelineItem[];
  /** Dated contextual web/news evidence (no media identity). */
  contextualEvidence: TimelineItem[];
  /** Everything else — unknown/disputed dates and non-dated candidates. */
  undatedEvidence: TimelineItem[];
}

/**
 * Split candidates into the dated core timeline, dated supporting leads,
 * dated contextual evidence, and undated evidence. Only core occurrences
 * may populate `timeline`; contextual and lead evidence is dated and
 * visible but can never assert media history. Month/year precision values
 * can sort the timeline but are kept verbatim (never promoted to a day).
 */
export function buildTimeline(
  candidates: readonly EvidenceCandidate[],
  /** §23 — the authoritative provenance graph owning the canonical
   *  partition, segment membership, connectors, compared pairs and first
   *  observed divergence. The projection reads that owned state only;
   *  a `pairwiseJudgments: null` graph (partial stream) asserts no
   *  relation state and projects partition buckets alone. */
  graph: ProvenanceGraph,
  excerpts?: ReadonlyMap<string, string>,
  /** Model-input composites keyed by candidate id — surfaced separately
   *  as `classificationContext`, never as the displayed quote. */
  modelExcerpts?: ReadonlyMap<string, string>,
): BuiltTimeline {
  const { datedCore: dated, datedLead, datedContextual, undated } =
    graph.partition;

  const divergenceId =
    graph.firstObservedDivergence?.toOccurrenceId ?? null;
  // True when the graph asserts segment state — a null-judgments graph
  // (the divergence stage never ran) leaves every map empty.
  const hasSegments = graph.segmentOf.size > 0;
  const firstSelectedId = hasSegments
    ? (() => {
        for (const c of dated) if (graph.segmentOf.has(c.id)) return c.id;
        return null;
      })()
    : null;

  const timeline = dated.map((c) => {
    let connector = graph.connectorOf.get(c.id) ?? null;
    if (connector === null) {
      if (c.id === firstSelectedId || (!hasSegments && c === dated[0])) {
        connector = { kind: "start", fromOccurrenceId: null };
      } else if (hasSegments || dated.length > 1) {
        // Dated evidence outside the compared run: comparison not performed.
        connector = { kind: "unexamined", fromOccurrenceId: null };
      }
    }
    const segmentIndex = graph.segmentOf.get(c.id);
    return toTimelineItem(c, {
      observedAt: c.publishedAt,
      segmentIndex: segmentIndex === undefined ? null : segmentIndex,
      connector,
      isDivergencePoint: c.id === divergenceId,
      excerpt: excerpts?.get(c.id) ?? null,
      classificationContext: modelExcerpts?.get(c.id) ?? null,
      comparisonSelection: {
        selected: graph.segmentOf.has(c.id) || graph.connectorOf.has(c.id),
        comparedPairIds: graph.comparedPairsFor.get(c.id) ?? [],
      },
    });
  });

  const plainItem = (c: EvidenceCandidate) =>
    toTimelineItem(c, {
      observedAt: c.publishedAt,
      segmentIndex: null,
      connector: null,
      isDivergencePoint: false,
      excerpt: excerpts?.get(c.id) ?? null,
      classificationContext: modelExcerpts?.get(c.id) ?? null,
      comparisonSelection: { selected: false, comparedPairIds: [] },
    });

  return {
    timeline,
    supportingEvidence: datedLead.map(plainItem),
    contextualEvidence: datedContextual.map(plainItem),
    undatedEvidence: undated.map((c) =>
      toTimelineItem(c, {
        observedAt: null,
        segmentIndex: null,
        connector: null,
        isDivergencePoint: false,
        excerpt: excerpts?.get(c.id) ?? null,
        classificationContext: modelExcerpts?.get(c.id) ?? null,
        comparisonSelection: { selected: false, comparedPairIds: [] },
      }),
    ),
  };
}
