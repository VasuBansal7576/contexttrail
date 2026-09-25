import { describe, expect, it } from "vitest";
import {
  applyRetentionCaps,
  dedupeByCanonicalUrl,
  selectForClassification,
} from "../candidates";
import { MAX_JEV_CANDIDATES } from "../limits";
import { makeCandidate, makeExact } from "./testkit";

describe("dedupeByCanonicalUrl (§11)", () => {
  it("merges repeated retrievals of one canonical URL", () => {
    const a = makeCandidate({
      canonicalUrl: "https://x.com/p",
      serpPosition: 1,
    });
    const b = makeExact({
      canonicalUrl: "https://x.com/p",
      serpPosition: 2,
    });
    const out = dedupeByCanonicalUrl([a, b]);
    expect(out).toHaveLength(1);
    // strongest relationship survives the merge
    expect(out[0].mediaRelationship).toBe("EXACT_MATCH");
    expect(out[0].retrievals).toHaveLength(2);
    expect(out[0].retrievals.map((r) => r.kind).sort()).toEqual([
      "lens_exact",
      "lens_visual",
    ]);
  });

  it("does not merge distinct URLs", () => {
    const out = dedupeByCanonicalUrl([
      makeCandidate({ canonicalUrl: "https://a.com/1" }),
      makeCandidate({ canonicalUrl: "https://b.com/2" }),
    ]);
    expect(out).toHaveLength(2);
  });
});

describe("applyRetentionCaps (§14)", () => {
  it("caps each retrieval kind at its limit, best SERP rank first", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      makeCandidate({ retrievalKind: "lens_visual", serpPosition: i + 1 }),
    );
    const capped = applyRetentionCaps(many);
    expect(capped).toHaveLength(8);
    expect(capped.map((c) => c.serpPosition)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe("selectForClassification (§14)", () => {
  it("never exceeds MAX_JEV_CANDIDATES", () => {
    const many = Array.from({ length: 40 }, () => makeCandidate());
    expect(selectForClassification(many)).toHaveLength(MAX_JEV_CANDIDATES);
  });

  it("prefers exact, dated, domain-diverse candidates", () => {
    const exact = makeExact({
      publishedAt: "2020-01-01",
      datePrecision: "day",
      dateStatus: "usable",
    });
    exact.registrableDomain = "exact.com";
    const filler = Array.from({ length: 30 }, () => {
      const c = makeCandidate();
      c.registrableDomain = "same.com";
      return c;
    });
    const selected = selectForClassification([...filler, exact]);
    expect(selected[0].id).toBe(exact.id);
  });
});
