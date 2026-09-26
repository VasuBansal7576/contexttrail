import { describe, expect, it } from "vitest";
import {
  buildContextSegments,
  pairKey,
  selectDatedCoreOccurrences,
  datedCoreOccurrences,
} from "../divergence";
import { buildTimeline } from "../timeline";
import { makeCandidate, makeExact } from "./testkit";

describe("buildTimeline (§20.2, §38.3)", () => {
  it("unknown dates never enter the dated timeline", () => {
    const dated = makeExact({
      publishedAt: "2020-01-01",
      datePrecision: "day",
      dateStatus: "usable",
    });
    const unknown = makeCandidate({ publishedAt: null });
    const disputed = makeExact({
      publishedAt: "2019-01-01",
      datePrecision: "day",
      dateStatus: "disputed",
    });
    const r = buildTimeline([dated, unknown, disputed], null);
    expect(r.timeline.map((t) => t.evidenceId)).toEqual([dated.id]);
    expect(r.undatedEvidence.map((t) => t.evidenceId).sort()).toEqual(
      [unknown.id, disputed.id].sort(),
    );
  });

  it("marks evidence outside the compared run as unexamined", () => {
    const a = makeExact({
      publishedAt: "2020-01-01",
      datePrecision: "day",
      dateStatus: "usable",
    });
    const b = makeExact({
      publishedAt: "2020-02-01",
      datePrecision: "day",
      dateStatus: "usable",
    });
    const extra = makeCandidate({
      publishedAt: "2020-01-15",
      datePrecision: "day",
      dateStatus: "usable",
    }); // visual lead: dated but not core
    const eligible = datedCoreOccurrences([a, b, extra]);
    const selected = selectDatedCoreOccurrences(eligible);
    const seg = buildContextSegments(
      eligible,
      selected,
      new Map([
        [
          pairKey(a.id, b.id),
          { sameContext: 0.9, differentContext: 0.05, unclear: 0.05 },
        ],
      ]),
    );
    const r = buildTimeline([a, b, extra], seg);
    // A dated visual lead is supporting evidence, not a timeline occurrence:
    // it keeps its observed date but carries no continuity connector.
    expect(r.timeline.map((t) => t.evidenceId)).not.toContain(extra.id);
    const extraItem = r.supportingEvidence.find(
      (t) => t.evidenceId === extra.id,
    )!;
    expect(extraItem.observedAt).toBe("2020-01-15");
    expect(extraItem.incomingConnector).toBeNull();
    const bItem = r.timeline.find((t) => t.evidenceId === b.id)!;
    expect(bItem.incomingConnector).toEqual({
      kind: "same_context",
      fromOccurrenceId: a.id,
    });
  });
});
