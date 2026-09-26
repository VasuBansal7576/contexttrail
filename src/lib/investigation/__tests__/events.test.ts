import { describe, expect, it } from "vitest";
import {
  NdjsonEventReader,
  decodeEventLine,
  encodeEvent,
  type InvestigationEvent,
} from "../contracts/events";

describe("NDJSON stream contract (§24)", () => {
  it("round-trips every event through encode/decode", () => {
    const events: InvestigationEvent[] = [
      { type: "investigation.started", investigationId: "inv-1" },
      { type: "stage.started", stage: "INITIAL_RETRIEVAL" },
      { type: "stage.completed", stage: "NORMALIZE", detail: "12 candidates" },
      { type: "search.batch", engine: "google_lens", count: 18 },
      { type: "verdict.preliminary", verdict: "INSUFFICIENT_EVIDENCE" },
      {
        type: "divergence.detected",
        divergence: {
          fromOccurrenceId: "a",
          toOccurrenceId: "b",
          observedAt: "2020-01-01",
          earlierTransitionsUnresolved: false,
        },
      },
      {
        type: "investigation.completed",
        result: {
          mode: "trace",
          headline: "LIMITED_MEDIA_HISTORY_FOUND",
          earliestObservedOccurrence: null,
          sourceDomainCount: 0,
          reportingGroupCount: 0,
          unresolvedOriginCount: 0,
          contextSegmentCount: null,
          firstObservedContextDivergence: null,
          comparisonCoverage: { eligible: 0, selected: 0, comparedPairs: 0 },
          limitations: ["semantic_classification_unavailable"],
          undatedEvidence: [],
          supportingEvidence: [],
          contextualEvidence: [],
          timeline: [],
        },
      },
      {
        type: "investigation.error",
        code: "VISUAL_SEARCH_FAILED",
        message: "Visual search could not be completed.",
      },
    ];
    const reader = new NdjsonEventReader();
    const wire = events.map(encodeEvent).join("");
    // feed in awkward chunks to prove partial-line buffering
    const decoded: InvestigationEvent[] = [];
    for (let i = 0; i < wire.length; i += 7) {
      decoded.push(...reader.feed(wire.slice(i, i + 7)));
    }
    decoded.push(...reader.flush());
    expect(decoded).toEqual(events);
  });

  it("rejects unknown event types rather than guessing", () => {
    expect(() => decodeEventLine('{"type":"nope"}')).toThrow();
    expect(() => decodeEventLine("not json")).toThrow();
    expect(decodeEventLine("")).toBeNull();
    expect(decodeEventLine("   ")).toBeNull();
  });
});
