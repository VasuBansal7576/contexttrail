import { describe, expect, it } from "vitest";
import {
  buildClaimResult,
  buildTraceResult,
  deriveTakeaways,
  evaluateClaimPolicy,
} from "../policy";
import { makeCandidate, makeExact, makeJudgment, separateOrigin } from "./testkit";

function conflictCandidate(domain: string, group: string) {
  const c = makeExact({
    judgment: makeJudgment({
      contextRelation: {
        sameContext: 0.05,
        differentContext: 0.9,
        historicalReference: 0.02,
        unclear: 0.03,
      },
    }),
  });
  c.registrableDomain = domain;
  separateOrigin(c, group);
  return c;
}

function supportCandidate(domain: string, group: string) {
  const c = makeExact({ judgment: makeJudgment() });
  c.registrableDomain = domain;
  separateOrigin(c, group);
  return c;
}

describe("evaluateClaimPolicy (§21)", () => {
  it("CONTEXT_CONFLICT: 2 qualifiers, 2 domains, 2 evidenced groups", () => {
    const a = conflictCandidate("a.com", "g1");
    const b = conflictCandidate("b.com", "g2");
    const r = evaluateClaimPolicy([a, b]);
    expect(r.status).toBe("CONTEXT_CONFLICT");
    expect(r.qualifyingConflictIds).toEqual([a.id, b.id]);
  });

  it("POSSIBLE: multiple qualifiers but origins unresolved", () => {
    const a = conflictCandidate("a.com", "g1");
    const b = conflictCandidate("b.com", "g2");
    b.reportingOrigin.status = "unresolved";
    const r = evaluateClaimPolicy([a, b]);
    expect(r.status).toBe("POSSIBLE_CONTEXT_CONFLICT");
  });

  it("POSSIBLE: exactly one strong qualifier", () => {
    const a = conflictCandidate("a.com", "g1");
    const r = evaluateClaimPolicy([a]);
    expect(r.status).toBe("POSSIBLE_CONTEXT_CONFLICT");
    expect(r.qualifyingConflictIds).toEqual([a.id]);
  });

  it("POSSIBLE: qualifiers share one reporting group across domains", () => {
    const a = conflictCandidate("a.com", "wire");
    const b = conflictCandidate("b.com", "wire");
    expect(evaluateClaimPolicy([a, b]).status).toBe(
      "POSSIBLE_CONTEXT_CONFLICT",
    );
  });

  it("a visual lead never qualifies as conflict evidence", () => {
    const lead = makeCandidate({
      judgment: makeJudgment({
        contextRelation: {
          sameContext: 0,
          differentContext: 0.95,
          historicalReference: 0,
          unclear: 0.05,
        },
      }),
    });
    const r = evaluateClaimPolicy([lead]);
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.qualifyingConflictIds).toEqual([]);
  });

  it("relevance below 0.70 never qualifies", () => {
    const c = conflictCandidate("a.com", "g1");
    c.judgment = makeJudgment({
      relevance: 0.6,
      contextRelation: {
        sameContext: 0,
        differentContext: 0.9,
        historicalReference: 0,
        unclear: 0.1,
      },
    });
    expect(evaluateClaimPolicy([c]).status).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("NO_CONFLICT_FOUND only with corroborated coverage + strong support", () => {
    const a = supportCandidate("a.com", "g1");
    const b = supportCandidate("b.com", "g2");
    const c = supportCandidate("c.com", "g1");
    const r = evaluateClaimPolicy([a, b, c]);
    expect(r.status).toBe("NO_CONFLICT_FOUND");
  });

  it("no conflict gate fails without separate origins -> INSUFFICIENT", () => {
    const a = supportCandidate("a.com", "g1");
    const b = supportCandidate("b.com", "g1");
    const c = supportCandidate("c.com", "g1");
    // one shared group -> cannot satisfy corroboration
    expect(evaluateClaimPolicy([a, b, c]).status).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("INSUFFICIENT_EVIDENCE when Jev produced no judgments", () => {
    const a = makeExact();
    const b = makeExact();
    expect(evaluateClaimPolicy([a, b]).status).toBe("INSUFFICIENT_EVIDENCE");
  });
});

describe("result assembly (§21.4, §22, §38.3)", () => {
  const base = {
    candidates: [] as ReturnType<typeof makeCandidate>[],
    timeline: [],
    supportingEvidence: [],
    contextualEvidence: [],
    undatedEvidence: [],
    coverage: { eligible: 0, selected: 0, comparedPairs: 0 },
    firstObservedContextDivergence: null,
    contextSegmentCount: null,
    limitations: [] as const,
  };

  it("trace result carries no claim status", () => {
    const r = buildTraceResult({ ...base, limitations: [] });
    expect(r.mode).toBe("trace");
    expect("status" in r).toBe(false);
  });

  it("NO_CONFLICT_FOUND always carries the not-proof caveat", () => {
    const a = supportCandidate("a.com", "g1");
    const b = supportCandidate("b.com", "g2");
    const c = supportCandidate("c.com", "g1");
    const r = buildClaimResult({
      ...base,
      candidates: [a, b, c],
      claim: "photo taken today",
      claimDate: "2026-09-25",
      webContextAvailable: true,
      takeaways: [],
      limitations: [],
    });
    expect(r.mode).toBe("claim_check");
    if (r.mode === "claim_check") {
      expect(r.status).toBe("NO_CONFLICT_FOUND");
      expect(r.doesNotProveClaimTrue).toBe(true);
    }
  });
});

describe("deriveTakeaways (§33)", () => {
  it("emits temporal_conflict only for core occurrences predating the claim", () => {
    const old = makeExact({
      publishedAt: "2019-01-01",
      datePrecision: "day",
      dateStatus: "usable",
      judgment: makeJudgment(),
    });
    const lead = makeCandidate({
      publishedAt: "2018-01-01",
      datePrecision: "day",
      dateStatus: "usable",
      judgment: makeJudgment(),
    });
    const t = deriveTakeaways({
      candidates: [old, lead],
      claimDate: "2026-09-25",
      hasCurrentNewsResults: false,
    });
    expect(t).toHaveLength(1);
    expect(t[0].code).toBe("temporal_conflict");
    expect(t[0].evidenceIds).toEqual([old.id]);
  });

  it("emits no_current_media_corroboration when news exists but no core match", () => {
    const news = makeCandidate({ retrievalKind: "google_news" });
    const t = deriveTakeaways({
      candidates: [news],
      claimDate: null,
      hasCurrentNewsResults: true,
    });
    expect(t.map((x) => x.code)).toContain("no_current_media_corroboration");
  });
});
