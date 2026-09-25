import { describe, expect, it } from "vitest";
import {
  chooseClaimExpansion,
  chooseTraceExpansion,
  decideClaimExpansion,
  decideTraceExpansion,
} from "../expansion";
import { makeCandidate, makeExact, makeJudgment, separateOrigin } from "./testkit";

function conflict(domain: string, group: string) {
  const c = makeExact({
    judgment: makeJudgment({
      contextRelation: {
        sameContext: 0.02,
        differentContext: 0.9,
        historicalReference: 0.03,
        unclear: 0.05,
      },
    }),
  });
  c.registrableDomain = domain;
  separateOrigin(c, group);
  return c;
}

describe("decideClaimExpansion (§8.1, §8.2)", () => {
  it("early-stops when the deterministic policy is already conclusive", () => {
    const r = decideClaimExpansion([
      conflict("a.com", "g1"),
      conflict("b.com", "g2"),
    ]);
    expect(r.expand).toBe(false);
    expect(r.reason).toBe("already_conclusive");
  });

  it("expands when the state would be INSUFFICIENT_EVIDENCE", () => {
    const r = decideClaimExpansion([makeCandidate()]);
    expect(r).toEqual({ expand: true, reason: "insufficient_evidence" });
  });

  it("expands when corroboration is limited to one reporting group", () => {
    const r = decideClaimExpansion([
      conflict("a.com", "wire"),
      conflict("b.com", "wire"),
    ]);
    expect(r).toEqual({ expand: true, reason: "corroboration_limited" });
  });
});

describe("decideTraceExpansion (§7.2, §8.1)", () => {
  it("skips the optional search once coverage is sufficient", () => {
    const a = makeExact({
      publishedAt: "2019-01-01",
      datePrecision: "day",
      dateStatus: "usable",
      judgment: makeJudgment(),
    });
    const b = makeExact({
      publishedAt: "2020-01-01",
      datePrecision: "day",
      dateStatus: "usable",
      judgment: makeJudgment(),
    });
    a.registrableDomain = "a.com";
    b.registrableDomain = "b.com";
    const r = decideTraceExpansion([a, b], true);
    expect(r.expand).toBe(false);
  });

  it("does not expand without a grounded query", () => {
    const r = decideTraceExpansion([], false);
    expect(r).toEqual({ expand: false, reason: "no_grounded_query" });
  });
});

describe("expansion choice (§8 priority, §6.3)", () => {
  it("claim mode prefers Lens refined with q=claim first", () => {
    const r = chooseClaimExpansion({
      claim: "flooding in Austin today",
      relatedContentQueries: ["austin flood 2019"],
      strongestHistoricalAnchor: { title: "Old flood", domain: "x.com" },
    });
    expect(r?.slot).toBe("adaptive_lens_refined");
    expect(r?.params).toMatchObject({ engine: "google_lens", type: "all" });
  });

  it("trace mode uses only the related-content Google Search", () => {
    expect(chooseTraceExpansion([])).toBeNull();
    expect(
      chooseTraceExpansion(["", "  ", "austin flood 2019"])?.params.q,
    ).toBe("austin flood 2019");
  });
});
