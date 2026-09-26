/**
 * Astra-remediation regression gates (findings F01–F11).
 *
 * Each test encodes the REQUIRED behavior and reproduced the original
 * defect before its fix. Controlled inputs only — these exercise production
 * functions, never helper self-reports.
 */
import { describe, expect, it, vi } from "vitest";
import { makeCandidate, makeExact, makeJudgment } from "./testkit";
import { refineReportingOrigins } from "../origin-evidence";
import { evaluateClaimPolicy, deriveTakeaways } from "../policy";
import {
  buildContextSegments,
  selectDatedCoreOccurrences,
  pairKey,
} from "../divergence";
import { parseClaimDate, parseDateValue } from "../dates";
import { extractPage } from "../../pages/extract";
import { normalizeSearchResponse } from "../../serpapi/normalize";
import { buildTimeline } from "../timeline";
import { selectDeepReadCandidates, runInvestigation } from "../run";
import type { EvidenceCandidate } from "../contracts/evidence";
import type { TimelineItem } from "../contracts/investigation";
import type { SearchProvider } from "../run";
import type { JevClient } from "../../jev/client";
import type { FetchedPage } from "../../pages/fetch";
import type { JsonRecord } from "../../stream/events";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/* --------------------------------- F01 ---------------------------------- */

describe("F01 — reporting-origin inference needs positive attributed proof", () => {
  const pair = (): [EvidenceCandidate, EvidenceCandidate] => [
    makeExact({
      id: "a",
      judgment: makeJudgment({
        contextRelation: {
          sameContext: 0.01,
          differentContext: 0.97,
          historicalReference: 0.01,
          unclear: 0.01,
        },
      }),
    }),
    makeExact({
      id: "b",
      sourceUrl: "https://other-example.com/x",
      canonicalUrl: "https://other-example.com/x",
      domain: "other-example.com",
      registrableDomain: "other-example.com",
      judgment: makeJudgment({
        contextRelation: {
          sameContext: 0.01,
          differentContext: 0.97,
          historicalReference: 0.01,
          unclear: 0.01,
        },
      }),
    }),
  ];

  it("negated, anonymous, or merely-mentioned reporting stays unresolved", () => {
    const [a, b] = pair();
    const [c, d] = pair();
    c.id = "c";
    d.id = "d";
    refineReportingOrigins(
      [a, b, c, d],
      new Map([
        // Negated mentions — the outlet's staff explicitly not involved.
        [a.id, "alpha bravo charlie " + "The reporters were not involved in producing this image or this report. " + "delta echo foxtrot ".repeat(30)],
        // Anonymous self-assertion — no inspectable named attribution.
        [b.id, "golf hotel india " + "Our investigation first published this photograph after verifying its source. " + "juliet kilo lima ".repeat(30)],
        // Unattributed claim — outlet named no source at all.
        [c.id, "mike november oscar " + "This outlet first reported the event and broke the story. " + "papa quebec romeo ".repeat(30)],
        // Mere mention of staff — no attributed act of original reporting.
        [d.id, "sierra tango uniform " + "The staff have no knowledge of the origin of this photograph. " + "victor whiskey xray ".repeat(30)],
      ]),
    );
    for (const cand of [a, b, c, d]) {
      expect(cand.reportingOrigin.status).not.toBe("separate_origin_evidenced");
    }
    expect(evaluateClaimPolicy([a, b]).status).not.toBe("CONTEXT_CONFLICT");
  });

  it("inspector-visible named attribution bound to the page's own outlet qualifies", () => {
    const [a, b] = pair();
    a.sourceUrl = a.canonicalUrl = "https://dailyexaminer.example.org/x";
    a.domain = a.registrableDomain = "dailyexaminer.example.org";
    b.sourceUrl = b.canonicalUrl = "https://heraldnews.example.org/x";
    b.domain = b.registrableDomain = "heraldnews.example.org";
    refineReportingOrigins(
      [a, b],
      new Map([
        // Named-person byline AND media-bound publisher credit on the
        // page's own outlet — source-bound acquisition/reporting evidence.
        [a.id, "yankee zulu " + "Reported by Jane Doe for the Daily Examiner. The photograph was first published by the Daily Examiner. " + "one two three ".repeat(30)],
        [b.id, "four five six " + "Written by Sam Roe for the Herald News. The image was released by the Herald News. " + "seven eight nine ".repeat(30)],
      ]),
    );
    expect(a.reportingOrigin.status).toBe("separate_origin_evidenced");
    expect(b.reportingOrigin.status).toBe("separate_origin_evidenced");
    expect(evaluateClaimPolicy([a, b]).status).toBe("CONTEXT_CONFLICT");
  });

  it("a byline alone, or a publisher credit naming an external provider, stays unresolved", () => {
    const [a, b] = pair();
    refineReportingOrigins(
      [a, b],
      new Map([
        // Named byline bound to an outlet that is NOT the page's own —
        // authorship evidence only, not media-acquisition evidence.
        [a.id, "yankee zulu " + "Reported by Jane Doe for the Daily Examiner, who independently obtained the image. " + "one two three ".repeat(30)],
        // Media-bound publisher credit naming an external provider —
        // external source material, not this page's own origin.
        [b.id, "four five six " + "The photograph was first published by Reuters after its staff verified it. " + "seven eight nine ".repeat(30)],
      ]),
    );
    expect(a.reportingOrigin.status).toBe("unresolved");
    expect(b.reportingOrigin.status).toBe("unresolved");
    expect(evaluateClaimPolicy([a, b]).status).not.toBe("CONTEXT_CONFLICT");
  });
});

