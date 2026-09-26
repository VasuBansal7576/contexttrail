import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "../providers/http";
import {
  JevClient,
  JEV_ENDPOINT,
  JEV_MODEL,
  JEV_PROBABILITY_SUM_TOLERANCE,
  judgmentFromAnswers,
  pairwiseFromAnswers,
  resolveModelIdentity,
  verifiedPinnedModel,
} from "./client";
import {
  claimLocationEligibility,
  claimMayStateLocation,
  evidenceQuestions,
  evidenceQuestionsWithProvenance,
  PAIRWISE_QUESTION,
  RELEVANCE_QUESTION,
} from "./questions";

const noul = (n: number) => ({ type: "noul", noul: n });
const choice = (c: string, probs: Record<string, number>) => ({
  type: "choice",
  choice: c,
  probabilities: probs,
});
const choiceNoWinner = (probs: Record<string, number>) => ({
  type: "choice",
  probabilities: probs,
});

const PAGE_ROLE_KEYS = ["REPORTING", "FACT_CHECK", "SOCIAL_REPOST", "AGGREGATOR", "COMMENTARY", "OTHER"];
const CONTEXT_KEYS = ["SAME_CONTEXT", "DIFFERENT_CONTEXT", "HISTORICAL_REFERENCE", "UNCLEAR"];
const CLAIM_KEYS = ["SUPPORTS", "CONTRADICTS", "NEUTRAL", "INSUFFICIENT"];
const PAIRWISE_KEYS = ["SAME_CONTEXT", "DIFFERENT_CONTEXT", "UNCLEAR"];
const probs = (keys: string[], winner: string, p = 0.8) =>
  Object.fromEntries(keys.map((k) => [k, k === winner ? p : (1 - p) / (keys.length - 1)]));
const even = (keys: string[], p = 0.25) =>
  Object.fromEntries(keys.map((k) => [k, p]));

const traceAnswers = {
  relevance: noul(0.9),
  page_role: choice("REPORTING", probs(PAGE_ROLE_KEYS, "REPORTING")),
};

const claimAnswers = {
  ...traceAnswers,
  context_relation: choice("DIFFERENT_CONTEXT", probs(CONTEXT_KEYS, "DIFFERENT_CONTEXT")),
  claim_relation: choice("CONTRADICTS", probs(CLAIM_KEYS, "CONTRADICTS")),
  location_relation: choice("SAME_LOCATION", {
    SAME_LOCATION: 0.7,
    DIFFERENT_LOCATION: 0.1,
    LOCATION_NOT_STATED: 0.1,
    UNCLEAR: 0.1,
  }),
};

