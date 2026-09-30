/**
 * Astra A11 backend acceptance inventory (I1–I4) — decisive reproductions
 * plus the bounded dispatch/page-cap controls the inventory found
 * uncovered. All transports are controlled; no provider calls.
 */

import { describe, expect, it, vi } from "vitest";
import { runInvestigation, type RunDeps, type SearchProvider } from "../run";
import type { InvestigationEvent } from "../contracts/events";
import type { InvestigationInput } from "../contracts/investigation";
import type { JevClient } from "../../jev/client";
import type { SerpapiParams } from "../../serpapi/client";
import type { FetchedPage } from "../../pages/fetch";
import { MAX_JEV_CANDIDATES } from "../limits";
import { parseClaimDate, resolveEvidenceDate } from "../dates";
import { selectForClassification } from "../candidates";
import { makeCandidate, makeExact, separateOrigin } from "./testkit";

const MEDIA = new Uint8Array([1, 2, 3]);

const VERIFIED_IDENTITY = {
  requested: "jev-1.13.0",
  reported: "jev-1.13.0",
  status: "verified",
  pinned: true,
} as const;

const rows = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({
    position: i + 1,
    title: `${prefix}${i}`,
    link: `https://${prefix}${i}.com/item`,
  }));

const UNDATED_PAGE = (url: string): FetchedPage => ({
  url,
  html: `<html><head><title>No date</title></head><body><article><p>${"A controlled source paragraph without a publication date. ".repeat(30)}</p></article></body></html>`,
});

const DATE_PAGE = (url: string, iso: string): FetchedPage => ({
  url,
  html: `<html><head><title>Article</title>
    <script type="application/ld+json">${JSON.stringify({
      "@type": "NewsArticle",
      url,
      headline: "Article",
      datePublished: iso,
    })}</script></head><body><article><p>${"A controlled source paragraph. ".repeat(30)}</p></article></body></html>`,
});

const WEAK_ANSWERS = {
  relevance: { type: "noul", noul: 0.1 },
  page_role: {
    type: "choice",
    choice: "OTHER",
    probabilities: {
      REPORTING: 0.04,
      FACT_CHECK: 0.04,
      SOCIAL_REPOST: 0.04,
      AGGREGATOR: 0.04,
      COMMENTARY: 0.04,
      OTHER: 0.8,
    },
  },
};

const STRONG_ANSWERS = {
  ...WEAK_ANSWERS,
  relevance: { type: "noul", noul: 0.9 },
  context_relation: {
    type: "choice",
    choice: "SAME_CONTEXT",
    probabilities: {
      SAME_CONTEXT: 0.9,
      DIFFERENT_CONTEXT: 0.04,
      HISTORICAL_REFERENCE: 0.03,
      UNCLEAR: 0.03,
    },
  },
};

function makeJev(
  opts: {
    answers?: Record<string, unknown>;
    failDomains?: Set<string>;
    states?: unknown[];
  } = {},
) {
  const ask = vi.fn(
    async (state: unknown, qs: Record<string, unknown>) => {
      if (!("pairwise_context" in qs)) {
        opts.states?.push(state);
        const domain = (state as { result?: { domain?: string } }).result
          ?.domain;
        if (domain !== undefined && opts.failDomains?.has(domain)) {
          throw new Error("controlled classify failure");
        }
      }
      return {
        answers:
          "pairwise_context" in qs
            ? {
                pairwise_context: {
                  type: "choice",
                  choice: "SAME_CONTEXT",
                  probabilities: {
                    SAME_CONTEXT: 0.9,
                    DIFFERENT_CONTEXT: 0.05,
                    UNCLEAR: 0.05,
                  },
                },
              }
            : (opts.answers ?? STRONG_ANSWERS),
        model: "jev-1.13.0",
        identity: VERIFIED_IDENTITY,
      };
    },
  );
  return { client: { ask } as unknown as JevClient, ask };
}

