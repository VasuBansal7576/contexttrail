/**
 * Timeline construction (spec §3.11, §20.2, §22, §38.3).
 *
 * Unknown-date and disputed-date evidence never enters the dated timeline —
 * it stays visible in `undatedEvidence`. Uncertain and unexamined connectors
 * are preserved on the items they separate; they are never smoothed into
 * asserted continuity.
 */

import type { EvidenceCandidate } from "./contracts/evidence";
import type { TimelineItem } from "./contracts/investigation";
import type { SegmentResult } from "./divergence";

function toTimelineItem(
  c: EvidenceCandidate,
  opts: {
    observedAt: string | null;
    segmentIndex: number | null;
    connector: TimelineItem["incomingConnector"];
    isDivergencePoint: boolean;
  },
): TimelineItem {
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
  };
}

export interface BuiltTimeline {
  /** Dated, usable evidence in chronological order. */
  timeline: TimelineItem[];
  /** Everything else — unknown/disputed dates and non-dated candidates. */
  undatedEvidence: TimelineItem[];
}

/**
 * Split candidates into the dated timeline and undated evidence.
 * Only candidates with a usable day-precision date are ordered; month/year
 * precision values can sort the timeline but are kept verbatim (never
 * promoted to a day).
 */
export function buildTimeline(
  candidates: readonly EvidenceCandidate[],
  segments: SegmentResult | null,
): BuiltTimeline {
  const dated: EvidenceCandidate[] = [];
  const undated: EvidenceCandidate[] = [];
  for (const c of candidates) {
    if (
      c.publishedAt !== null &&
      c.dateStatus === "usable" &&
      c.datePrecision !== "unknown"
    ) {
      dated.push(c);
    } else {
      undated.push(c);
    }
  }
  dated.sort(
    (a, b) =>
      (a.publishedAt ?? "").localeCompare(b.publishedAt ?? "") ||
      a.id.localeCompare(b.id),
  );

  const divergenceId =
    segments?.firstObservedContextDivergence?.toOccurrenceId ?? null;
  const firstSelectedId =
    segments !== null && segments.segmentOf.size > 0
      ? (() => {
          for (const c of dated) if (segments.segmentOf.has(c.id)) return c.id;
          return null;
        })()
      : null;

  const timeline = dated.map((c) => {
    let connector = segments?.connectorOf.get(c.id) ?? null;
    if (connector === null) {
      if (c.id === firstSelectedId || (segments === null && c === dated[0])) {
        connector = { kind: "start", fromOccurrenceId: null };
      } else if (segments !== null || dated.length > 1) {
        // Dated evidence outside the compared run: comparison not performed.
        connector = { kind: "unexamined", fromOccurrenceId: null };
      }
    }
    const segmentIndex = segments?.segmentOf.get(c.id);
    return toTimelineItem(c, {
      observedAt: c.publishedAt,
      segmentIndex: segmentIndex === undefined ? null : segmentIndex,
      connector,
      isDivergencePoint: c.id === divergenceId,
    });
  });

  return {
    timeline,
    undatedEvidence: undated.map((c) =>
      toTimelineItem(c, {
        observedAt: null,
        segmentIndex: null,
        connector: null,
        isDivergencePoint: false,
      }),
    ),
  };
}