const jsonResponse = (body: unknown) =>
  vi.fn().mockImplementation(async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

/** A six-option distribution that sums to exactly 1. */
const sumsToOne = (values: number[]): Record<string, number> =>
  Object.fromEntries(PAGE_ROLE_KEYS.map((k, i) => [k, values[i]]));

const verified = resolveModelIdentity(JEV_MODEL, JEV_MODEL);
const unexpected = resolveModelIdentity(JEV_MODEL, "unexpected-model-v9");
const missing = resolveModelIdentity(JEV_MODEL, undefined);

describe("evidenceQuestions", () => {
  it("trace mode asks relevance + page_role only", () => {
    expect(Object.keys(evidenceQuestions({ claimMode: false, claimHasLocation: false }))).toEqual([
      "relevance",
      "page_role",
    ]);
  });

  it("claim mode adds context/claim relations; location only when the claim states one", () => {
    expect(
      Object.keys(evidenceQuestions({ claimMode: true, claimHasLocation: false })),
    ).toEqual(["relevance", "page_role", "context_relation", "claim_relation"]);
    expect(
      Object.keys(evidenceQuestions({ claimMode: true, claimHasLocation: true })),
    ).toContain("location_relation");
  });

  it("location question is never asked in trace mode even when a location exists", () => {
    expect(
      Object.keys(evidenceQuestions({ claimMode: false, claimHasLocation: true })),
    ).not.toContain("location_relation");
  });
});

/* --------------------- §16.5 explicit-location gating --------------------- */

describe("claimLocationEligibility — the reproduced Astra cases", () => {
  const cases: Array<[string, boolean]> = [
    ["London is where this image was taken.", true],
    ["This image was taken in london.", true],
    ["This image shows Alice smiling.", false],
    ["This image was taken in London.", true],
  ];

  it.each(cases)("%s => %s", (claim, expected) => {
    expect(claimMayStateLocation(claim)).toBe(expected);
  });

  it("no-location negatives: person names, roles, media, platforms, times", () => {
    const negatives = [
      "This image shows Alice smiling.",
      "This image shows a man in a suit.",
      "This image shows a woman holding a phone.",
      "This photo shows a smiling child.",
      "This image was posted by Alice.",
      "This image was taken by photographer John Smith.",
      "The President addressed the crowd.",
      "This image shows a flood today.",
      "This image was shared on Twitter.",
      "This image was published in the news.",
      "The photo is in the picture.",
      "This happened in 2019.",
      "This happened on Tuesday.",
      "This image shows the sky at night.",
      "This image was taken in reverse.",
      "This image was taken in black and white.",
      "This image was taken in a suit.",
      "This image shows a man named Mr President.",
      "This image is in general detail.",
      "This quote is from the minister.",
      "This image shows a photo taken in front of the officer.",
      "This image was taken at the reporter's desk.",
      "This image was taken from Mr Smith.",
      "This image shows a child in the crowd.",
      "This image was taken at the conference.",
      "This image shows smoke in the distance.",
      "This picture is in the album.",
      "This image is from a website.",
      "This image was taken in focus.",
    ];
    for (const claim of negatives) {
      expect(claimMayStateLocation(claim), claim).toBe(false);
    }
  });

  it("location positives: named places, lowercase places, and explicit taken/located frames", () => {
    const positives = [
      "this photo is from Delhi today",
      "This photo shows flooding in Delhi today",
      "This image was taken in London.",
      "This image was taken in london.",
      "London is where this image was taken.",
      "This image was taken in Bogota last night.",
      "The protest happened in Paris.",
      "This image was taken at the airport.",
      "This image was filmed in the street.",
      "The flood occurred in Chennai.",
      "This image is located in Gaza.",
      "The fire started in a warehouse.",
      "This photograph was taken near the Ganges.",
      "This image was taken inside a subway station.",
      "This image shows protesters in the street.",
      "This image shows people in the office.",
      "This image was taken in front of the White House.",
      "This image was taken in Hong Kong.",
      "This image was taken in New Delhi.",
      "This image was taken in the Old Delhi neighbourhood.",
      "This image is located in northern France.",
      "The President spoke in the Oval Office about the economy.",
      "This photo shows a protest in Tbilisi.",
    ];
    for (const claim of positives) {
      expect(claimMayStateLocation(claim), claim).toBe(true);
    }
  });

  it("keeps the original claim verbatim and never rewrites it", () => {
    const claim = "  London   is where THIS image was taken.  ";
    const r = claimLocationEligibility(claim);
    expect(r.claim).toBe(claim);
    expect(r.eligible).toBe(true);
  });

  it("records matched spans as inspectable evidence", () => {
    const r = claimLocationEligibility("London is where this image was taken.");
    expect(r.evidence.length).toBeGreaterThan(0);
    expect(r.reasons).toContain("subject_locative_copula");
    expect(r.reasons).toContain("named_place");
    expect(r.evidence.join(" ")).toContain("London");
  });

  it("explains a refusal with a typed reason and the refused candidates", () => {
    const person = claimLocationEligibility("This quote is from the minister.");
    expect(person.eligible).toBe(false);
    expect(person.rejectedBy).toBe("candidate_is_a_person");
    expect(person.rejected).toContain("minister");

    const nonPlace = claimLocationEligibility("This image was shared on Twitter.");
    expect(nonPlace.eligible).toBe(false);
    expect(nonPlace.rejectedBy).toBe("candidate_is_non_place");
    expect(nonPlace.rejected).toContain("Twitter");

    const noFrame = claimLocationEligibility("This image shows Alice smiling.");
    expect(noFrame.eligible).toBe(false);
    expect(noFrame.rejectedBy).toBe("no_locative_construction");

    const unknown = claimLocationEligibility("This image was taken in the flurb.");
    expect(unknown.eligible).toBe(false);
    expect(unknown.rejectedBy).toBe("candidate_not_a_place");
    // the determiner is not part of the name, so the refused span is the head
    expect(unknown.rejected).toContain("flurb");
  });

  it("derives no product verdict — the record carries no status/verdict field", () => {
    const r = claimLocationEligibility("This image was taken in London.");
    expect(Object.keys(r).sort()).toEqual([
      "claim",
      "eligible",
      "evidence",
      "reasons",
      "rejected",
      "rejectedBy",
    ]);
    for (const k of Object.keys(r)) {
      expect(k).not.toMatch(/verdict|status|result|outcome|confidence|decision/i);
    }
  });

  it("boolean view agrees with the record across a mixed corpus", () => {
    const corpus = [
      "London is where this image was taken.",
      "This image was taken in london.",
      "This image shows Alice smiling.",
      "this photo is from Delhi today",
      "this photo shows a flood today",
      "This image was shared on Twitter.",
      "The protest happened in Paris.",
      "This happened in 2019.",
      "",
      "   ",
    ];
    for (const claim of corpus) {
      expect(claimMayStateLocation(claim)).toBe(claimLocationEligibility(claim).eligible);
    }
  });
});

describe("evidenceQuestionsWithProvenance — additive, backward compatible", () => {
  it("returns the same question map evidenceQuestions would build", () => {
    const claim = "This image was taken in London.";
    const r = evidenceQuestionsWithProvenance({ claimMode: true, claim });
    expect(Object.keys(r.questions)).toEqual(
      Object.keys(
        evidenceQuestions({ claimMode: true, claimHasLocation: claimMayStateLocation(claim) }),
      ),
    );
    expect(r.questions.location_relation).toBeDefined();
    expect(r.locationEligibility!.claim).toBe(claim);
  });

  it("omits the location question and keeps the refusal rationale for no-location claims", () => {
    const claim = "This image shows Alice smiling.";
    const r = evidenceQuestionsWithProvenance({ claimMode: true, claim });
    expect(r.questions.location_relation).toBeUndefined();
    expect(r.locationEligibility!.eligible).toBe(false);
    expect(r.locationEligibility!.rejectedBy).toBe("no_locative_construction");
  });

  it("has no location record in trace mode", () => {
    const r = evidenceQuestionsWithProvenance({ claimMode: false, claim: "This image was taken in London." });
    expect(r.locationEligibility).toBeNull();
    expect(Object.keys(r.questions)).toEqual(Object.keys(RELEVANCE_QUESTION ? evidenceQuestions({ claimMode: false, claimHasLocation: false }) : {}));
  });

  it("tolerates a null claim in claim mode", () => {
    const r = evidenceQuestionsWithProvenance({ claimMode: true, claim: null });
    expect(r.locationEligibility).toBeNull();
    expect(Object.keys(r.questions)).toEqual(["relevance", "page_role", "context_relation", "claim_relation"]);
  });
});

/* --------------------------- answer validation --------------------------- */

describe("judgmentFromAnswers — typed answer validation at the boundary", () => {
  it("parses a valid trace-mode answer set", () => {
    const j = judgmentFromAnswers(traceAnswers, { claimMode: false });
    expect(j).not.toBeNull();
    expect(j!.relevance).toBeCloseTo(0.9);
    expect(j!.pageRole.reporting).toBeCloseTo(0.8);
    expect(j!.contextRelation).toBeNull();
    expect(j!.model).toBe(JEV_MODEL);
  });

  it("parses claim-mode relations", () => {
    const j = judgmentFromAnswers(claimAnswers, { claimMode: true });
    expect(j!.contextRelation!.differentContext).toBeCloseTo(0.8);
    expect(j!.claimRelation!.contradicts).toBeCloseTo(0.8);
    expect(j!.locationRelation!.sameLocation).toBeCloseTo(0.7);
  });

  it("degrades absent optional claim surfaces to null without rejecting the judgment", () => {
    const j = judgmentFromAnswers(claimAnswers, { claimMode: true });
    expect(j!.locationRelation).not.toBeNull();
    const noLocation = judgmentFromAnswers(
      { relevance: noul(0.9), page_role: choice("REPORTING", probs(PAGE_ROLE_KEYS, "REPORTING")) },
      { claimMode: true },
    );
    expect(noLocation).not.toBeNull();
    expect(noLocation!.claimRelation).toBeNull();
    expect(noLocation!.locationRelation).toBeNull();
  });

  it("returns null on malformed required surfaces — no heuristic fallback", () => {
    expect(judgmentFromAnswers({}, { claimMode: false })).toBeNull();
    expect(judgmentFromAnswers({ relevance: noul(2) }, { claimMode: false })).toBeNull();
    expect(
      judgmentFromAnswers({ ...traceAnswers, page_role: { type: "choice" } }, { claimMode: false }),
    ).toBeNull();
  });

  it("rejects a noul relevance that is not a finite 0..1 probability", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.01, 1.01, "0.9", null, undefined]) {
      expect(judgmentFromAnswers({ ...traceAnswers, relevance: noul(bad as number) }, { claimMode: false })).toBeNull();
    }
  });

  it("rejects a Choice answer whose options do not sum to 1", () => {
    const flat = { ...traceAnswers, page_role: choice("REPORTING", even(PAGE_ROLE_KEYS, 0.9)) };
    expect(judgmentFromAnswers(flat, { claimMode: false })).toBeNull();
    const under = { ...traceAnswers, page_role: choice("REPORTING", even(PAGE_ROLE_KEYS, 0.1)) };
    expect(judgmentFromAnswers(under, { claimMode: false })).toBeNull();
    expect(judgmentFromAnswers({ relevance: noul(0.5) }, { claimMode: false })).toBeNull();
  });

  it("accepts a distribution within the documented sum tolerance", () => {
    // 0.333 x 3 = 0.999 — the coarsest rounding a distribution is emitted with.
    const r = pairwiseFromAnswers({
      pairwise_context: choice("SAME_CONTEXT", {
        SAME_CONTEXT: 0.333,
        DIFFERENT_CONTEXT: 0.333,
        UNCLEAR: 0.333,
      }),
    });
    expect(r).not.toBeNull();
    expect(r!.sameContext).toBe(0.333);
    expect(Math.abs(0.333 * 3 - 1)).toBeLessThanOrEqual(JEV_PROBABILITY_SUM_TOLERANCE);
    // one step beyond the tolerance is refused
    expect(
      pairwiseFromAnswers({
        pairwise_context: choice("SAME_CONTEXT", {
          SAME_CONTEXT: 0.33,
          DIFFERENT_CONTEXT: 0.33,
          UNCLEAR: 0.33,
        }),
      }),
    ).toBeNull();
  });

  it("tolerance is a documented 1e-3, tight enough to reject a non-distribution", () => {
    expect(JEV_PROBABILITY_SUM_TOLERANCE).toBe(1e-3);
    // six options at 0.25 = 1.5 — outside tolerance, refused.
    expect(
      judgmentFromAnswers(
        { ...traceAnswers, page_role: choiceNoWinner(even(PAGE_ROLE_KEYS, 0.25)) },
        { claimMode: false },
      ),
    ).toBeNull();
    // six options summing to exactly 1 — accepted.
    expect(
      judgmentFromAnswers(
        {
          ...traceAnswers,
          page_role: choiceNoWinner(sumsToOne([0.25, 0.25, 0.2, 0.15, 0.1, 0.05])),
        },
        { claimMode: false },
      ),
    ).not.toBeNull();
    // 0.2 x 6 = 1.2 — refused.
    expect(
      judgmentFromAnswers(
        { ...traceAnswers, page_role: choiceNoWinner(sumsToOne([0.2, 0.2, 0.2, 0.2, 0.2, 0.2])) },
        { claimMode: false },
      ),
    ).toBeNull();
  });

  it("rejects a missing declared option", () => {
    const partial: Record<string, number> = { ...probs(PAGE_ROLE_KEYS, "REPORTING") };
    delete partial.OTHER;
    // the remaining five still sum inside tolerance, so only the missing
    // declared option can be the reason for refusal
    expect(
      judgmentFromAnswers({ ...traceAnswers, page_role: choice("REPORTING", partial) }, { claimMode: false }),
    ).toBeNull();
    const nulled: Record<string, number> = { ...probs(PAGE_ROLE_KEYS, "REPORTING"), OTHER: null as never };
    expect(
      judgmentFromAnswers({ ...traceAnswers, page_role: choice("REPORTING", nulled) }, { claimMode: false }),
    ).toBeNull();
  });

  it("rejects an undeclared/duplicate option key rather than dropping it", () => {
    const smuggled = { ...probs(PAGE_ROLE_KEYS, "REPORTING"), SMUGGLED_OPTION: 0 };
    expect(judgmentFromAnswers({ ...traceAnswers, page_role: choice("REPORTING", smuggled) }, { claimMode: false })).toBeNull();
    // the declared option replaced by a differently-cased alias
    const aliased: Record<string, number> = { ...probs(PAGE_ROLE_KEYS, "REPORTING") };
    aliased.reporting = aliased.REPORTING;
    delete aliased.REPORTING;
    expect(judgmentFromAnswers({ ...traceAnswers, page_role: choice("REPORTING", aliased) }, { claimMode: false })).toBeNull();
  });

  it("rejects a declared winner that names an option which was not offered", () => {
    const j = judgmentFromAnswers(
      { ...traceAnswers, page_role: choice("TOTALLY_MADE_UP_ROLE", probs(PAGE_ROLE_KEYS, "REPORTING")) },
      { claimMode: false },
    );
    expect(j).toBeNull();
  });

  it("rejects a non-string declared winner instead of coercing it", () => {
    for (const bad of [7, true, null, [], {}]) {
      const j = judgmentFromAnswers(
        {
          ...traceAnswers,
          page_role: { type: "choice", choice: bad, probabilities: probs(PAGE_ROLE_KEYS, "REPORTING") },
        },
        { claimMode: false },
      );
      expect(j).toBeNull();
    }
  });

  it("accepts an answer with no declared winner and invents nothing", () => {
    const j = judgmentFromAnswers(
      { ...traceAnswers, page_role: choiceNoWinner(probs(PAGE_ROLE_KEYS, "FACT_CHECK")) },
      { claimMode: false },
    );
    expect(j).not.toBeNull();
    expect(j!.pageRole.factCheck).toBeCloseTo(0.8);
    expect(j!.pageRole.reporting).toBeCloseTo(0.04);
  });

  it("rejects out-of-range and non-finite option probabilities", () => {
    // the range/finite check runs per option before the sum check, so each of
    // these is refused on its own terms
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.1, 1.5, "0.05", null, undefined]) {
      const p: Record<string, number> = {
        REPORTING: 0.8,
        FACT_CHECK: bad as number,
        SOCIAL_REPOST: 0.1,
        AGGREGATOR: 0.05,
        COMMENTARY: 0.025,
        OTHER: 0.025,
      };
      expect(
        judgmentFromAnswers({ ...traceAnswers, page_role: choice("REPORTING", p) }, { claimMode: false }),
        String(bad),
      ).toBeNull();
    }
  });

  it("rejects a Choice slot filled with the wrong answer type", () => {
    expect(
      judgmentFromAnswers({ ...traceAnswers, page_role: noul(0.9) }, { claimMode: false }),
    ).toBeNull();
    expect(judgmentFromAnswers({ ...traceAnswers, page_role: 0.9 }, { claimMode: false })).toBeNull();
    expect(judgmentFromAnswers({ ...traceAnswers, page_role: null }, { claimMode: false })).toBeNull();
    expect(judgmentFromAnswers({ ...traceAnswers, page_role: [1, 2] }, { claimMode: false })).toBeNull();
  });

  it("never produces a judgment from a partially valid answer set", () => {
    const halfValid = {
      relevance: noul(0.9),
      page_role: choice("REPORTING", { REPORTING: 0.5 }),
    };
    expect(judgmentFromAnswers(halfValid, { claimMode: false })).toBeNull();
  });

  it("validates optional claim surfaces with the same rules, degrading to null", () => {
    // Documented policy: a malformed *optional* surface degrades to a null
    // sub-judgment (§29 — never synthetic probabilities), while the required
    // relevance/page-role surfaces reject the whole judgment. No fabricated
    // value is ever substituted.
    const badContext = {
      ...claimAnswers,
      context_relation: choice("DIFFERENT_CONTEXT", even(CONTEXT_KEYS, 0.4)),
    };
    const degraded = judgmentFromAnswers(badContext, { claimMode: true });
    expect(degraded).not.toBeNull();
    expect(degraded!.contextRelation).toBeNull();
    expect(degraded!.claimRelation!.contradicts).toBeCloseTo(0.8);

    const badLocation = {
      ...claimAnswers,
      location_relation: choice("SAME_LOCATION", {
        SAME_LOCATION: 0.7,
        DIFFERENT_LOCATION: 0.1,
        LOCATION_NOT_STATED: 0.1,
        UNCLEAR: 0.1,
        EXTRA: 0.5,
      }),
    };
    const noLocation = judgmentFromAnswers(badLocation, { claimMode: true });
    expect(noLocation).not.toBeNull();
    expect(noLocation!.locationRelation).toBeNull();
    expect(noLocation!.contextRelation!.differentContext).toBeCloseTo(0.8);
  });

  it("a required-surface distribution violation rejects the whole judgment", () => {
    const badRequired = {
      relevance: noul(0.9),
      page_role: choice("REPORTING", even(PAGE_ROLE_KEYS, 0.4)),
    };
    expect(judgmentFromAnswers(badRequired, { claimMode: false })).toBeNull();
  });
});