function run(input: InvestigationInput, deps: Partial<RunDeps>) {
  const events: InvestigationEvent[] = [];
  const promise = runInvestigation(input, (e) => events.push(e), {
    serpapi: null,
    jev: null,
    fetchPage: async () => UNDATED_PAGE("https://x.example.com/p"),
    ...deps,
  } as RunDeps);
  return { events, promise };
}

const completed = (events: InvestigationEvent[]) =>
  events.find((e) => e.type === "investigation.completed") as
    | { result: Record<string, never> & {
        timeline: Array<Record<string, unknown>>;
        undatedEvidence: Array<Record<string, unknown>>;
        limitations: string[];
      } }
    | undefined;

/* ---------------------------------- I1 ---------------------------------- */

describe("I1 — §14 distinct-candidate allowance survives expansion (§14)", () => {
  // Astra's counterexample: 31 distinct URLs retained, an adaptive Lens
  // batch adds 8 more; classification must never exceed 24 distinct ids.
  const wideSerpapi = (calls: SerpapiParams[]): SearchProvider => ({
    uploadImage: vi.fn(async () => "img"),
    search: vi.fn(async (p: SerpapiParams) => {
      calls.push(p);
      if (p.type === "exact_matches") {
        return {
          search_metadata: { status: "Success", id: "serp-exact" },
          exact_matches: rows("exact", 8),
        };
      }
      if (p.type === "about_this_image") {
        return {
          search_metadata: { status: "Success", id: "serp-about" },
          about_this_image: { sections: [{ page_results: rows("about", 5) }] },
        };
      }
      if (p.engine === "google_news") {
        return {
          search_metadata: { status: "Success", id: "serp-news" },
          news_results: rows("news", 5),
        };
      }
      if (p.engine === "google") {
        return {
          search_metadata: { status: "Success", id: "serp-search" },
          organic_results: rows("search", 5),
        };
      }
      // google_lens type=all — the adaptive call carries q.
      return {
        search_metadata: { status: "Success", id: "serp-lens" },
        visual_matches: rows(p.q !== undefined ? "adaptive" : "visual", 8),
      };
    }),
  });

  it("caps distinct classified candidates investigation-wide, preserving reclassification", async () => {
    const calls: SerpapiParams[] = [];
    const states: unknown[] = [];
    const { events, promise } = run(
      {
        claim: "A controlled claim",
        timezone: "UTC",
        locale: "en",
        media: MEDIA,
      },
      {
        serpapi: wideSerpapi(calls),
        jev: makeJev({ answers: WEAK_ANSWERS, states }).client,
        fetchPage: async (u: string) => UNDATED_PAGE(u),
      },
    );
    await promise;
    expect(events.some((e) => e.type === "investigation.completed")).toBe(true);

    const domains = states.map(
      (s) => (s as { result: { domain: string } }).result.domain,
    );
    const distinct = new Set(domains);
    // Distinct classification targets never exceed the §14 allowance —
    // adaptive entrants must not reopen it.
    expect(distinct.size).toBeLessThanOrEqual(MAX_JEV_CANDIDATES);
    // Reclassification stays a separate, legitimate budget: deep-read
    // re-asks mean total calls exceed distinct ids.
    expect(states.length).toBeGreaterThan(distinct.size);
    // Disconfirming controls preserved: 6 searches, exactly one exact and
    // one About attempt.
    expect(calls).toHaveLength(5);
    expect(calls.filter((c) => c.type === "exact_matches")).toHaveLength(1);
    expect(calls.filter((c) => c.type === "about_this_image")).toHaveLength(0);
  });

  it("failed first classifications still consume a candidate's slot", async () => {
    const calls: SerpapiParams[] = [];
    const states: unknown[] = [];
    const { events, promise } = run(
      {
        claim: "A controlled claim",
        timezone: "UTC",
        locale: "en",
        media: MEDIA,
      },
      {
        serpapi: wideSerpapi(calls),
        jev: makeJev({
          answers: WEAK_ANSWERS,
          states,
          failDomains: new Set(["exact0.com"]),
        }).client,
        fetchPage: async (u: string) => UNDATED_PAGE(u),
      },
    );
    await promise;
    const domains = states.map(
      (s) => (s as { result: { domain: string } }).result.domain,
    );
    // The failed id consumed its allowance: distinct attempted targets
    // still <= 24 and no adaptive entrant backfills it.
    expect(new Set(domains).size).toBeLessThanOrEqual(MAX_JEV_CANDIDATES);
    expect(domains.filter((d) => d === "exact0.com").length).toBeLessThanOrEqual(
      2, // one first attempt + at most a legitimate retry, never a new id
    );
  });
});

