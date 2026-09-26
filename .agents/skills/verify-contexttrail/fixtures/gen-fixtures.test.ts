/**
 * Controlled-boundary fixture generator (verification scaffolding).
 *
 * Runs the REAL runInvestigation orchestrator with controlled SerpApi/Jev/
 * page-fetch providers and writes the NDJSON event streams into this
 * directory for `control-contexttrail drive investigation --case <name>`.
 * These fixtures prove rendering/behavior at the public-contract boundary —
 * they never represent real provenance. Regenerate after contract changes:
 *
 *   CONTEXTTRAIL_GEN_FIXTURES=1 npx vitest run <this file>
 */
import { describe, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInvestigation, type SearchProvider } from "../../../../src/lib/investigation/run";
import type { SerpapiParams } from "../../../../src/lib/serpapi/client";
import type { JevClient } from "../../../../src/lib/jev/client";
import type { FetchedPage } from "../../../../src/lib/pages/fetch";

const GEN = process.env.CONTEXTTRAIL_GEN_FIXTURES === "1";
const OUT = path.dirname(fileURLToPath(import.meta.url));

const CHOICE = {
  page_role: ["REPORTING", "FACT_CHECK", "SOCIAL_REPOST", "AGGREGATOR", "COMMENTARY", "OTHER"],
  context_relation: ["SAME_CONTEXT", "DIFFERENT_CONTEXT", "HISTORICAL_REFERENCE", "UNCLEAR"],
  claim_relation: ["SUPPORTS", "CONTRADICTS", "NEUTRAL", "INSUFFICIENT"],
  pairwise_context: ["SAME_CONTEXT", "DIFFERENT_CONTEXT", "UNCLEAR"],
} as const;

const answers = (qs: Record<string, unknown>, winners: Record<string, string>) =>
  Object.fromEntries(
    Object.keys(qs).map((k) => [
      k,
      k === "relevance"
        ? { type: "noul", noul: 0.92 }
        : {
            type: "choice",
            choice: winners[k] ?? (CHOICE as Record<string, readonly string[]>)[k]?.[0],
            probabilities: Object.fromEntries(
              ((CHOICE as Record<string, readonly string[]>)[k] ?? ["UNCLEAR"]).map((v: string) => [
                v,
                v === (winners[k] ?? (CHOICE as Record<string, readonly string[]>)[k]?.[0]) ? 0.9 : 0.1 / 3,
              ]),
            ),
          },
    ]),
  );

const lensAll = {
  search_metadata: { id: "fixture-lens-all", status: "Success" },
  visual_matches: [
    {
      position: 1,
      title: "CONTROLLED FIXTURE visual lead — 2019 article",
      link: "https://fixture-news-a.example.org/report/lead-2019",
      snippet: "controlled lead snippet",
      thumbnail: "https://example.invalid/lead.png",
      date: "Mar 3, 2019",
    },
    {
      position: 2,
      title: "CONTROLLED FIXTURE visual lead — undated",
      link: "https://fixture-blog-b.example.org/post/undated",
      snippet: "controlled undated lead",
      thumbnail: "https://example.invalid/lead2.png",
    },
  ],
  related_content: [{ query: "controlled grounded query", link: "https://google.com/q" }],
};

const lensExact = {
  search_metadata: { id: "fixture-lens-exact", status: "Success" },
  exact_matches: [
    {
      position: 1,
      title: "CONTROLLED FIXTURE exact copy — 2018 archive",
      link: "https://fixture-archive-c.example.org/item/2018",
      date: "Jun 15, 2018",
      thumbnail: "https://example.invalid/exact1.png",
    },
    {
      position: 2,
      title: "CONTROLLED FIXTURE exact copy — 2020 repost",
      link: "https://fixture-site-d.example.org/page/2020",
      date: "Oct 2, 2020",
      thumbnail: "https://example.invalid/exact2.png",
    },
  ],
};

const aboutImage = { search_metadata: { id: "fixture-about", status: "Success" }, about_this_image: { sections: [] } };

const googleSearch = {
  search_metadata: { id: "fixture-google", status: "Success" },
  organic_results: [
    {
      position: 1,
      title: "CONTROLLED FIXTURE contextual article",
      link: "https://fixture-context-e.example.org/story",
      snippet: "controlled contextual result",
      date: "Aug 8, 2021",
    },
  ],
};

const googleNews = {
  search_metadata: { id: "fixture-news", status: "Success" },
  news_results: [
    {
      position: 1,
      title: "CONTROLLED FIXTURE current news hit",
      link: "https://fixture-news-f.example.org/current",
      date: "2 days ago",
      thumbnail: "https://example.invalid/news.png",
    },
  ],
};

const serpapi: SearchProvider = {
  uploadImage: async () => "fixture-upload-id",
  search: async (p: SerpapiParams) => {
    if (p.engine === "google_lens" && p.type === "exact_matches") return lensExact;
    if (p.engine === "google_lens" && p.type === "about_this_image") return aboutImage;
    if (p.engine === "google_lens") return lensAll;
    if (p.engine === "google_news") return googleNews;
    return googleSearch;
  },
};

const jev = {
  ask: async (_s: unknown, qs: Record<string, unknown>) => ({
    answers: answers(qs, { context_relation: "DIFFERENT_CONTEXT", claim_relation: "NEUTRAL" }),
    model: "jev-1.13.0",
  }),
} as unknown as JevClient;

const fetchPage = async (url: string): Promise<FetchedPage> => ({
  url,
  html: `<html><head><title>CONTROLLED page</title></head><body><article><p>${"Controlled extracted text about a fixture photograph and its publication context. ".repeat(12)}</p></article></body></html>`,
});

describe.skipIf(!GEN)("controlled fixture generation", () => {
  it.each([
    ["controlled-trace", null],
    ["controlled-claim", "This controlled claim describes a fictional event today."],
  ])("writes %s.ndjson", async (name, claim) => {
    const events: unknown[] = [];
    await runInvestigation(
      { media: new Uint8Array([1, 2, 3]), claim, timezone: "UTC", locale: "en" },
      (e) => events.push(e),
      { serpapi, jev, fetchPage },
    );
    const file = path.join(OUT, `${name}.ndjson`);
    fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const last = events[events.length - 1] as { type: string };
    if (last.type !== "investigation.completed") throw new Error(`${name}: no terminal event`);
  });
});
