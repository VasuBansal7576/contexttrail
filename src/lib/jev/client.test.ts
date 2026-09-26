import { describe, expect, it, vi } from "vitest";
import {
  JevClient,
  JEV_ENDPOINT,
  JEV_MODEL,
  judgmentFromAnswers,
  pairwiseFromAnswers,
} from "./client";
import {
  claimMayStateLocation,
  evidenceQuestions,
  PAIRWISE_QUESTION,
} from "./questions";

const noul = (n: number) => ({ type: "noul", noul: n });
const choice = (c: string, probs: Record<string, number>) => ({
  type: "choice",
  choice: c,
  probabilities: probs,
});

const PAGE_ROLE_KEYS = ["REPORTING", "FACT_CHECK", "SOCIAL_REPOST", "AGGREGATOR", "COMMENTARY", "OTHER"];
const probs = (keys: string[], winner: string, p = 0.8) =>
  Object.fromEntries(keys.map((k) => [k, k === winner ? p : (1 - p) / (keys.length - 1)]));

const traceAnswers = {
  relevance: noul(0.9),
  page_role: choice("REPORTING", probs(PAGE_ROLE_KEYS, "REPORTING")),
};

const claimAnswers = {
  ...traceAnswers,
  context_relation: choice(
    "DIFFERENT_CONTEXT",
    probs(["SAME_CONTEXT", "DIFFERENT_CONTEXT", "HISTORICAL_REFERENCE", "UNCLEAR"], "DIFFERENT_CONTEXT"),
  ),
  claim_relation: choice(
    "CONTRADICTS",
    probs(["SUPPORTS", "CONTRADICTS", "NEUTRAL", "INSUFFICIENT"], "CONTRADICTS"),
  ),
};

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
});

describe("claimMayStateLocation", () => {
  it("detects capitalized place tokens, not stop words", () => {
    expect(claimMayStateLocation("this photo is from Delhi today")).toBe(true);
    expect(claimMayStateLocation("this photo shows a flood today")).toBe(false);
  });
});

describe("judgmentFromAnswers", () => {
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
    expect(j!.locationRelation).toBeNull();
  });

  it("returns null on malformed required surfaces — no heuristic fallback", () => {
    expect(judgmentFromAnswers({}, { claimMode: false })).toBeNull();
    expect(
      judgmentFromAnswers({ relevance: { type: "noul", noul: 2 }, ...{} }, { claimMode: false }),
    ).toBeNull();
    expect(
      judgmentFromAnswers({ ...traceAnswers, page_role: { type: "choice" } }, { claimMode: false }),
    ).toBeNull();
  });
});

describe("pairwiseFromAnswers", () => {
  it("parses pairwise context choice", () => {
    const r = pairwiseFromAnswers({
      pairwise_context: choice(
        "SAME_CONTEXT",
        probs(["SAME_CONTEXT", "DIFFERENT_CONTEXT", "UNCLEAR"], "SAME_CONTEXT"),
      ),
    });
    expect(r!.sameContext).toBeCloseTo(0.8);
    expect(r!.differentContext).toBeLessThan(0.8);
  });

  it("returns null on malformed pairwise answers", () => {
    expect(pairwiseFromAnswers({})).toBeNull();
    expect(pairwiseFromAnswers({ pairwise_context: { type: "noul", noul: 1 } })).toBeNull();
  });
});

describe("JevClient.ask", () => {
  it("posts pinned model + questions map with bearer auth", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ model: JEV_MODEL, answers: { relevance: { type: "noul", noul: 1 } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new JevClient({ apiKey: "k", fetchImpl: fetchImpl as never });
    const res = await client.ask({ x: 1 }, { pairwise_context: PAIRWISE_QUESTION });
    expect(res.model).toBe(JEV_MODEL);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(JEV_ENDPOINT);
    expect(String((init.headers as Record<string, string>)["authorization"])).toBe("Bearer k");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe(JEV_MODEL);
    expect(body.questions.pairwise_context.type).toBe("choice");
  });
});