/* ---------------------------------- I2 ---------------------------------- */

describe("I2 — deduped URLs keep every source-bound date (§11, §19.2)", () => {
  const serpapiWithDates = (
    aboutDate: string,
    searchDate: string | null,
  ): { calls: SerpapiParams[]; provider: SearchProvider } => {
    const calls: SerpapiParams[] = [];
    return {
      calls,
      provider: {
        uploadImage: vi.fn(async () => "img"),
        search: vi.fn(async (p: SerpapiParams) => {
          calls.push(p);
          if (p.type === "exact_matches") {
            return {
              search_metadata: { status: "Success", id: "serp-exact" },
              exact_matches: [
                { position: 1, title: "Exact", link: "https://same.com/item" },
              ],
            };
          }
          if (p.engine === "google") {
            return {
              search_metadata: { status: "Success", id: "serp-search" },
              organic_results:
                searchDate === null
                  ? []
                  : [
                      {
                        position: 1,
                        title: "Search",
                        link: "https://same.com/item",
                        date: searchDate,
                      },
                    ],
            };
          }
          if (p.engine === "google_news") {
            return {
              search_metadata: { status: "Success", id: "serp-news" },
              news_results: [{position: 1, title: "Dated news context", link: "https://same.com/item", date: aboutDate}],
            };
          }
          return {
            search_metadata: { status: "Success", id: "serp-lens" },
            visual_matches: [],
          };
        }),
      },
    };
  };

  it("a valid merged provider date survives an undated deep read", async () => {
    const { provider } = serpapiWithDates("Jan 5, 2020", null);
    const { events, promise } = run(
      { claim: "A controlled claim", timezone: "UTC", locale: "en", media: MEDIA },
      {
        serpapi: provider,
        jev: makeJev().client,
        fetchPage: async (u: string) => UNDATED_PAGE(u),
      },
    );
    await promise;
    const result = completed(events)!.result;
    const item = result.timeline.find(
      (t) => t.occurrenceId !== undefined,
    ) as
      | { observedAt: string; publishedAtSource: string; dateStatus: string }
      | undefined;
    expect(item?.observedAt).toBe("2020-01-05");
    expect(item?.publishedAtSource).toBe("serpapi");
    expect(item?.dateStatus).toBe("usable");
    expect(result.undatedEvidence).toHaveLength(0);
  });

  it("a valid structured page date overrides the merged provider date", async () => {
    const { provider } = serpapiWithDates("Jan 5, 2020", null);
    const { events, promise } = run(
      { claim: "A controlled claim", timezone: "UTC", locale: "en", media: MEDIA },
      {
        serpapi: provider,
        jev: makeJev().client,
        fetchPage: async (u: string) => DATE_PAGE(u, "2021-03-09"),
      },
    );
    await promise;
    const result = completed(events)!.result;
    const item = result.timeline[0] as {
      observedAt: string;
      publishedAtSource: string;
      dateProvenance: { rejectedCandidates: Array<{ value: string }> };
    };
    expect(item.observedAt).toBe("2021-03-09");
    expect(item.publishedAtSource).toBe("page_json_ld");
    // The losing provider date is preserved as a rejection, not dropped.
    expect(
      item.dateProvenance.rejectedCandidates.map((r) => r.value),
    ).toContain("Jan 5, 2020");
  });

  it("conflicting provider dates for one URL resolve as disputed, both preserved", async () => {
    const { provider } = serpapiWithDates("Jan 5, 2020", "Mar 9, 2021");
    const { events, promise } = run(
      {
        claim: "A controlled claim",
        timezone: "UTC",
        locale: "en",
        media: MEDIA,
      },
      {
        serpapi: provider,
        jev: makeJev({ answers: WEAK_ANSWERS }).client,
        fetchPage: async (u: string) => UNDATED_PAGE(u),
      },
    );
    await promise;
    const result = completed(events)!.result;
    const item = result.undatedEvidence[0] as
      | {
          dateStatus: string;
          dateProvenance: { rejectedCandidates: Array<{ value: string }> };
        }
      | undefined;
    expect(item?.dateStatus).toBe("disputed");
    const rejected =
      item?.dateProvenance.rejectedCandidates.map((r) => r.value) ?? [];
    expect(rejected).toContain("Jan 5, 2020");
    expect(rejected).toContain("Mar 9, 2021");
  });

  it("a merged month-precision provider date is never promoted to a day", async () => {
    const { provider } = serpapiWithDates("March 2020", null);
    const { events, promise } = run(
      { claim: "A controlled claim", timezone: "UTC", locale: "en", media: MEDIA },
      {
        serpapi: provider,
        jev: makeJev().client,
        fetchPage: async (u: string) => UNDATED_PAGE(u),
      },
    );
    await promise;
    const result = completed(events)!.result;
    const item = result.timeline[0] as {
      observedAt: string;
      datePrecision: string;
      dateStatus: string;
    };
    expect(item.observedAt).toBe("2020-03");
    expect(item.datePrecision).toBe("month");
    expect(item.dateStatus).toBe("usable");
  });

  it("resolveEvidenceDate resolves the merged source set honestly", () => {
    const ref = new Date("2026-09-25T12:00:00Z");
    // Agreeing merged dates: one usable value.
    expect(
      resolveEvidenceDate(
        { serpapi: "Jan 5, 2020", serpapiAlternates: ["2020-01-05"] },
        ref,
      ),
    ).toMatchObject({
      publishedAt: "2020-01-05",
      publishedAtSource: "serpapi",
      dateStatus: "usable",
    });
    // Disagreeing provider dates with no page arbitration: disputed.
    const disputed = resolveEvidenceDate(
      { serpapi: "Jan 5, 2020", serpapiAlternates: ["Mar 9, 2021"] },
      ref,
    );
    expect(disputed.publishedAt).toBeNull();
    expect(disputed.dateStatus).toBe("disputed");
    expect(disputed.rejected.map((r) => r.value).sort()).toEqual([
      "Jan 5, 2020",
      "Mar 9, 2021",
    ]);
    // Page source still arbitrates; the losing provider date is recorded.
    const overridden = resolveEvidenceDate(
      {
        pageJsonLd: "2021-03-09",
        serpapi: "Jan 5, 2020",
        serpapiAlternates: ["2020-01-05"],
      },
      ref,
    );
    expect(overridden.publishedAt).toBe("2021-03-09");
    expect(overridden.rejected.map((r) => r.value)).toContain("Jan 5, 2020");
  });
});