describe("pairwiseFromAnswers", () => {
  it("parses pairwise context choice", () => {
    const r = pairwiseFromAnswers({
      pairwise_context: choice("SAME_CONTEXT", probs(PAIRWISE_KEYS, "SAME_CONTEXT")),
    });
    expect(r!.sameContext).toBeCloseTo(0.8);
    expect(r!.differentContext).toBeLessThan(0.8);
  });

  it("returns null on malformed pairwise answers", () => {
    expect(pairwiseFromAnswers({})).toBeNull();
    expect(pairwiseFromAnswers({ pairwise_context: { type: "noul", noul: 1 } })).toBeNull();
  });

  it("returns null on an unnormalized pairwise distribution", () => {
    expect(
      pairwiseFromAnswers({ pairwise_context: choice("SAME_CONTEXT", even(PAIRWISE_KEYS, 0.5)) }),
    ).toBeNull();
  });

  it("returns null when the distribution is missing an option", () => {
    expect(
      pairwiseFromAnswers({
        pairwise_context: choice("SAME_CONTEXT", { SAME_CONTEXT: 0.7, DIFFERENT_CONTEXT: 0.3 }),
      }),
    ).toBeNull();
  });
});

/* --------------------------- model provenance --------------------------- */

describe("resolveModelIdentity", () => {
  it("verified only when the provider reported the configured model exactly", () => {
    const id = resolveModelIdentity(JEV_MODEL, JEV_MODEL);
    expect(id).toEqual({
      requested: JEV_MODEL,
      reported: JEV_MODEL,
      status: "verified",
      pinned: true,
    });
  });

  it("unexpected when a different non-empty identity is reported", () => {
    expect(resolveModelIdentity(JEV_MODEL, "unexpected-model-v9")).toEqual({
      requested: JEV_MODEL,
      reported: "unexpected-model-v9",
      status: "unexpected",
      pinned: true,
    });
  });

  it("missing — never guessed — for absent, blank, non-string or array identities", () => {
    for (const reported of [undefined, null, "", "   ", 7, true, {}, [], ["jev-1.13.0"]]) {
      const id = resolveModelIdentity(JEV_MODEL, reported);
      expect(id.status, String(reported)).toBe("missing");
      expect(id.reported, String(reported)).toBeNull();
    }
  });

  it("keeps an explicit override inspectable instead of rewriting it", () => {
    const id = resolveModelIdentity("jev-1.14.0", "jev-1.14.0");
    expect(id).toEqual({
      requested: "jev-1.14.0",
      reported: "jev-1.14.0",
      status: "verified",
      pinned: false,
    });
    expect(id.requested).toBe("jev-1.14.0");
    expect(id.pinned).toBe(false);
  });

  it("a case-different identity is unexpected, not verified", () => {
    expect(resolveModelIdentity(JEV_MODEL, "JEV-1.13.0").status).toBe("unexpected");
    expect(resolveModelIdentity(JEV_MODEL, "jev-1.13.0 ").status).toBe("unexpected");
  });
});

