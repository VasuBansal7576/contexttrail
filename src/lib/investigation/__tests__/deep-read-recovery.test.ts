import { describe, expect, it } from "vitest";
import { runInvestigation, selectDeepReadCandidates, type SearchProvider } from "../run";
import { evaluateClaimPolicy } from "../policy";
import { makeCandidate, makeExact, makeJudgment } from "./testkit";
import { JevClient } from "../../jev/client";
import type { InvestigationEvent } from "../contracts/events";

const weakCore = (id: string, relevance = 0.42, serpPosition = 1) =>
  makeExact({
    id,
    serpPosition,
    judgment: makeJudgment({
      relevance,
      contextRelation: null,
      claimRelation: null,
      pageRole: { reporting: 0, factCheck: 0, socialRepost: 0, aggregator: 0, commentary: 0, other: 1 },
    }),
  });

const contextualPages = () =>
  Array.from({ length: 6 }, (_, i) =>
    makeCandidate({
      id: `context-${i}`,
      retrievalKind: "google_news",
      mediaRelationship: null,
      judgment: makeJudgment({ relevance: 0.99 - i * 0.01 }),
    }),
  );

describe("undated core deep-read recovery", () => {
  it("uses remaining slots for independent undated image occurrences before contextual filler", () => {
    const first=weakCore("first-core",0.4,1);
    const second=weakCore("second-core",0.3,2);
    second.registrableDomain="other.example.org";
    const third=weakCore("third-core",0.2,3);
    third.registrableDomain="third.example.org";
    const picked=selectDeepReadCandidates([...contextualPages(),third,second,first]);
    expect(picked).toHaveLength(5);
    expect(picked).toEqual(expect.arrayContaining([first,second,third]));
    expect(picked[0]).toBe(first);
    expect(first.publishedAt).toBeNull();
  });
  it("reserves one page for the strongest judged core when contextual results would occupy all five slots", () => {
    const core = weakCore("undated-core");
    const picked = selectDeepReadCandidates([...contextualPages(), core]);
    expect(picked[0]).toBe(core);
    expect(picked).toHaveLength(5);
    expect(picked.filter((c) => c.mediaRelationship === "EXACT_MATCH")).toHaveLength(1);
  });

  it("preserves the dated-first path without adding an extra undated priority slot", () => {
    const dated = makeExact({
      id: "dated-core",
      publishedAt: "2011-05-01",
      dateStatus: "usable",
      datePrecision: "day",
    });
    const undated = weakCore("undated-core");
    const picked = selectDeepReadCandidates([...contextualPages(), undated, dated]);
    expect(picked[0]).toBe(dated);
    expect(picked).toHaveLength(5);
    expect(picked).not.toContain(undated);
  });

  it("does not reserve a recovery slot for unclassified core evidence or visual leads", () => {
    const unclassified = makeExact({ id: "unclassified", judgment: null });
    const lead = makeCandidate({ id: "lead", judgment: makeJudgment({ relevance: 0.01 }) });
    const picked = selectDeepReadCandidates([...contextualPages(), unclassified, lead]);
    expect(picked).toHaveLength(5);
    expect(picked).not.toContain(unclassified);
    expect(picked).not.toContain(lead);
  });

  it("uses relevance, provider rank, and id as stable tie-breakers", () => {
    const candidates = [weakCore("z", 0.4, 2), weakCore("b", 0.42, 2), weakCore("a", 0.42, 2)];
    expect(selectDeepReadCandidates(candidates, 1).map((c) => c.id)).toEqual(["a"]);
    expect(selectDeepReadCandidates([...candidates].reverse(), 1).map((c) => c.id)).toEqual(["a"]);
    expect(selectDeepReadCandidates([...candidates, weakCore("rank-first", 0.42, 1)], 1).map((c) => c.id)).toEqual(["rank-first"]);
  });

  it("deduplicates an anchor that also wins another category and preserves the caller's cap", () => {
    const anchor = makeExact({ id: "anchor", judgment: makeJudgment() });
    const picked = selectDeepReadCandidates([anchor, ...contextualPages()], 3);
    expect(picked).toHaveLength(3);
    expect(picked.filter((c) => c.id === anchor.id)).toHaveLength(1);
    expect(selectDeepReadCandidates([anchor], 0)).toEqual([]);
  });

  it("keeps disputed dates unresolved and never promotes evidence merely by selecting it", () => {
    const candidate = weakCore("disputed-core");
    candidate.dateStatus = "disputed";
    const before = structuredClone(candidate);
    const picked = selectDeepReadCandidates([...contextualPages(), candidate]);
    expect(picked[0]).toBe(candidate);
    expect(candidate).toEqual(before);
    expect(candidate.publishedAt).toBeNull();
    expect(evaluateClaimPolicy([candidate]).status).toBe("INSUFFICIENT_EVIDENCE");
  });

  it.each(["negative page", "failed page"])("preserves an honest insufficient result after a %s recovery read", async (outcome) => {
    const anchorUrl = "https://anchor.example.org/image";
    const contextualResults = Array.from({ length: 5 }, (_, i) => ({
      position: i + 1,
      title: `Contextual result ${i}`,
      link: `https://context-${i}.example.org/article`,
      snippet: "Current reporting about the event, without image provenance.",
    }));
    const serpapi: SearchProvider = {
      uploadImage: async () => "controlled-image-id",
      search: async (params) => {
        if (params.type === "exact_matches") return { exact_matches: [{ position: 1, title: "Undated image page", link: anchorUrl }] };
        if (params.engine === "google") return { organic_results: contextualResults };
        if (params.engine === "google_news") return { news_results: contextualResults };
        return {};
      },
    };
    let classifications = 0;
    const jev = new JevClient({
      apiKey: "controlled-test-key",
      fetchImpl: async () => {
        classifications += 1;
        return Response.json({
          model: "jev-1.13.0",
          answers: {
            relevance: { type: "noul", noul: 0.2 },
            page_role: {
              type: "choice", choice: "REPORTING",
              probabilities: { REPORTING: 0.9, FACT_CHECK: 0.02, SOCIAL_REPOST: 0.02, AGGREGATOR: 0.02, COMMENTARY: 0.02, OTHER: 0.02 },
            },
          },
        });
      },
    });
    const fetched: string[] = [];
    const events: InvestigationEvent[] = [];
    await runInvestigation(
      { media: new Uint8Array([1]), claim: "This image shows a recent event", timezone: "UTC", locale: "en" },
      (event) => events.push(event),
      {
        serpapi,
        jev,
        fetchPage: async (url) => {
          fetched.push(url);
          if (outcome === "failed page") throw new Error("Controlled source unavailable");
          return { url, html: `<html><head><title>Unrelated source</title></head><body><article><p>${"This page provides no date or context evidence for the submitted image. ".repeat(30)}</p></article></body></html>` };
        },
      },
    );
    expect(fetched[0]).toBe(anchorUrl);
    expect(fetched).toHaveLength(5);
    const terminal = events.find((event) => event.type === "investigation.completed");
    expect(terminal?.type).toBe("investigation.completed");
    if (terminal?.type !== "investigation.completed") throw new Error("Missing completed investigation");
    expect(terminal.result.mode).toBe("claim_check");
    if (terminal.result.mode !== "claim_check") throw new Error("Unexpected trace result");
    expect(terminal.result.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(terminal.result.earliestObservedOccurrence).toBeNull();
    // Six initial judgments; each of the five successful page reads is
    // reclassified. A failed fetch keeps the measured metadata judgment.
    expect(classifications).toBe(outcome === "negative page" ? 11 : 6);
  });
});