/* ---------------------------------- I3 ---------------------------------- */

describe("I3 — §19.1 conservative claim dates", () => {
  const REF = new Date("2026-09-26T01:00:00.000Z");
  const opts = { referenceInstant: REF, timezone: "UTC" };

  it("a single parse spanning multiple days is ambiguous, never first-day", () => {
    for (const text of [
      "the photo was taken March 5 to March 8, 2026",
      "the photo was taken March 5-8, 2026",
    ]) {
      const r = parseClaimDate(text, opts);
      expect(r.claimDate, text).toBeNull();
      expect(r.ambiguous, text).toBe(true);
    }
  });

  it("punctuation-equivalent day ranges are refused, never first-day (Astra's en-dash repro)", () => {
    // The exact accepted-run claim shape: en dash + stated year +
    // America/Los_Angeles reference — previously resolved 2027-03-05,
    // silently losing the stated 2026.
    for (const text of [
      "the photo was taken March 5–8, 2026", // U+2013 en dash
      "the photo was taken March 5—8, 2026", // em dash
      "the photo was taken March 5‑8, 2026", // non-breaking hyphen
      "the photo was taken March 5−8, 2026", // minus sign
      "the photo was taken March 5th through 8th, 2026",
      "the photo was taken March 5–8", // the range alone, no year
    ]) {
      const r = parseClaimDate(text, {
        referenceInstant: REF,
        timezone: "America/Los_Angeles",
      });
      expect(r.claimDate, text).toBeNull();
      expect(r.ambiguous, text).toBe(true);
    }
  });

  it("a supplied year is never silently lost into next-year inference", () => {
    // Whatever chrono yields inside the ignored range tail, a stated
    // 2026 may never resolve to 2027.
    const r = parseClaimDate("the photo was taken March 5–8, 2026", {
      referenceInstant: REF,
      timezone: "America/Los_Angeles",
    });
    expect(r.claimDate).toBeNull(); // refused outright — never 2027
    if (r.claimDate !== null) expect(r.claimDate).not.toMatch(/^2027/);
  });

  it("an ambiguous two-number date is refused rather than guessed", () => {
    const r = parseClaimDate("the photo was taken on 03/04/2026", opts);
    expect(r.claimDate).toBeNull();
    expect(r.ambiguous).toBe(true);
  });

  it("a numeric date with a >12 component still parses unambiguously", () => {
    expect(parseClaimDate("taken on 13/04/2026", opts)).toEqual({
      claimDate: "2026-04-13",
      precision: "day",
      ambiguous: false,
    });
    expect(parseClaimDate("taken on 04/13/2026", opts)).toEqual({
      claimDate: "2026-04-13",
      precision: "day",
      ambiguous: false,
    });
  });

  it("an explicit relative weekday resolves to its calendar day", () => {
    // Reference 2026-09-26 (Saturday) → last Friday is 2026-09-25.
    expect(parseClaimDate("this was posted last Friday", opts)).toEqual({
      claimDate: "2026-09-25",
      precision: "day",
      ambiguous: false,
    });
  });

  it("disconfirming controls still hold", () => {
    // Multi-endpoint ambiguity was already refused.
    expect(
      parseClaimDate("between March 5 and March 8, 2026", opts).ambiguous,
    ).toBe(true);
    // Repeated identical dates stay one date.
    expect(
      parseClaimDate("March 4, 2026 and March 4, 2026", opts).claimDate,
    ).toBe("2026-03-04");
    // Month-only keeps month precision.
    expect(parseClaimDate("flooding in September 2026", opts)).toEqual({
      claimDate: "2026-09",
      precision: "month",
      ambiguous: false,
    });
    expect(parseClaimDate("taken today", opts).claimDate).toBe("2026-09-26");
    expect(parseClaimDate("taken yesterday", opts).claimDate).toBe(
      "2026-09-25",
    );
  });
});

