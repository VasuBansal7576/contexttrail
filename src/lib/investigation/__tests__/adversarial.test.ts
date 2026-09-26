/**
 * Astra independent-recheck adversarial regressions (durable negatives).
 *
 * Each test encodes a reproduced correctness defect from
 * backend-remediation-recheck.md at pinned f4e8761. These assert the
 * REQUIRED behavior — they fail while the defect stands.
 */

import { describe, expect, it } from "vitest";
import { makeExact, makeJudgment } from "./testkit";
import { refineReportingOrigins } from "../origin-evidence";
import { evaluateClaimPolicy } from "../policy";
import { extractPage } from "../../pages/extract";
import { runInvestigation, selectDeepReadCandidates } from "../run";
import {
  buildContextSegments,
  datedCoreOccurrences,
  pairKey,
  selectDatedCoreOccurrences,
} from "../divergence";
import { buildTimeline } from "../timeline";
import type { EvidenceCandidate } from "../contracts/evidence";
import type { FetchedPage } from "../../pages/fetch";

const strongConflictJudgment = () =>
  makeJudgment({
    contextRelation: {
      sameContext: 0.01,
      differentContext: 0.97,
      historicalReference: 0.01,
      unclear: 0.01,
    },
  });

const conflictPair = (): [EvidenceCandidate, EvidenceCandidate] => [
  makeExact({ id: "a", judgment: strongConflictJudgment() }),
  makeExact({ id: "b", judgment: strongConflictJudgment() }),
];

// Distinct filler per call site — shingle duplication must NOT be what
// clusters the pages; only the named-provider evidence may group them.
const filler = (w: string, seed: string) => `${w} ${(seed + " ").repeat(30)}`;

describe("F01 adversarial — names do not establish separate origins", () => {
  it("two pages both crediting the same named provider share one group — no synthetic conflict", () => {
    const [a, b] = conflictPair();
    const texts = new Map([
      [a.id, filler("The image was released by Reuters as a handout.", "alpha bravo charlie delta echo")],
      [b.id, filler("The image was released by Reuters as a handout.", "foxtrot golf hotel india juliet")],
    ]);
    refineReportingOrigins([a, b], texts);
    // Shared named provider resolves to ONE group, not two separate origins.
    expect(a.reportingOrigin.status).not.toBe("separate_origin_evidenced");
    expect(b.reportingOrigin.status).not.toBe("separate_origin_evidenced");
    expect(a.reportingOrigin.status).toBe("shared_origin");
    expect(b.reportingOrigin.status).toBe("shared_origin");
    expect(a.reportingOrigin.groupId).toBe(b.reportingOrigin.groupId);
    expect(evaluateClaimPolicy([a, b]).status).not.toBe("CONTEXT_CONFLICT");
  });

  it("unrelated named bylines prove authorship at most — not separate media origins", () => {
    const [a, b] = conflictPair();
    const texts = new Map([
      [a.id, filler("Written by Jane Doe for the sports section. The article discusses basketball results.", "kilo lima mike november oscar")],
      [b.id, filler("Written by Sam Roe for the weather desk. The article discusses tomorrow's forecast.", "papa quebec romeo sierra tango")],
    ]);
    refineReportingOrigins([a, b], texts);
    expect(a.reportingOrigin.status).toBe("unresolved");
    expect(b.reportingOrigin.status).toBe("unresolved");
    expect(evaluateClaimPolicy([a, b]).status).not.toBe("CONTEXT_CONFLICT");
  });

  it("a next-sentence disclaimer voids an otherwise qualifying attribution", () => {
    const a = makeExact({
      id: "neg",
      sourceUrl: "https://herald.example.org/story",
      canonicalUrl: "https://herald.example.org/story",
      domain: "herald.example.org",
      registrableDomain: "herald.example.org",
    });
    const text = filler(
      "Reported by Jane Doe for the Herald. This attribution is false.",
      "uniform victor whiskey xray yankee",
    );
    refineReportingOrigins([a], new Map([[a.id, text]]));
    expect(a.reportingOrigin.status).toBe("unresolved");
  });

  it("positive control — named byline AND media-bound publisher on the page's own outlet evidence separate origin", () => {
    const a = makeExact({
      id: "own",
      sourceUrl: "https://dailyexaminer.example.org/story",
      canonicalUrl: "https://dailyexaminer.example.org/story",
      domain: "dailyexaminer.example.org",
      registrableDomain: "dailyexaminer.example.org",
    });
    const text = filler(
      "Reported by Jane Doe for the Daily Examiner. The photograph was first published by the Daily Examiner.",
      "zulu seven eight nine ten eleven",
    );
    refineReportingOrigins([a], new Map([[a.id, text]]));
    expect(a.reportingOrigin.status).toBe("separate_origin_evidenced");
    expect(a.reportingOrigin.evidenceIds).toContain(a.id);
  });
});