describe("verifiedPinnedModel", () => {
  it("yields the pinned model only for a verified pinned identity", () => {
    expect(verifiedPinnedModel(verified)).toBe(JEV_MODEL);
  });

  it("yields null for unexpected, missing, unpinned and absent identities", () => {
    expect(verifiedPinnedModel(unexpected)).toBeNull();
    expect(verifiedPinnedModel(missing)).toBeNull();
    expect(verifiedPinnedModel(resolveModelIdentity("jev-1.14.0", "jev-1.14.0"))).toBeNull();
    expect(verifiedPinnedModel(null)).toBeNull();
    expect(verifiedPinnedModel(undefined)).toBeNull();
  });
});

describe("JevClient.ask — provider-boundary model validation", () => {
  it("posts the pinned model + questions map with bearer auth", async () => {
    const fetchImpl = jsonResponse({
      model: JEV_MODEL,
      answers: { relevance: { type: "noul", noul: 1 } },
    });
    const client = new JevClient({ apiKey: "k", fetchImpl: fetchImpl as never });
    const res = await client.ask({ x: 1 }, { pairwise_context: PAIRWISE_QUESTION });
    expect(res.model).toBe(JEV_MODEL);
    expect(res.identity.status).toBe("verified");
    expect(res.identity.pinned).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(JEV_ENDPOINT);
    expect(String((init.headers as Record<string, string>)["authorization"])).toBe("Bearer k");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe(JEV_MODEL);
    expect(body.questions.pairwise_context.type).toBe("choice");
  });

  it("REFUSES an unexpected model identity and never relabels it as jev-1.13.0", async () => {
    const fetchImpl = jsonResponse({ model: "unexpected-model-v9", answers: traceAnswers });
    const client = new JevClient({ apiKey: "k", fetchImpl: fetchImpl as never });
    await expect(
      client.ask({ x: 1 }, { relevance: RELEVANCE_QUESTION }),
    ).rejects.toBeInstanceOf(ProviderError);
    await expect(
      client.ask({ x: 1 }, { relevance: RELEVANCE_QUESTION }),
    ).rejects.toThrow(/model identity unexpected/);
  });

  it("REFUSES a response with no model identity at all", async () => {
    for (const body of [
      { answers: traceAnswers },
      { model: null, answers: traceAnswers },
      { model: "", answers: traceAnswers },
      { model: 7, answers: traceAnswers },
      { model: ["jev-1.13.0"], answers: traceAnswers },
    ]) {
      const client = new JevClient({
        apiKey: "k",
        fetchImpl: jsonResponse(body) as never,
      });
      await expect(
        client.ask({ x: 1 }, { relevance: RELEVANCE_QUESTION }),
      ).rejects.toThrow(/model identity missing/);
    }
  });

  it("sanitizes the refusal — no URL, token or provider body in the message", async () => {
    const client = new JevClient({
      apiKey: "super-secret-token",
      fetchImpl: jsonResponse({
        model: "unexpected-model-v9",
        answers: traceAnswers,
        secret: "do-not-log",
      }) as never,
    });
    const err = await client.ask({ x: 1 }, { relevance: RELEVANCE_QUESTION }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    const msg = (err as ProviderError).message;
    expect(msg).toContain("unexpected-model-v9");
    expect(msg).toContain(JEV_MODEL);
    expect(msg).not.toContain("super-secret-token");
    expect(msg).not.toContain("do-not-log");
    expect(msg).not.toContain("https://");
    expect((err as ProviderError).kind).toBe("malformed");
  });

  it("REFUSES a verified but unpinned override rather than labelling it jev-1.13.0", async () => {
    const fetchImpl = jsonResponse({ model: "jev-1.14.0", answers: traceAnswers });
    const client = new JevClient({
      apiKey: "k",
      model: "jev-1.14.0",
      fetchImpl: fetchImpl as never,
    });
    expect(client.model).toBe("jev-1.14.0");
    // the override is really sent on the wire, unmodified
    await expect(
      client.ask({ x: 1 }, { relevance: RELEVANCE_QUESTION }),
    ).rejects.toBeInstanceOf(ProviderError);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).model).toBe("jev-1.14.0");
    // ...and the pinned label stays unclaimed
    expect(verifiedPinnedModel(resolveModelIdentity("jev-1.14.0", "jev-1.14.0"))).toBeNull();
  });

  it("rejects a non-object response body", async () => {
    for (const body of [null, 7, "ok", [1, 2]]) {
      const client = new JevClient({ apiKey: "k", fetchImpl: jsonResponse(body) as never });
      await expect(
        client.ask({ x: 1 }, { relevance: RELEVANCE_QUESTION }),
      ).rejects.toThrow(/not a JSON object/);
    }
  });

  it("returns empty answers — not a throw — when a verified response omits `answers`", async () => {
    const client = new JevClient({
      apiKey: "k",
      fetchImpl: jsonResponse({ model: JEV_MODEL }) as never,
    });
    const res = await client.ask({ x: 1 }, { relevance: RELEVANCE_QUESTION });
    expect(res.answers).toEqual({});
    expect(res.identity.status).toBe("verified");
    expect(judgmentFromAnswers(res.answers, { claimMode: false })).toBeNull();
  });

  it("an unexpected model can reach no judgment through the real client path", async () => {
    const client = new JevClient({
      apiKey: "k",
      fetchImpl: jsonResponse({ model: "unexpected-model-v9", answers: traceAnswers }) as never,
    });
    // exactly the Astra probe shape: ask() never yields answers, so
    // judgmentFromAnswers is never reached with relabeled probabilities.
    await expect(client.ask({}, { relevance: RELEVANCE_QUESTION })).rejects.toBeInstanceOf(
      ProviderError,
    );
  });
});

