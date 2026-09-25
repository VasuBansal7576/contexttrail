import { describe, expect, it } from "vitest";
import type { PairwiseContextJudgment } from "../contracts/judgment";
import {
  buildContextSegments,
  datedCoreOccurrences,
  pairKey,
  selectDatedCoreOccurrences,
} from "../divergence";
import { makeCandidate, makeExact, separateOrigin } from "./testkit";

function dated(
  publishedAt: string,
  domain: string,
  group?: string,
) {
  const c = makeExact({
    publishedAt,
    publishedAtSource: "page_json_ld",
    datePrecision: "day",
    dateStatus: "usable",
  });
  c.registrableDomain = domain;
  if (group !== undefined) separateOrigin(c, group);
  return c;
}

const SAME: PairwiseContextJudgment = {
  sameContext: 0.9,
  differentContext: 0.05,
  unclear: 0.05,
};
const DIFF: PairwiseContextJudgment = {
  sameContext: 0.05,
  differentContext: 0.9,
  unclear: 0.05,
};
const UNCLEAR: PairwiseContextJudgment = {
  sameContext: 0.4,
  differentContext: 0.4,
  unclear: 0.2,
};

describe("datedCoreOccurrences (§20)", () => {
  it("excludes leads, unknown dates, disputed dates, and month precision", () => {
    const ok = dated("2020-01-01", "a.com");
    const lead = makeCandidate({
      publishedAt: "2020-01-02",
      datePrecision: "day",
      dateStatus: "usable",
    });
    const disputed = dated("2020-01-03", "b.com");
    disputed.dateStatus = "disputed";
    const monthOnly = dated("2020-02", "c.com");
    monthOnly.datePrecision = "month";
    expect(
      datedCoreOccurrences([ok, lead, disputed, monthOnly]).map((c) => c.id),
    ).toEqual([ok.id]);
  });
});

describe("selectDatedCoreOccurrences (§20)", () => {
  it("keeps earliest and latest when trimming beyond 8", () => {
    const occs = Array.from({ length: 12 }, (_, i) =>
      dated(`2020-01-${String(i + 1).padStart(2, "0")}`, `d${i}.com`),
    );
    const sel = selectDatedCoreOccurrences(occs, 8);
    expect(sel).toHaveLength(8);
    expect(sel[0].id).toBe(occs[0].id);
    expect(sel[7].id).toBe(occs[11].id);
  });
});

describe("buildContextSegments (§20.2)", () => {
  it("segments on strong DIFFERENT_CONTEXT and counts segments", () => {
    const a = dated("2020-01-01", "a.com");
    const b = dated("2020-02-01", "b.com");
    const c = dated("2020-03-01", "c.com");
    const r = buildContextSegments(
      [a, b, c],
      [a, b, c],
      new Map([
        [pairKey(a.id, b.id), SAME],
        [pairKey(b.id, c.id), DIFF],
      ]),
    );
    expect(r.contextSegmentCount).toBe(2);
    expect(r.firstObservedContextDivergence).toEqual({
      fromOccurrenceId: b.id,
      toOccurrenceId: c.id,
      observedAt: "2020-03-01",
      earlierTransitionsUnresolved: false,
    });
    expect(r.coverage).toEqual({ eligible: 3, selected: 3, comparedPairs: 2 });
  });

  it("an uncertain connector breaks continuity and nulls the count", () => {
    const a = dated("2020-01-01", "a.com");
    const b = dated("2020-02-01", "b.com");
    const c = dated("2020-03-01", "c.com");
    const r = buildContextSegments(
      [a, b, c],
      [a, b, c],
      new Map([
        [pairKey(a.id, b.id), UNCLEAR],
        [pairKey(b.id, c.id), DIFF],
      ]),
    );
    expect(r.contextSegmentCount).toBeNull();
    // first divergence still marked, on the later occurrence, flagged
    expect(r.firstObservedContextDivergence?.toOccurrenceId).toBe(c.id);
    expect(
      r.firstObservedContextDivergence?.earlierTransitionsUnresolved,
    ).toBe(true);
    // continuity after the uncertain edge is not asserted
    expect(r.segmentOf.get(b.id)).toBeNull();
  });

  it("missing comparison is unexamined, not assumed continuity", () => {
    const a = dated("2020-01-01", "a.com");
    const b = dated("2020-02-01", "b.com");
    const r = buildContextSegments([a, b], [a, b], new Map());
    expect(r.connectorOf.get(b.id)?.kind).toBe("unexamined");
    expect(r.contextSegmentCount).toBeNull();
  });

  it("a reappearing context after divergence is a new segment, not merged", () => {
    const a = dated("2020-01-01", "a.com");
    const b = dated("2020-02-01", "b.com");
    const c = dated("2020-03-01", "c.com");
    const r = buildContextSegments(
      [a, b, c],
      [a, b, c],
      new Map([
        [pairKey(a.id, b.id), DIFF],
        [pairKey(b.id, c.id), DIFF],
      ]),
    );
    expect(r.contextSegmentCount).toBe(3);
    expect(r.segmentOf.get(a.id)).toBe(0);
    expect(r.segmentOf.get(b.id)).toBe(1);
    expect(r.segmentOf.get(c.id)).toBe(2);
  });
});