describe("F06 adversarial — entity binding, not just type filtering", () => {
  it("an unrelated nested article date cannot beat the fetched page's mainEntity date", () => {
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({
      "@type": "WebPage",
      url: "https://target.example.org/story",
      hasPart: {
        "@type": "ItemList",
        itemListElement: [
          {
            "@type": "NewsArticle",
            url: "https://other.example.org/related",
            datePublished: "1999-01-01",
          },
        ],
      },
      mainEntity: {
        "@type": "NewsArticle",
        url: "https://target.example.org/story",
        datePublished: "2024-01-01",
      },
    })}</script></head><body><article>Actual story</article></body></html>`;
    const ex = extractPage(html);
    // The 1999 related-article date is not a publication candidate for
    // THIS page; the mainEntity date is bound and preserved.
    expect(ex.jsonLdDates).toEqual(["2024-01-01"]);
  });
});

describe("F05 adversarial — displayed chronology coverage", () => {
  const mixed = () => [
    makeExact({ id: "day-2019", publishedAt: "2019-01-01", dateStatus: "usable", datePrecision: "day" }),
    makeExact({ id: "month-2020", publishedAt: "2020-06", dateStatus: "usable", datePrecision: "month" }),
    makeExact({ id: "day-2021", publishedAt: "2021-01-01", dateStatus: "usable", datePrecision: "day" }),
  ];

  it("a displayed month-precision occurrence is orderable via intervals — it counts in coverage", () => {
    const cs = mixed();
    const eligible = datedCoreOccurrences(cs);
    // The month item is displayed in the timeline; coverage must not
    // silently drop it while claiming a complete run.
    expect(eligible.map((c) => c.id)).toEqual(["day-2019", "month-2020", "day-2021"]);
    const selected = selectDatedCoreOccurrences(eligible);
    const judgments = new Map([
      [pairKey("day-2019", "month-2020"), { sameContext: 0.9, differentContext: 0.05, unclear: 0.05 }],
      [pairKey("month-2020", "day-2021"), { sameContext: 0.9, differentContext: 0.05, unclear: 0.05 }],
    ]);
    const seg = buildContextSegments(eligible, selected, judgments);
    expect(seg.coverage).toEqual({ eligible: 3, selected: 3, comparedPairs: 2 });
    expect(seg.contextSegmentCount).toBe(1);
  });

  it("an unorderable imprecise date cannot claim exact coverage — count stays null", () => {
    const cs = [
      makeExact({ id: "day-a", publishedAt: "2019-06-05", dateStatus: "usable", datePrecision: "day" }),
      makeExact({ id: "month-2019", publishedAt: "2019-06", dateStatus: "usable", datePrecision: "month" }),
      makeExact({ id: "day-b", publishedAt: "2019-06-20", dateStatus: "usable", datePrecision: "day" }),
    ];
    const eligible = datedCoreOccurrences(cs);
    const selected = selectDatedCoreOccurrences(eligible);
    // June's interval overlaps both days — neither adjacent transition is
    // orderable, so no exact segment count may be asserted.
    const seg = buildContextSegments(eligible, selected, new Map());
    expect(seg.contextSegmentCount).toBeNull();
    expect(seg.coverage.eligible).toBe(3);
  });

  it("equal same-day dates cannot manufacture an ordered divergence", () => {
    const cs = [
      makeExact({ id: "same-day-a", publishedAt: "2024-01-01", dateStatus: "usable", datePrecision: "day" }),
      makeExact({ id: "same-day-b", publishedAt: "2024-01-01", dateStatus: "usable", datePrecision: "day" }),
    ];
    const eligible = datedCoreOccurrences(cs);
    const judgments = new Map([
      [pairKey("same-day-a", "same-day-b"), { sameContext: 0.01, differentContext: 0.98, unclear: 0.01 }],
    ]);
    const seg = buildContextSegments(eligible, eligible, judgments);
    // Identical dates are not strictly ordered — no ordered divergence
    // edge may be produced, and no exact count claimed.
    expect(seg.firstObservedContextDivergence).toBeNull();
    expect(seg.contextSegmentCount).toBeNull();
    const tl = buildTimeline(cs, seg);
    expect(tl.timeline.find((t) => t.isFirstObservedDivergencePoint)).toBeUndefined();
  });
});

describe("F09 adversarial — fact-check priority survives tie-breaks", () => {
  it("the strongest fact-check is selected even under relevance pressure", () => {
    const fact = makeExact({
      id: "strong-factcheck",
      judgment: makeJudgment({
        relevance: 0.8,
        pageRole: { factCheck: 0.97, reporting: 0.01, socialRepost: 0, aggregator: 0, commentary: 0.01, other: 0.01 },
        contextRelation: null,
        claimRelation: null,
      }),
    });
    const distractions = Array.from({ length: 5 }, (_, i) =>
      makeExact({
        id: `higher-relevance-${i}`,
        judgment: makeJudgment({
          relevance: 0.99 - i * 0.01,
          pageRole: { factCheck: 0, reporting: 0.1, socialRepost: 0, aggregator: 0, commentary: 0.9, other: 0 },
          contextRelation: null,
          claimRelation: null,
        }),
      }),
    );
    const picked = selectDeepReadCandidates([...distractions, fact]).map((c) => c.id);
    expect(picked).toContain("strong-factcheck");
  });
});

/* --------------------- run-level adversarial probes -------------------- */

const GOOD_ANSWERS = {
  relevance: { type: "noul", noul: 0.9 },
  page_role: {
    type: "choice",
    choice: "REPORTING",
    probabilities: { REPORTING: 0.8, FACT_CHECK: 0.05, SOCIAL_REPOST: 0.05, AGGREGATOR: 0.05, COMMENTARY: 0.03, OTHER: 0.02 },
  },
  context_relation: {
    type: "choice",
    choice: "SAME_CONTEXT",
    probabilities: { SAME_CONTEXT: 0.9, DIFFERENT_CONTEXT: 0.04, HISTORICAL_REFERENCE: 0.03, UNCLEAR: 0.03 },
  },
  claim_relation: {
    type: "choice",
    choice: "SUPPORTS",
    probabilities: { SUPPORTS: 0.9, CONTRADICTS: 0.02, NEUTRAL: 0.03, INSUFFICIENT: 0.05 },
  },
};

const fetchPageStub = async (url: string): Promise<FetchedPage> => ({
  url,
  html: `<html><body><article><p>${"Controlled factual page body. ".repeat(25)}</p></article></body></html>`,
});

const baseSerp = {
  uploadImage: async () => "controlled",
  search: async (p: { engine?: string; type?: string }) =>
    p.engine === "google_lens" && p.type === "exact_matches"
      ? { exact_matches: [{ title: "controlled exact", link: "https://unique.example.org/item" }] }
      : p.type === "about_this_image"
        ? { about_this_image: { sections: [] } }
        : p.engine === "google_lens"
          ? { visual_matches: [] }
          : p.engine === "google_news"
            ? { news_results: [] }
            : { organic_results: [] },
};

describe("run-level adversarial probes", () => {
  it("a fast exact-Lens batch is discovered without waiting for the About job", async () => {
    let release: (v: unknown) => void = () => {};
    const gate = new Promise((r) => {
      release = r;
    });
    const events: Array<{ type: string }> = [];
    const promise = runInvestigation(
      { media: new Uint8Array([1]), claim: null, timezone: "UTC", locale: "en" },
      (e) => events.push(e),
      {
        serpapi: {
          uploadImage: async () => "controlled",
          search: async (p: { type?: string }) => {
            if (p.type === "about_this_image") return gate;
            if (p.type === "exact_matches") {
              return { exact_matches: [{ title: "fast exact", link: "https://fast-exact.example.org/item" }] };
            }
            return { visual_matches: [] };
          },
        } as never,
        jev: { ask: async () => ({ answers: GOOD_ANSWERS, model: "jev-1.13.0" }) } as never,
        fetchPage: fetchPageStub,
      },
    );
    await new Promise((r) => setTimeout(r, 150));
    const earlyDiscovered = events.filter((e) => e.type === "evidence.discovered").length;
    release({ about_this_image: { sections: [] } });
    await promise;
    expect(earlyDiscovered).toBeGreaterThan(0);
  });

  it("FINAL_POLICY completes before the COMPLETE stage finishes", async () => {
    const events: Array<{ type: string; stage?: string }> = [];
    await runInvestigation(
      { media: new Uint8Array([1]), claim: null, timezone: "UTC", locale: "en" },
      (e) => events.push(e),
      {
        serpapi: baseSerp as never,
        jev: { ask: async () => ({ answers: GOOD_ANSWERS, model: "jev-1.13.0" }) } as never,
        fetchPage: fetchPageStub,
      },
    );
    const completed = events
      .filter((e) => e.type === "stage.completed")
      .map((e) => e.stage);
    expect(completed).toContain("FINAL_POLICY");
    expect(completed.indexOf("FINAL_POLICY")).toBeLessThan(completed.indexOf("COMPLETE"));
  });

  it("trace mode reports unresolved reporting origins as a limitation", async () => {
    const events: Array<{ type: string; result?: { limitations?: string[] } }> = [];
    await runInvestigation(
      { media: new Uint8Array([1]), claim: null, timezone: "UTC", locale: "en" },
      (e) => events.push(e),
      {
        serpapi: baseSerp as never,
        jev: { ask: async () => ({ answers: GOOD_ANSWERS, model: "jev-1.13.0" }) } as never,
        fetchPage: fetchPageStub,
      },
    );
    const result = events.find((e) => e.type === "investigation.completed")?.result;
    expect(result?.limitations).toContain("reporting_origins_unresolved");
  });

  it("zero successful classifications is unavailable, not partial", async () => {
    const events: Array<{ type: string; result?: { limitations?: string[] } }> = [];
    await runInvestigation(
      { media: new Uint8Array([1]), claim: "controlled claim", timezone: "UTC", locale: "en" },
      (e) => events.push(e),
      {
        serpapi: baseSerp as never,
        jev: {
          ask: async () => {
            throw new Error("controlled failure");
          },
        } as never,
        fetchPage: fetchPageStub,
      },
    );
    const result = events.find((e) => e.type === "investigation.completed")?.result;
    expect(result?.limitations).toContain("semantic_classification_unavailable");
    expect(result?.limitations).not.toContain("semantic_classification_partial");
  });
});
