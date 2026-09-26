/**
 * Astra supplemental PRD coverage recheck (S1–S4) at 6e082bb — durable
 * negatives asserting the REQUIRED behavior; each fails while the defect
 * stands. S2's watchdog path is a virtual-clock/signal-level test — it
 * proves abort-reason classification, not a real 90-second wall-clock.
 */

import { describe, expect, it, vi } from "vitest";
import { fetchPageHtml, type FetchedPage } from "../../pages/fetch";
import { extractPage } from "../../pages/extract";
import {
  classifyStreamFailure,
  type InvestigationSnapshot,
} from "../../stream/useInvestigation";
import { runInvestigation } from "../run";

const VERIFIED_JEV = {
  requested: "jev-1.13.0",
  reported: "jev-1.13.0",
  status: "verified",
  pinned: true,
} as const;

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
};

/* ---------------------------------- S1 ---------------------------------- */

describe("S1 — private IPv6 / mapped-IPv4 literals never reach transport", () => {
  const harness = () => {
    const dispatched: string[] = [];
    const fake = async (u: unknown) => {
      dispatched.push(String(u));
      return new Response("<html><body>ok</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    };
    return { dispatched, fake: fake as unknown as typeof fetch };
  };

  it.each([
    "http://[fc00::1]/x",
    "http://[fd12::1]/x",
    "http://[fe80::1]/x",
    "http://[::ffff:127.0.0.1]/x",
    "http://[::ffff:10.0.0.1]/x",
    "http://[::ffff:169.254.1.1]/x",
    "http://[::ffff:7f00:1]/x",
  ])("rejects %s before dispatch", async (url) => {
    const { dispatched, fake } = harness();
    await expect(fetchPageHtml(url, undefined, fake)).rejects.toThrow();
    expect(dispatched).toHaveLength(0);
  });

  it("rejects a redirect hop to a private IPv6 literal", async () => {
    const dispatched: string[] = [];
    const fake = (async (u: unknown) => {
      dispatched.push(String(u));
      if (dispatched.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "http://[fd00::1]/internal" },
        });
      }
      return new Response("<html></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof fetch;
    await expect(
      fetchPageHtml("https://public.example.org/page", undefined, fake),
    ).rejects.toThrow();
    expect(dispatched).toEqual(["https://public.example.org/page"]);
  });

  it("positive control — a public http destination still dispatches", async () => {
    const { dispatched, fake } = harness();
    await fetchPageHtml("https://public.example.org/page", undefined, fake);
    expect(dispatched).toEqual(["https://public.example.org/page"]);
  });
});

/* ---------------------------------- S2 ---------------------------------- */

const streamingSnap = (
  overrides: Partial<InvestigationSnapshot> = {},
): InvestigationSnapshot => ({
  phase: "streaming",
  investigationId: "inv-1",
  stages: [],
  searchCounts: [],
  evidence: [],
  classifications: {},
  partialTimeline: null,
  preliminaryVerdict: null,
  divergence: null,
  result: null,
  error: null,
  ...overrides,
});

describe("S2 — watchdog abort reason classifies as timed_out, not cancelled", () => {
  it("a watchdog-fired signal yields failed/timed_out and keeps partial evidence", () => {
    const controller = new AbortController();
    controller.abort(new Error("watchdog"));
    const s = classifyStreamFailure(
      streamingSnap({ evidence: [{ id: "e1" }] }),
      controller.signal,
    );
    expect(s.phase).toBe("failed");
    expect(s.error?.code).toBe("timed_out");
    expect(s.error?.partial).toBe(true);
    expect(s.evidence).toHaveLength(1);
  });

  it("positive control — an explicit user abort still yields cancelled", () => {
    const controller = new AbortController();
    controller.abort();
    const s = classifyStreamFailure(
      streamingSnap({ evidence: [{ id: "e1" }] }),
      controller.signal,
    );
    expect(s.phase).toBe("cancelled");
  });
});

/* ---------------------------------- S3 ---------------------------------- */

describe("S3 — interruption after evidence is not reported as zero evidence", () => {
  it("mid-stream failure with retrieved evidence keeps it and avoids no-evidence copy", () => {
    const controller = new AbortController(); // transport failure, not aborted
    const s = classifyStreamFailure(
      streamingSnap({ evidence: [{ id: "e1" }] }),
      controller.signal,
    );
    expect(s.phase).toBe("failed");
    expect(s.error?.partial).toBe(true);
    expect(s.error?.message).not.toMatch(/no evidence was retrieved/i);
  });

  it("positive control — failure before evidence still says none was retrieved", () => {
    const controller = new AbortController();
    const s = classifyStreamFailure(streamingSnap(), controller.signal);
    expect(s.phase).toBe("failed");
    expect(s.error?.partial).toBe(false);
    expect(s.error?.message).toMatch(/no evidence was retrieved/i);
  });
});

/* ---------------------------------- S4 ---------------------------------- */

describe("S4 — the 55s deadline gates new semantic work", () => {
  it("virtual clock: crossing the deadline before FAST_CLASSIFY starts no Jev call", async () => {
    let clock = 0;
    let jevCalls = 0;
    const events: Array<{ type: string }> = [];
    await runInvestigation(
      { media: new Uint8Array([1]), claim: null, timezone: "UTC", locale: "en" },
      (e) => events.push(e as never),
      {
        serpapi: {
          uploadImage: async () => "controlled",
          search: async (p: { engine?: string; type?: string }) => {
            const r =
              p.type === "exact_matches"
                ? { exact_matches: [{ title: "exact", link: "https://unique.example.org/item" }] }
                : p.type === "about_this_image"
                  ? { about_this_image: { sections: [] } }
                  : p.engine === "google_lens"
                    ? { visual_matches: [{ title: "visual", link: "https://visual.example.org/a" }] }
                    : p.engine === "google_news"
                      ? { news_results: [] }
                      : { organic_results: [] };
            // Exact retrieval settling is where the clock crosses 55s.
            if (p.type === "exact_matches") clock = 56_000;
            return r;
          },
        } as never,
        jev: {
          ask: async () => {
            jevCalls += 1;
            return { answers: GOOD_ANSWERS, model: "jev-1.13.0", identity: VERIFIED_JEV };
          },
        } as never,
        fetchPage: async (url: string): Promise<FetchedPage> => ({
          url,
          html: `<html><body><article><p>${"Body. ".repeat(20)}</p></article></body></html>`,
        }),
        now: () => clock,
      },
    );
    // No new semantic work may dispatch after the deadline; the run still
    // finalizes with the evidence it already has.
    expect(jevCalls).toBe(0);
    expect(events.some((e) => e.type === "investigation.completed")).toBe(true);
  });
});

/* ------------------- R2 residual — root fallback bypass ------------------- */

describe("R2 residual — a contradicted root entity's date cannot re-enter via the root fallback", () => {
  const contradictingRootHtml = (fetchedUrl: string) =>
    `<html><head><script type="application/ld+json">${JSON.stringify({
      "@type": "NewsArticle",
      url: "https://other.example.org/related",
      datePublished: "1999-01-01",
    })}</script></head><body><article><p>${"Actual page body. ".repeat(30)}</p></article></body></html>`;

  it("extractPage(html, fetchedUrl) rejects the contradicted root date outright", () => {
    const ex = extractPage(
      contradictingRootHtml("https://target.example.org/story"),
      "https://target.example.org/story",
    );
    expect(ex.jsonLdDates).toEqual([]);
    expect(ex.rejectedJsonLdDates).toEqual([
      { value: "1999-01-01", reason: "contradictory_entity_binding" },
    ]);
  });

  it("full pipeline — the contradicted root date never reaches the timeline", async () => {
    type Item = {
      sourceUrl: string;
      observedAt: string | null;
      dateProvenance: { value: string | null; rejectedCandidates: Array<{ value: string }> };
    };
    const events: Array<{
      type: string;
      result?: { timeline?: Item[]; supportingEvidence?: Item[]; undatedEvidence?: Item[] };
    }> = [];
    await runInvestigation(
      { media: new Uint8Array([1]), claim: null, timezone: "UTC", locale: "en" },
      (e) => events.push(e as never),
      {
        serpapi: {
          uploadImage: async () => "controlled",
          search: async (p: { engine?: string; type?: string }) =>
            p.type === "exact_matches"
              ? { exact_matches: [{ title: "exact", link: "https://unique.example.org/item" }] }
              : p.type === "about_this_image"
                ? { about_this_image: { sections: [] } }
                : p.engine === "google_lens"
                  ? { visual_matches: [{ title: "target", link: "https://target.example.org/story" }] }
                  : p.engine === "google_news"
                    ? { news_results: [] }
                    : { organic_results: [] },
        } as never,
        jev: {
          ask: async () => ({ answers: GOOD_ANSWERS, model: "jev-1.13.0", identity: VERIFIED_JEV }),
        } as never,
        fetchPage: async (url: string): Promise<FetchedPage> => ({
          url,
          html: url === "https://target.example.org/story"
            ? contradictingRootHtml(url)
            : `<html><body><article><p>${"Controlled factual page body. ".repeat(25)}</p></article></body></html>`,
        }),
      },
    );
    const result = events.find((e) => e.type === "investigation.completed")?.result;
    const items = [
      ...(result?.timeline ?? []),
      ...(result?.supportingEvidence ?? []),
      ...(result?.undatedEvidence ?? []),
    ];
    const target = items.find((t) => t.sourceUrl === "https://target.example.org/story");
    expect(target).toBeDefined();
    // The contradicted 1999 must appear only in rejectedCandidates — never
    // as the displayed or resolved date.
    expect(target?.dateProvenance.value).not.toBe("1999-01-01");
    expect(target?.observedAt).not.toBe("1999-01-01");
    expect(target?.dateProvenance.rejectedCandidates.map((r) => r.value)).toContain("1999-01-01");
  });
});

/* ---------- PRD 18.2/23/34 contract stage (coverage-matrix-final) ---------- */

describe("18.2 — source-bound JSON-LD/OpenGraph metadata is retained", () => {
  const richHtml = (fetchedUrl: string) =>
    `<html><head>
      <meta property="og:site_name" content="The Gazette" />
      <meta property="og:title" content="Real headline" />
      <meta property="og:type" content="article" />
      <meta name="description" content="not-og" />
      <script type="application/ld+json">${JSON.stringify({
        "@type": "NewsArticle",
        url: fetchedUrl,
        headline: "Real headline",
        author: [{ "@type": "Person", name: "A. Reporter" }],
        publisher: { "@type": "Organization", name: "The Gazette" },
        description: "A description.",
        datePublished: "2024-03-04",
      })}</script>
      <script type="application/ld+json">${JSON.stringify({
        "@type": "NewsArticle",
        url: "https://other.example.org/related",
        headline: "Contradicted headline",
        publisher: { "@type": "Organization", name: "Wrong Outlet" },
        datePublished: "1999-01-01",
      })}</script>
    </head><body><article><p>${"Body paragraph. ".repeat(30)}</p></article></body></html>`;

  it("extractPage retains the bound entity's metadata and OpenGraph pairs", () => {
    const ex = extractPage(richHtml("https://gazette.example.org/story"), "https://gazette.example.org/story");
    // Bound entity metadata retained alongside dates/title/text.
    const bound = ex.jsonLdMetadata.find((m) => m.headline === "Real headline");
    expect(bound).toBeDefined();
    expect(bound?.author).toContain("A. Reporter");
    expect(bound?.publisher).toBe("The Gazette");
    // The contradicted entity's metadata is never retained.
    expect(ex.jsonLdMetadata.some((m) => m.headline === "Contradicted headline")).toBe(false);
    expect(ex.jsonLdMetadata.some((m) => m.publisher === "Wrong Outlet")).toBe(false);
    // OpenGraph pairs retained; non-OG meta is not swept in.
    expect(ex.openGraph["og:site_name"]).toBe("The Gazette");
    expect(ex.openGraph["og:type"]).toBe("article");
    expect(ex.openGraph["description"]).toBeUndefined();
  });
});

describe("23/34 — typed provenance graph + sanitized inspection fields", () => {
  // Distinct page-bound dates so the two exact-match occurrences are
  // strictly ordered and the pairwise comparison actually runs.
  const PAGE_DATES: Record<string, string> = {
    "https://a.example.org/item": "2024-01-02",
    "https://b.example.org/item": "2024-03-04",
  };
  const metaHtml = (fetchedUrl: string) =>
    `<html><head>
      <meta property="og:site_name" content="The Gazette" />
      <script type="application/ld+json">${JSON.stringify({
        "@type": "NewsArticle",
        url: fetchedUrl,
        headline: "Fetched page headline",
        author: { "@type": "Person", name: "A. Reporter" },
        datePublished: PAGE_DATES[fetchedUrl] ?? "2024-02-15",
      })}</script>
    </head><body><article><p>${"Fetched page body. ".repeat(30)}</p></article></body></html>`;

  const PAIRWISE_ANSWER = {
    type: "choice",
    choice: "DIFFERENT_CONTEXT",
    probabilities: { SAME_CONTEXT: 0.02, DIFFERENT_CONTEXT: 0.95, UNCLEAR: 0.03 },
  };

  const jevMock = {
    ask: async (_state: unknown, questions: Record<string, unknown>) => ({
      answers: "pairwise_context" in questions ? { pairwise_context: PAIRWISE_ANSWER } : GOOD_ANSWERS,
      model: "jev-1.13.0",
      identity: VERIFIED_JEV,
    }),
  };

  const serpapiMock = {
    uploadImage: async () => "controlled",
    search: async (p: { engine?: string; type?: string; q?: string }) => {
      const meta = {
        search_metadata: {
          status: "Success",
          id: `serp-${p.type === "all" ? p.engine : (p.type ?? p.engine)}`,
        },
      };
      if (p.type === "exact_matches") {
        return {
          ...meta,
          exact_matches: [
            { title: "early", link: "https://a.example.org/item", date: "2024-01-02", position: 1 },
            { title: "late", link: "https://b.example.org/item", date: "2024-03-04", position: 2 },
          ],
        };
      }
      if (p.type === "about_this_image") return { ...meta, about_this_image: { sections: [] } };
      if (p.engine === "google_lens") return { ...meta, visual_matches: [{ title: "target", link: "https://b.example.org/item" }] };
      if (p.engine === "google_news") return { ...meta, news_results: [] };
      return { ...meta, organic_results: [] };
    },
  };

  it("full pipeline exposes searchIds, Jev distributions, comparisons, and the provenance graph", async () => {
    const events: Array<{ type: string; result?: Record<string, unknown> }> = [];
    await runInvestigation(
      { media: new Uint8Array([1]), claim: null, timezone: "UTC", locale: "en" },
      (e) => events.push(e as never),
      {
        serpapi: serpapiMock as never,
        jev: jevMock as never,
        fetchPage: async (url: string): Promise<FetchedPage> => ({ url, html: metaHtml(url) }),
      },
    );
    const result = events.find((e) => e.type === "investigation.completed")?.result;
    expect(result).toBeDefined();
    if (!result) return;

    // §34 — sanitized actual search identifiers on the request log.
    const reqLog = result.requestLog as Array<{ engine: string; searchId?: string | null }>;
    expect(reqLog.length).toBeGreaterThan(0);
    const lensRow = reqLog.find((r) => r.engine === "lens_all");
    expect(lensRow?.searchId).toBe("serp-google_lens");

    // §34 — per-item search ids + verified per-question distributions.
    type Item = {
      occurrenceId: string;
      searchIds?: string[];
      jevDistributions?: { pageRole: Record<string, number> } | null;
      pageMetadata?: { openGraph: Record<string, string>; jsonLd: Array<{ headline: string | null }> } | null;
    };
    const all = [
      ...(result.timeline as Item[]),
      ...(result.undatedEvidence as Item[]),
      ...(result.supportingEvidence as Item[]),
      ...(result.contextualEvidence as Item[]),
    ];
    const exactItem = all.find((t) => t.searchIds?.includes("serp-exact_matches"));
    expect(exactItem).toBeDefined();
    const classified = all.find((t) => t.jevDistributions !== null && t.jevDistributions !== undefined);
    expect(classified?.jevDistributions?.pageRole.reporting).toBe(0.8);
    // §18.2 — deep-read metadata retained on the inspected candidate.
    const deepRead = all.find((t) => t.pageMetadata?.jsonLd.some((m) => m.headline === "Fetched page headline"));
    expect(deepRead).toBeDefined();
    expect(deepRead?.pageMetadata?.openGraph["og:site_name"]).toBe("The Gazette");

    // §23 — the typed provenance graph is present and relations are real.
    const prov = result.provenance as {
      media: { id: string };
      occurrences: Array<{ id: string; domainId: string; segmentId: string | null }>;
      sourceDomains: Array<{ id: string; domain: string; occurrenceIds: string[] }>;
      contextSegments: Array<{ id: string; index: number; occurrenceIds: string[] }>;
      divergenceEdges: Array<{ fromSegmentId: string; toSegmentId: string; toOccurrenceId: string }>;
      claimContext: unknown;
    } | undefined;
    expect(prov).toBeDefined();
    expect(prov?.media.id).toBe("media");
    expect(prov?.occurrences.length).toBe(all.length);
    // Registrable domains collapse a./b.example.org into one domain node
    // that both occurrences point at.
    const domain = prov?.sourceDomains.find((d) => d.domain === "example.org");
    expect(domain).toBeDefined();
    expect(domain?.occurrenceIds.length).toBeGreaterThanOrEqual(2);
    expect(prov?.claimContext).toBeNull();
    // The pairwise mock returns strong DIFFERENT_CONTEXT — a real
    // divergence edge between segments must exist.
    expect(prov?.contextSegments.length).toBeGreaterThanOrEqual(2);
    expect(prov?.divergenceEdges.length).toBeGreaterThanOrEqual(1);

    // §34 — comparison evidence: actual per-pair distributions.
    const comparisons = result.comparisons as Array<{
      pairId: string;
      connector: string;
      distribution: { differentContext: number } | null;
    }> | undefined;
    expect(comparisons).toBeDefined();
    const decisive = comparisons?.find((c) => c.connector === "different_context");
    expect(decisive?.distribution?.differentContext).toBe(0.95);
  });

  it("claim mode — provenance carries the claim context compared with segments", async () => {
    const events: Array<{ type: string; result?: Record<string, unknown> }> = [];
    await runInvestigation(
      {
        media: new Uint8Array([1]),
        claim: "The image shows an event in March 2024.",
        timezone: "UTC",
        locale: "en",
      },
      (e) => events.push(e as never),
      {
        serpapi: serpapiMock as never,
        jev: jevMock as never,
        fetchPage: async (url: string): Promise<FetchedPage> => ({ url, html: metaHtml(url) }),
      },
    );
    const result = events.find((e) => e.type === "investigation.completed")?.result;
    const prov = result?.provenance as
      | { claimContext: { claim: string; claimDate: string | null; comparedSegmentIds: string[] } | null }
      | undefined;
    expect(prov?.claimContext).not.toBeNull();
    expect(prov?.claimContext?.claim).toContain("March 2024");
    expect(prov?.claimContext?.comparedSegmentIds.length).toBeGreaterThanOrEqual(1);
  });
});