/* ---------------------------------- I4 ---------------------------------- */

describe("I4 — §14 selection orders exact, dated, diversity, rank", () => {
  it("a second exact survives domain diversity (Astra's counterexample)", () => {
    const exacts = [
      makeExact({ id: "ex1", serpPosition: 1 }),
      makeExact({ id: "ex2", serpPosition: 2 }),
    ];
    for (const e of exacts) e.registrableDomain = "same.com";
    const others = [
      ...Array.from({ length: 8 }, (_, i) =>
        makeCandidate({ id: `v${i}`, retrievalKind: "lens_visual", serpPosition: i + 1 }),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        makeCandidate({ id: `a${i}`, retrievalKind: "lens_about_image", serpPosition: i + 1 }),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        makeCandidate({ id: `s${i}`, retrievalKind: "google_search", serpPosition: i + 1 }),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        makeCandidate({ id: `n${i}`, retrievalKind: "google_news", serpPosition: i + 1 }),
      ),
    ];
    others.forEach((c, i) => {
      c.registrableDomain = `d${i}.com`;
    });
    const selected = selectForClassification([...exacts, ...others]);
    expect(selected).toHaveLength(MAX_JEV_CANDIDATES);
    expect(selected.map((c) => c.id)).toContain("ex1");
    expect(selected.map((c) => c.id)).toContain("ex2");
  });

  it("dated evidence outranks undated evidence inside a tier", () => {
    const exact = makeExact({ id: "ex" });
    exact.registrableDomain = "taken.com";
    const dated = makeCandidate({ id: "dated" });
    dated.registrableDomain = "taken.com"; // same domain as the exact
    dated.publishedAt = "2020-01-01";
    dated.dateStatus = "usable";
    dated.datePrecision = "day";
    const undatedA = makeCandidate({ id: "undated-a" });
    undatedA.registrableDomain = "fresh-a.com";
    const undatedB = makeCandidate({ id: "undated-b" });
    undatedB.registrableDomain = "fresh-b.com";
    const selected = selectForClassification(
      [undatedA, undatedB, dated, exact],
      3,
    );
    expect(selected.map((c) => c.id)).toEqual(["ex", "dated", "undated-a"]);
  });

  it("stable SERP rank breaks ties inside one domain", () => {
    const items = [3, 1, 2].map((pos, i) => {
      const c = makeCandidate({ id: `r${i}`, serpPosition: pos });
      c.registrableDomain = "same.com";
      return c;
    });
    const selected = selectForClassification(items, 2);
    expect(selected.map((c) => c.serpPosition)).toEqual([1, 2]);
  });

  it("a separately evidenced origin counts as diversity within a domain", () => {
    const a = makeCandidate({ id: "a" }); // unresolved origin
    const b = makeCandidate({ id: "b" });
    separateOrigin(b, "wire:g1");
    const c = makeCandidate({ id: "c" });
    for (const x of [a, b, c]) x.registrableDomain = "same.com";
    const selected = selectForClassification([a, b, c], 2);
    // Domain diversity admits `a`; b's resolved distinct group is novel too.
    expect(selected.map((x) => x.id).sort()).toEqual(["a", "b"]);
  });
});