/* --------------------------------- F02 ---------------------------------- */

describe("F02 — contextual search/news never enters the core media timeline", () => {
  const searchJson = {
    search_metadata: { id: "g", status: "Success" },
    organic_results: [
      { position: 1, title: "Pikachu space ambassador", link: "https://pikachu.example.org/x", date: "Sep 21, 2026" },
    ],
  };
  const newsJson = {
    search_metadata: { id: "n", status: "Success" },
    news_results: [
      { position: 1, title: "Moon calendar", link: "https://moon.example.org/x", date: "2 days ago" },
    ],
  };

  it("contextual candidates carry no media identity", () => {
    for (const batch of [
      normalizeSearchResponse(searchJson, "google_search", { retrievedAt: "t" }),
      normalizeSearchResponse(newsJson, "google_news", { retrievedAt: "t" }),
    ]) {
      for (const c of batch.candidates) {
        expect(c.mediaRelationship).toBeNull();
      }
    }
  });

  it("dated contextual results are excluded from the core timeline", () => {
    const ctx =
      normalizeSearchResponse(searchJson, "google_search", { retrievedAt: "t" })
        .candidates[0];
    ctx.publishedAt = "2026-09-21";
    ctx.dateStatus = "usable";
    ctx.datePrecision = "day";
    const lead = makeExact({
      id: "core-1",
      publishedAt: "2020-01-01",
      dateStatus: "usable",
      datePrecision: "day",
    });
    const built = buildTimeline([ctx, lead], null);
    expect(built.timeline.map((t) => t.occurrenceId)).toContain("core-1");
    expect(built.timeline.map((t) => t.occurrenceId)).not.toContain(ctx.id);
    const extended = built as typeof built & {
      contextualEvidence?: TimelineItem[];
    };
    expect(extended.contextualEvidence?.map((t) => t.occurrenceId)).toContain(ctx.id);
  });
});

/* --------------------------------- F03 ---------------------------------- */

const jevStub = {
  ask: async () => ({ answers: {}, model: null }),
} as unknown as JevClient;
const fetchStub = async (url: string): Promise<FetchedPage> => ({
  url,
  html: "<html><body><p>text</p></body></html>",
});

const collectResult = (events: Array<{ type: string; result?: JsonRecord }>) =>
  events.find((e) => e.type === "investigation.completed")?.result;

const allEvidenceUrls = (result: JsonRecord | undefined): string[] => {
  if (result === undefined) return [];
  const urls: string[] = [];
  for (const key of [
    "timeline",
    "undatedEvidence",
    "supportingEvidence",
    "contextualEvidence",
  ]) {
    const arr = result[key];
    if (Array.isArray(arr)) {
      for (const item of arr) {
        const url = (item as JsonRecord).sourceUrl;
        if (typeof url === "string") urls.push(url);
      }
    }
  }
  return urls;
};