describe("model provenance as a validation-boundary input", () => {
  it("rejects the judgment when the supplied identity is unexpected or missing", () => {
    expect(judgmentFromAnswers(traceAnswers, { claimMode: false, provenance: unexpected })).toBeNull();
    expect(judgmentFromAnswers(traceAnswers, { claimMode: false, provenance: missing })).toBeNull();
    expect(judgmentFromAnswers(traceAnswers, { claimMode: false, provenance: null })).toBeNull();
  });

  it("rejects an override identity even though it verified on the wire", () => {
    const override = resolveModelIdentity("jev-1.14.0", "jev-1.14.0");
    expect(judgmentFromAnswers(traceAnswers, { claimMode: false, provenance: override })).toBeNull();
  });

  it("accepts and labels the pinned model for a verified identity", () => {
    const j = judgmentFromAnswers(traceAnswers, { claimMode: false, provenance: verified });
    expect(j).not.toBeNull();
    expect(j!.model).toBe(JEV_MODEL);
  });

  it("gates the pairwise judgment on the same identity", () => {
    const answers = { pairwise_context: choice("SAME_CONTEXT", probs(PAIRWISE_KEYS, "SAME_CONTEXT")) };
    expect(pairwiseFromAnswers(answers, unexpected)).toBeNull();
    expect(pairwiseFromAnswers(answers, missing)).toBeNull();
    expect(pairwiseFromAnswers(answers, verified)).not.toBeNull();
    expect(pairwiseFromAnswers(answers)).not.toBeNull();
  });

  it("keeps the pre-existing two-field call shape working", () => {
    const j = judgmentFromAnswers(traceAnswers, { claimMode: false });
    expect(j!.model).toBe(JEV_MODEL);
  });

  it("the judgment model is the constant, never a provider-supplied string", () => {
    for (const claimed of [verified, unexpected, missing, null, undefined]) {
      const j = judgmentFromAnswers(traceAnswers, { claimMode: false, provenance: claimed });
      if (j !== null) expect(j.model).toBe(JEV_MODEL);
    }
  });
});