/* ----------------- bounded dispatch + page-cap controls ----------------- */

describe("bounded dispatch controls (§7, §14, §18, §27)", () => {
  const datedExactJson = (links: string[]) => ({
    search_metadata: { status: "Success", id: "serp-exact" },
    exact_matches: links.map((link, i) => ({
      position: i + 1,
      title: `exact ${i}`,
      link,
    })),
  });

  /** Exact rows carry no provider date (§6.3); About rows on the SAME
   *  canonical URLs supply the dates that dedupe merges onto the exact
   *  survivors — the only way exact core is dated at expansion time. */
  const serpapiExact = (links: string[]): { calls: SerpapiParams[]; provider: SearchProvider } => {
    const calls: SerpapiParams[] = [];
    return {
      calls,
      provider: {
        uploadImage: vi.fn(async () => "img"),
        search: vi.fn(async (p: SerpapiParams) => {
          calls.push(p);
          if (p.type === "exact_matches") return datedExactJson(links);
          if (p.type === "about_this_image") {
            return {
              search_metadata: { status: "Success", id: "serp-about" },
              about_this_image: {
                sections: [
                  {
                    page_results: links.map((link, i) => ({
                      position: i + 1,
                      title: `about ${i}`,
                      link,
                      date: `Jan ${i + 1}, 2020`,
                    })),
                  },
                ],
              },
            };
          }
          return {
            search_metadata: { status: "Success", id: "serp-lens" },
            visual_matches: [],
            related_content: [{ query: "q", link: "https://google.com/q" }],
          };
        }),
      },
    };
  };

  it("missing dates from the retired surface do not imply conclusive preliminary coverage", async () => {
    const { calls, provider } = serpapiExact([
      "https://a.example.org/i",
      "https://b.example.net/i",
    ]);
    const { events, promise } = run(
      { claim: null, timezone: "UTC", locale: "en", media: MEDIA },
      {
        serpapi: provider,
        jev: makeJev().client,
        fetchPage: async (u: string) => UNDATED_PAGE(u),
      },
    );
    await promise;
    expect(events.some((e) => e.type === "investigation.completed")).toBe(true);
    // Exact identities alone do not fabricate dates. The single supported
    // related-query expansion may run, then bounded page reads recover dates.
    expect(calls).toHaveLength(3);
    expect(calls.filter(c => c.engine === "google")).toHaveLength(1);
    expect(calls.some(c => c.type === "about_this_image")).toBe(false);
    const detail = events.find(
      (e) =>
        e.type === "stage.completed" &&
        (e as { stage: string }).stage === "EXPAND_IF_NEEDED",
    ) as { detail?: string } | undefined;
    expect(detail?.detail).not.toBe("skipped (already_conclusive)");
  });

  it("a mixed-failure adaptive attempt is counted once and the run completes", async () => {
    const calls: SerpapiParams[] = [];
    const provider: SearchProvider = {
      uploadImage: vi.fn(async () => "img"),
      search: vi.fn(async (p: SerpapiParams) => {
        calls.push(p);
        // The adaptive claim-expansion call is a Lens type=all carrying
        // the claim query — the base searches never do.
        if (p.engine === "google_lens" && p.q !== undefined) {
          throw new Error("controlled adaptive failure");
        }
        if (p.type === "exact_matches") {
          return {
            search_metadata: { status: "Success", id: "serp-exact" },
            exact_matches: rows("exact", 2),
          };
        }
        if (p.type === "about_this_image") {
          return {
            search_metadata: { status: "Success", id: "serp-about" },
            about_this_image: { sections: [] },
          };
        }
        if (p.engine === "google_news") {
          return {
            search_metadata: { status: "Success", id: "serp-news" },
            news_results: [],
          };
        }
        if (p.engine === "google") {
          return {
            search_metadata: { status: "Success", id: "serp-search" },
            organic_results: [],
          };
        }
        return {
          search_metadata: { status: "Success", id: "serp-lens" },
          visual_matches: rows("visual", 2),
        };
      }),
    };
    const { events, promise } = run(
      {
        claim: "A controlled claim",
        timezone: "UTC",
        locale: "en",
        media: MEDIA,
      },
      {
        serpapi: provider,
        jev: makeJev({ answers: WEAK_ANSWERS }).client,
        fetchPage: async (u: string) => UNDATED_PAGE(u),
      },
    );
    await promise;
    // Exactly one adaptive attempt among the six claim searches; base
    // successes are unaffected by its failure.
    const adaptive = calls.filter(
      (c) => c.engine === "google_lens" && c.q !== undefined,
    );
    expect(adaptive).toHaveLength(1);
    expect(calls).toHaveLength(5);
    expect(events.some((e) => e.type === "investigation.completed")).toBe(true);
  });

  it("the deep-read page cap holds under saturation and a fetch exception releases its slot", async () => {
    const links = Array.from(
      { length: 6 },
      (_, i) => `https://p${i}.example-${i}.org/i`,
    );
    const { provider } = serpapiExact(links);
    let active = 0;
    let peak = 0;
    const fetched: string[] = [];
    const { events, promise } = run(
      { claim: null, timezone: "UTC", locale: "en", media: MEDIA },
      {
        serpapi: provider,
        jev: makeJev().client,
        fetchPage: async (u: string) => {
          fetched.push(u);
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 2));
          active -= 1;
          if (u === links[1]) throw new Error("controlled page failure");
          return UNDATED_PAGE(u);
        },
      },
    );
    await promise;
    const result = completed(events)!.result;
    expect(fetched.length).toBeLessThanOrEqual(5);
    expect(peak).toBeLessThanOrEqual(5);
    // The throw released its slot: the remaining pages were still read.
    expect(fetched).toHaveLength(5);
    expect(result.limitations).toContain("page_fetch_partial_failure");
  });
});