describe("F03 — adaptive search candidates are retained", () => {
  it("a unique adaptive candidate is discovered and reaches the final result", async () => {
    const serpapi: SearchProvider = {
      uploadImage: vi.fn(async () => "img"),
      search: vi.fn(async (p: Record<string, string>) => {
        if (p.engine === "google_lens" && p.type === "exact_matches") {
          return {
            search_metadata: { id: "e", status: "Success" },
            exact_matches: [{ position: 1, title: "exact", link: "https://x1.example.org/a" }],
          };
        }
        if (p.engine === "google_lens" && p.type === "about_this_image") {
          return { about_this_image: { sections: [] } };
        }
        if (p.engine === "google_lens" && p.q !== undefined) {
          // Adaptive refined-lens slot (§8: claim mode expands with q=claim).
          return {
            search_metadata: { id: "adaptive", status: "Success" },
            visual_matches: [
              { position: 1, title: "unique adaptive", link: "https://unique-adaptive.example.org/evidence" },
            ],
          };
        }
        if (p.engine === "google_lens") {
          return {
            search_metadata: { id: "l", status: "Success" },
            visual_matches: [],
            related_content: [{ query: "grounded query" }],
          };
        }
        return { search_metadata: { status: "Success" }, organic_results: [], news_results: [] };
      }),
    };
    const events: Array<{ type: string; [k: string]: unknown }> = [];
    await runInvestigation(
      { media: new Uint8Array([1]), claim: "controlled claim", timezone: "UTC", locale: "en" },
      (e) => events.push(e as { type: string }),
      { serpapi, jev: jevStub, fetchPage: fetchStub },
    );
    const discovered = events.filter((e) => e.type === "evidence.discovered");
    expect(
      discovered.some((e) =>
        String((e.evidence as JsonRecord).sourceUrl ?? "").includes("unique-adaptive"),
      ),
    ).toBe(true);
    const urls = allEvidenceUrls(collectResult(events));
    expect(urls.some((u) => u.includes("unique-adaptive"))).toBe(true);
  });
});

/* --------------------------------- F05 ---------------------------------- */

describe("F05 — contextSegmentCount requires full decisive coverage", () => {
  const sampled = () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      makeExact({
        id: `sample-${i}`,
        publishedAt: `20${10 + i}-01-01`,
        datePrecision: "day",
        dateStatus: "usable",
      }),
    );
    const selected = selectDatedCoreOccurrences(items);
    return { items, selected };
  };

  it("sampled selection over eligible occurrences yields null, not an exact count", () => {
    const { items, selected } = sampled();
    expect(selected.length).toBe(8);
    const judgments = new Map(
      selected.slice(1).map((x, i) => [
        pairKey(selected[i].id, x.id),
        { sameContext: 0.9, differentContext: 0.05, unclear: 0.05 },
      ]),
    );
    const segs = buildContextSegments(items, selected, judgments);
    expect(segs.contextSegmentCount).toBeNull();
  });

  it("an occurrence skipped BEFORE the divergence marks earlier transitions unresolved", () => {
    // Samples 5 and 6 share the anchor's domain so novelty scoring prefers
    // every other middle candidate — the sampled run omits 5 and 6, which
    // precede the first divergence.
    const items = Array.from({ length: 10 }, (_, i) =>
      makeExact({
        id: `sample-${i}`,
        publishedAt: `20${10 + i}-01-01`,
        datePrecision: "day",
        dateStatus: "usable",
        ...(i === 0 || i === 5 || i === 6
          ? { domain: "anchor.example.org", registrableDomain: "anchor.example.org" }
          : {}),
      }),
    );
    const selected = selectDatedCoreOccurrences(items);
    expect(selected.map((c) => c.id)).not.toContain("sample-5");
    expect(selected.map((c) => c.id)).not.toContain("sample-6");
    const judgments = new Map(
      selected.slice(1).map((x, i) => [
        pairKey(selected[i].id, x.id),
        selected[i].id === "sample-4" && x.id === "sample-7"
          ? { sameContext: 0.05, differentContext: 0.9, unclear: 0.05 }
          : { sameContext: 0.9, differentContext: 0.05, unclear: 0.05 },
      ]),
    );
    const segs = buildContextSegments(items, selected, judgments);
    expect(segs.firstObservedContextDivergence?.toOccurrenceId).toBe("sample-7");
    expect(segs.firstObservedContextDivergence?.earlierTransitionsUnresolved).toBe(true);
  });

  it("occurrences skipped only AFTER the divergence do not mark earlier unresolved", () => {
    // Uniform domains keep sampling's fill order: selection omits the
    // latest middle occurrences (7,8), which follow the first divergence.
    const { items, selected } = sampled();
    expect(selected.map((c) => c.id)).not.toContain("sample-7");
    expect(selected.map((c) => c.id)).not.toContain("sample-8");
    const judgments = new Map(
      selected.slice(1).map((x, i) => [
        pairKey(selected[i].id, x.id),
        i === 0
          ? { sameContext: 0.9, differentContext: 0.05, unclear: 0.05 }
          : { sameContext: 0.05, differentContext: 0.9, unclear: 0.05 },
      ]),
    );
    const segs = buildContextSegments(items, selected, judgments);
    expect(segs.firstObservedContextDivergence?.earlierTransitionsUnresolved).toBe(false);
    // The exact count invariant is a separate gate — still null here.
    expect(segs.contextSegmentCount).toBeNull();
  });
});

/* --------------------------------- F06 ---------------------------------- */

describe("F06 — JSON-LD dates bind to the article entity", () => {
  it("a wrapping WebPage dateCreated cannot become the page publication date", () => {
    const html = `<html><head><script type="application/ld+json">
      {"@type":"WebPage","dateCreated":"2020-01-01","mainEntity":{"@type":"NewsArticle","datePublished":"2024-01-01"}}
    </script></head><body>article</body></html>`;
    const dates = extractPage(html).jsonLdDates;
    expect(dates).toContain("2024-01-01");
    expect(dates).not.toContain("2020-01-01");
  });

  it("article-bound publication fields beat generic container fields", () => {
    const html = `<html><head><script type="application/ld+json">
      [{"@type":"BreadcrumbList","dateCreated":"2019-01-01"},{"@type":"NewsArticle","datePublished":"2021-05-05"}]
    </script></head><body>x</body></html>`;
    expect(extractPage(html).jsonLdDates).toEqual(["2021-05-05"]);
  });
});

/* --------------------------------- F07 ---------------------------------- */

describe("F07 — timezone-aware claim dates and calendar validity", () => {
  const ref = new Date("2026-09-26T01:00:00Z");
  it("honours the supplied IANA timezone for relative dates", () => {
    const la = parseClaimDate("this happened today", {
      referenceInstant: ref,
      timezone: "America/Los_Angeles",
    });
    const kolkata = parseClaimDate("this happened today", {
      referenceInstant: ref,
      timezone: "Asia/Kolkata",
    });
    expect(la.claimDate).toBe("2026-09-25");
    expect(kolkata.claimDate).toBe("2026-09-26");
  });
  it("rejects impossible calendar dates", () => {
    expect(parseDateValue("2026-13-45", ref)).toBeNull();
    expect(parseDateValue("2026-02-31", ref)).toBeNull();
    expect(parseDateValue("2026-02-28", ref)?.value).toBe("2026-02-28");
  });
});

/* --------------------------------- F08 ---------------------------------- */

describe("F08 — historical-reuse takeaway requires core identity + temporal support", () => {
  it("an undated visual lead cannot assert media history before the claim", () => {
    const lead = makeCandidate({
      judgment: makeJudgment({
        contextRelation: {
          sameContext: 0.01,
          differentContext: 0.01,
          historicalReference: 0.97,
          unclear: 0.01,
        },
      }),
    });
    const takeaways = deriveTakeaways({
      candidates: [lead],
      claimDate: "2026-09-26",
      hasCurrentNewsResults: false,
    });
    expect(takeaways.map((t) => t.code)).not.toContain("historical_reuse");
  });
  it("a dated core occurrence with historical context qualifies", () => {
    const core = makeExact({
      judgment: makeJudgment({
        contextRelation: {
          sameContext: 0.01,
          differentContext: 0.01,
          historicalReference: 0.97,
          unclear: 0.01,
        },
      }),
      publishedAt: "2019-01-01",
      dateStatus: "usable",
      datePrecision: "day",
    });
    const takeaways = deriveTakeaways({
      candidates: [core],
      claimDate: "2026-09-26",
      hasCurrentNewsResults: false,
    });
    expect(takeaways.map((t) => t.code)).toContain("historical_reuse");
  });
});

/* --------------------------------- F09 ---------------------------------- */

describe("F09 — deep-read fills slots with unseen useful pages", () => {
  it("selects more than one relevant undated core occurrence", () => {
    const picked = selectDeepReadCandidates([
      makeExact({ id: "undated1", judgment: makeJudgment() }),
      makeExact({ id: "undated2", judgment: makeJudgment() }),
    ]);
    expect(picked.length).toBeGreaterThanOrEqual(2);
    expect(picked.map((c) => c.id)).toEqual(
      expect.arrayContaining(["undated1", "undated2"]),
    );
  });
});

/* --------------------------------- F10 ---------------------------------- */

describe("F10 — settled search batches surface progressively", () => {
  it("evidence from a settled job is discovered before slower jobs finish", async () => {
    let resolveLens!: (v: unknown) => void;
    const lensGate = new Promise<unknown>((r) => (resolveLens = r));
    const serpapi: SearchProvider = {
      uploadImage: vi.fn(async () => "img"),
      search: vi.fn(async (p: Record<string, string>) => {
        if (p.engine === "google_lens") return lensGate;
        return {
          search_metadata: { id: "g", status: "Success" },
          organic_results: [
            { position: 1, title: "fast", link: "https://fast-google.example.org/p", date: "2020-01-01" },
          ],
        };
      }),
    };
    const events: Array<{ type: string; [k: string]: unknown }> = [];
    const run = runInvestigation(
      { media: new Uint8Array([1]), claim: "controlled claim", timezone: "UTC", locale: "en" },
      (e) => events.push(e as { type: string }),
      { serpapi, jev: jevStub, fetchPage: fetchStub },
    );
    await tick();
    await tick();
    const early = events
      .filter((e) => e.type === "evidence.discovered")
      .map((e) => String((e.evidence as JsonRecord).sourceUrl ?? ""));
    expect(early.some((u) => u.includes("fast-google"))).toBe(true);
    resolveLens({
      search_metadata: { id: "l", status: "Success" },
      visual_matches: [],
      about_this_image: { sections: [] },
    });
    await run;
  });
});

/* --------------------------------- F11 ---------------------------------- */

describe("F11 — material retrieval/classification failures surface as limitations", () => {
  const baseSerpapi = (overrides: Record<string, unknown>): SearchProvider => ({
    uploadImage: vi.fn(async () => "img"),
    search: vi.fn(async (p: Record<string, string>) => {
      if (p.engine === "google_lens" && p.type === "exact_matches") {
        return {
          search_metadata: { status: "Success" },
          exact_matches: [{ position: 1, link: "https://x.example.org/a", title: "x" }],
        };
      }
      if (p.engine === "google_lens" && p.type === "about_this_image") {
        return overrides.about ?? { about_this_image: { sections: [] } };
      }
      if (p.engine === "google_lens") return { visual_matches: [] };
      if (p.engine === "google_news") return { news_results: [] };
      return overrides.google ?? { organic_results: [] };
    }),
  });

  const runFor = async (overrides: Record<string, unknown>) => {
    const events: Array<{ type: string; result?: JsonRecord }> = [];
    await runInvestigation(
      { media: new Uint8Array([1]), claim: "controlled claim", timezone: "UTC", locale: "en" },
      (e) => events.push(e as { type: string; result?: JsonRecord }),
      { serpapi: baseSerpapi(overrides), jev: jevStub, fetchPage: fetchStub },
    );
    return collectResult(events)?.limitations as string[] | undefined;
  };

  it("about-this-image request failure produces an explicit limitation", async () => {
    const limitations = await runFor({ about: { error: "upstream" } });
    expect(limitations).toBeDefined();
    expect(limitations).toContain("about_this_image_unavailable");
  });

  it("google search request failure produces an explicit limitation", async () => {
    const limitations = await runFor({ google: { error: "upstream" } });
    expect(limitations).toBeDefined();
    expect(limitations).toContain("web_context_unavailable");
  });
});
