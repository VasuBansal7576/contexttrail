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
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { runInvestigation, type SearchProvider } from "../../../../src/lib/investigation/run";
import { JEV_MODEL } from "../../../../src/lib/jev/client";
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

const answers = (qs: Record<string, unknown>, winners: Record<string, string>, relevance = 0.92) =>
  Object.fromEntries(
    Object.keys(qs).map((k) => [
      k,
      k === "relevance"
        ? { type: "noul", noul: relevance }
        : (() => {
            const keys = (CHOICE as Record<string, readonly string[]>)[k] ?? ["UNCLEAR"];
            const winner = winners[k] ?? keys[0];
            return {
              type: "choice",
              choice: winner,
              // Probabilities must sum to 1 — the validated contract
              // rejects unnormalized distributions.
              probabilities: Object.fromEntries(
                keys.map((v: string) => [
                  v,
                  v === winner ? 0.9 : (1 - 0.9) / (keys.length - 1),
                ]),
              ),
            };
          })(),
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
    identity: {
      requested: "jev-1.13.0",
      reported: "jev-1.13.0",
      status: "verified",
      pinned: true,
    },
  }),
} as unknown as JevClient;

/** Entity-bound JSON-LD publication dates per fixture domain — gives the
 *  deep-read phase real dated evidence so core occurrences land in the
 *  timeline and takeaways can cite evidenceIds. */
const PAGE_DATES: Record<string, string> = {
  "fixture-archive-c.example.org": "2018-06-15",
  "fixture-site-d.example.org": "2020-10-02",
  "fixture-news-f.example.org": "2026-09-24",
  "fixture-dupe-e.example.org": "2020-10-02",
  "fixture-four-h.example.org": "2023-08-01",
};

const fetchPage = async (url: string): Promise<FetchedPage> => {
  const host = new URL(url).hostname;
  const date = PAGE_DATES[host];
  const ld = date
    ? `<script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "NewsArticle",
        headline: "CONTROLLED article",
        datePublished: date,
      })}</script>`
    : "";
  return {
    url,
    html: `<html><head><title>CONTROLLED page</title>${ld}</head><body><article><p>${"Controlled extracted text about a fixture photograph and its publication context. ".repeat(12)}</p></article></body></html>`,
  };
};

/** The transparent 1×1 PNG the harness submits as the *input* image. */
export const SUBMITTED_1PX_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

/** Solid 8×8 RGB PNG as a data URI in one exact colour.
 *
 *  Controlled retrieved images must be *distinguishable*: a set of identical
 *  1×1 transparent pixels renders identically wherever it appears, so a
 *  screenshot cannot attribute the rendered <img> to the candidate that
 *  shipped it and cannot disprove submission-image substitution. One colour
 *  per candidate gives every retrieved image its own bytes. */
function colorPng(r: number, g: number, b: number): string {
  const w = 8;
  const h = 8;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const o = y * (1 + w * 3);
    raw[o] = 0; // filter byte
    for (let x = 0; x < w; x++) {
      raw[o + 1 + x * 3] = r;
      raw[o + 2 + x * 3] = g;
      raw[o + 3 + x * 3] = b;
    }
  }
  const png = Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

/** Per-candidate retrieved images for the paired-divergence fixture. */
const PAIR_IMG = {
  archive: colorPng(198, 40, 40),
  site: colorPng(40, 96, 198),
  dupe: colorPng(40, 176, 96),
  four: colorPng(232, 176, 32),
} as const;

const lensAllViewer = {
  search_metadata: { id: "fixture-lens-viewer", status: "Success" },
  visual_matches: [
    {
      position: 1,
      title: "CONTROLLED FIXTURE lead — loadable thumbnail",
      link: "https://fixture-viewer-a.example.org/report/loadable",
      snippet: "controlled loadable snippet",
      // Distinct bytes per lead: a screenshot of the rendered <img> can only
      // be attributed to a specific lead if the leads differ visually.
      thumbnail: colorPng(24, 120, 200),
      date: "Apr 4, 2019",
    },
    {
      position: 2,
      title: "CONTROLLED FIXTURE lead — no snippet",
      link: "https://fixture-viewer-b.example.org/post/nosnippet",
      thumbnail: colorPng(200, 90, 24),
      date: "May 5, 2020",
    },
  ],
};

const serpapiViewer: SearchProvider = {
  uploadImage: async () => "fixture-upload-id",
  search: async (p: SerpapiParams) => {
    if (p.engine === "google_lens" && p.type === "exact_matches") return lensExact;
    if (p.engine === "google_lens" && p.type === "about_this_image") return aboutImage;
    if (p.engine === "google_lens") return lensAllViewer;
    if (p.engine === "google_news") return googleNews;
    return googleSearch;
  },
};

/** Every surface returns a provider-validated empty collection — claim mode
 *  resolves to an honest INSUFFICIENT_EVIDENCE result. */
const empty = (id: string) => ({ search_metadata: { id, status: "Success" } });
const serpapiEmpty: SearchProvider = {
  uploadImage: async () => "fixture-upload-id",
  search: async (p: SerpapiParams) => empty(`fixture-empty-${p.engine}`),
};

/* ------------------------- paired divergence ---------------------------
 *
 * The product exposes a paired-divergence viewer entry, so the controlled
 * boundary has to be able to produce one: a real `firstObservedContextDivergence`
 * with two existing timeline endpoints, not a hand-written pair block.
 *
 * Four dated core occurrences make the three connector states distinguishable
 * in ONE fixture:
 *
 *   2018-06-15  archive-c   start
 *   2020-10-02  site-d      different_context   ← the divergence edge (pair)
 *   2020-10-02  dupe-e      unexamined           ← same-day: NOT COMPARED
 *   2023-08-01  four-h      uncertain            ← compared, INCONCLUSIVE
 *
 * `not compared` and `inconclusive` are different claims, so the fixture
 * deliberately produces both and the contract suite keeps them apart.
 */

const lensExactPair = {
  search_metadata: { id: "fixture-lens-exact-pair", status: "Success" },
  exact_matches: [
    {
      position: 1,
      title: "CONTROLLED FIXTURE pair copy — 2018 archive",
      link: "https://fixture-archive-c.example.org/item/2018",
      date: "Jun 15, 2018",
      thumbnail: PAIR_IMG.archive,
    },
    {
      position: 2,
      title: "CONTROLLED FIXTURE pair copy — 2020 repost",
      link: "https://fixture-site-d.example.org/page/2020",
      date: "Oct 2, 2020",
      thumbnail: PAIR_IMG.site,
    },
    {
      position: 3,
      title: "CONTROLLED FIXTURE pair copy — 2020 same-day duplicate",
      link: "https://fixture-dupe-e.example.org/page/2020-again",
      date: "Oct 2, 2020",
      thumbnail: PAIR_IMG.dupe,
    },
    {
      position: 4,
      title: "CONTROLLED FIXTURE pair copy — 2023 follow-up",
      link: "https://fixture-four-h.example.org/page/2023",
      date: "Aug 1, 2023",
      thumbnail: PAIR_IMG.four,
    },
  ],
};

const serpapiPair: SearchProvider = {
  uploadImage: async () => "fixture-upload-id",
  search: async (p: SerpapiParams) => {
    if (p.engine === "google_lens" && p.type === "exact_matches") return lensExactPair;
    if (p.engine === "google_lens" && p.type === "about_this_image") return aboutImage;
    if (p.engine === "google_lens") return lensAll;
    if (p.engine === "google_news") return googleNews;
    return googleSearch;
  },
};

/** Pairwise verdict keyed by the *later* occurrence's title — every controlled
 *  host shares one registrable domain, so the title is the only honest key.
 *  `DIFFERENT_CONTEXT` establishes the pair; `UNCLEAR` is a comparison that
 *  really happened and really did not settle. */
const PAIRWISE_BY_TITLE: Record<string, string> = {
  "CONTROLLED FIXTURE pair copy — 2020 repost": "DIFFERENT_CONTEXT",
  "CONTROLLED FIXTURE pair copy — 2023 follow-up": "UNCLEAR",
};

const pairwiseWinners = (state: unknown): Record<string, string> => {
  const b = (state as { occurrence_b?: { title?: string } } | null | undefined)?.occurrence_b;
  return { pairwise_context: PAIRWISE_BY_TITLE[b?.title ?? ""] ?? "UNCLEAR" };
};

/** Per-candidate relevance. The deep-read budget is spent on the strongest
 *  judged candidates, so without a strict relevance order the four exact
 *  matches would be selected by id order and three of them would never be
 *  read — the pair could not exist. */
const RELEVANCE_BY_TITLE: Record<string, number> = {
  "CONTROLLED FIXTURE pair copy — 2018 archive": 0.96,
  "CONTROLLED FIXTURE pair copy — 2020 repost": 0.93,
  "CONTROLLED FIXTURE pair copy — 2020 same-day duplicate": 0.9,
  "CONTROLLED FIXTURE pair copy — 2023 follow-up": 0.87,
};

const relevanceFor = (state: unknown): number => {
  const title = (state as { result?: { title?: string } } | null | undefined)?.result?.title;
  return RELEVANCE_BY_TITLE[title ?? ""] ?? 0.7;
};

const jevPair = {
  ask: async (s: unknown, qs: Record<string, unknown>) => ({
    answers: answers(
      qs,
      {
        context_relation: "DIFFERENT_CONTEXT",
        claim_relation: "NEUTRAL",
        page_role: "REPORTING",
        ...pairwiseWinners(s),
      },
      relevanceFor(s),
    ),
    model: "jev-1.13.0",
    identity: { requested: "jev-1.13.0", reported: "jev-1.13.0", status: "verified", pinned: true },
  }),
} as unknown as JevClient;

describe.skipIf(!GEN)("controlled fixture generation", () => {
  it.each([
    ["controlled-trace", null, serpapi, jev],
    ["controlled-claim", "This controlled claim describes a fictional event today.", serpapi, jev],
    ["controlled-viewer", "This controlled claim describes a fictional event today.", serpapiViewer, jev],
    ["controlled-insufficient", "This controlled claim describes a fictional event today.", serpapiEmpty, jev],
    ["controlled-pair", "This controlled claim describes a fictional event today.", serpapiPair, jevPair],
  ])("writes %s.ndjson", async (name, claim, provider, jevClient) => {
    const events: unknown[] = [];
    await runInvestigation(
      { media: new Uint8Array([1, 2, 3]), claim, timezone: "UTC", locale: "en" },
      (e) => events.push(e),
      { serpapi: provider, jev: jevClient, fetchPage },
    );
    const file = path.join(OUT, `${name}.ndjson`);
    fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const last = events[events.length - 1] as { type: string };
    if (last.type !== "investigation.completed") throw new Error(`${name}: no terminal event`);
  });
});

/* ---------------------------------------------------------------------- *
 * Always-on fixture contract (V4).
 *
 * The generation block above only runs when CONTEXTTRAIL_GEN_FIXTURES=1, so
 * on its own it proves nothing about the fixtures actually committed to the
 * repository. This suite runs on every `vitest run` and asserts the public
 * contract of every checked-in stream: terminal event, mode/status
 * coherence, requestLog.durationMs, policy/support/identity/date/origin
 * fields, normalized probability distributions, pinned model identity,
 * distinguishable images, and the absence of real hosts or credential
 * material.
 * ---------------------------------------------------------------------- */

const CLAIM_STATUSES = [
  "CONTEXT_CONFLICT",
  "POSSIBLE_CONTEXT_CONFLICT",
  "NO_CONFLICT_FOUND",
  "INSUFFICIENT_EVIDENCE",
] as const;

const CLAIM_FIXTURES = new Set([
  "controlled-claim",
  "controlled-viewer",
  "controlled-insufficient",
  "controlled-pair",
]);
const TRACE_FIXTURES = new Set(["controlled-trace"]);
const DATE_STATUSES = new Set(["usable", "approximate", "unknown", "absent"]);
const DATE_PRECISIONS = new Set(["day", "month", "year", "unknown", "none"]);
const IDENTITY_BASES = new Set([
  "contextual",
  "unverified",
  "lens_exact_collection",
  "hash_verified",
  "verifier",
]);
const VERIFICATION_STATUSES = new Set([
  "provider_reported",
  "unavailable",
  "verified",
  "failed",
  "not_applicable",
]);
const RELATIONSHIPS = new Set([
  "EXACT_MATCH",
  "NEAR_MATCH",
  "VISUAL_LEAD",
  "CONTEXTUAL",
  "UNRELATED",
  null,
]);
const CONNECTORS = new Set([
  "start",
  "same_context",
  "different_context",
  "uncertain",
  "unexamined",
  "unknown",
  null,
]);
const LIMITATION_CODES = new Set([
  "exact_match_retrieval_unavailable",
  "about_this_image_unavailable",
  "insufficient_dated_occurrences",
  "near_match_verifier_disabled",
  "reporting_origins_unresolved",
  "unknown_dates_present",
  "unverified_visual_leads_present",
  "no_current_media_corroboration",
  "location_unresolved",
  "web_context_unavailable",
  "semantic_classification_unavailable",
  "model_identity_unverified",
]);
const TAKEAWAY_CODES = new Set([
  "temporal_conflict",
  "location_conflict",
  "historical_reuse",
  "no_current_media_corroboration",
]);

type Json = Record<string, unknown>;

const fixtureNames = () =>
  fs
    .readdirSync(OUT)
    .filter((f) => f.endsWith(".ndjson"))
    .map((f) => f.replace(/\.ndjson$/, ""))
    .sort();

const readEvents = (name: string): Json[] =>
  fs
    .readFileSync(path.join(OUT, `${name}.ndjson`), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Json);

const terminalResult = (events: Json[]): Json => {
  const last = events[events.length - 1] as Json | undefined;
  if (!last || last["type"] !== "investigation.completed") {
    throw new Error("fixture does not end with investigation.completed");
  }
  const result = last["result"];
  if (!result || typeof result !== "object") throw new Error("terminal event has no result");
  return result as Json;
};

const asArray = (v: unknown): Json[] =>
  Array.isArray(v) ? v.filter((x): x is Json => !!x && typeof x === "object") : [];

const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

const str = (o: Json | null | undefined, k: string): string | null =>
  o && typeof o[k] === "string" ? (o[k] as string) : null;

const walk = (value: unknown, visit: (node: Json) => void) => {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const v of value) walk(v, visit);
    return;
  }
  const record = value as Json;
  visit(record);
  for (const v of Object.values(record)) walk(v, visit);
};

/** Every absolute URL that appears anywhere in the fixture must address a
 *  controlled fixture host — never a real site. */
const collectUrls = (events: Json[]): string[] => {
  const out: string[] = [];
  const re = /https?:\/\/[^\s"\\]+/g;
  for (const e of events) {
    for (const m of JSON.stringify(e).matchAll(re)) out.push(m[0]);
  }
  return out;
};

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

const EXPECTED_LABELS: Record<string, readonly string[]> = {
  contextRelation: ["sameContext", "differentContext", "historicalReference", "unclear"],
  pageRole: ["reporting", "factCheck", "socialRepost", "aggregator", "commentary", "other"],
  claimRelation: ["supports", "contradicts", "neutral", "insufficient"],
  locationRelation: ["sameLocation", "differentLocation", "unclear"],
};

/** The controlled fixtures are authored to classify every candidate as a
 *  different-context, neutral, reporting-page hit — the exact shape that
 *  drives the conflict statuses the drives assert. */
const EXPECTED_ARGMAX: Record<string, string | undefined> = {
  contextRelation: "differentContext",
  pageRole: "reporting",
  claimRelation: "neutral",
};

const FIXTURE_FILES = fixtureNames();

describe("controlled fixture contract", () => {
  it("fixture set covers every mapped case", () => {
    expect(FIXTURE_FILES.length).toBeGreaterThanOrEqual(4);
    for (const name of [...CLAIM_FIXTURES, ...TRACE_FIXTURES]) {
      expect(FIXTURE_FILES).toContain(name);
    }
  });

  it.each(FIXTURE_FILES)("%s: terminal event and mode/status coherence", (name) => {
    const events = readEvents(name);
    expect(events.length).toBeGreaterThan(5);
    const result = terminalResult(events);
    const mode = str(result, "mode");
    const status = str(result, "status");
    if (TRACE_FIXTURES.has(name)) {
      expect(mode).toBe("trace");
      expect(status).toBeNull();
      expect(result["claim"]).toBeFalsy();
    } else {
      expect(CLAIM_FIXTURES.has(name)).toBe(true);
      expect(mode).toBe("claim_check");
      expect(status).not.toBeNull();
      expect(CLAIM_STATUSES).toContain(status as (typeof CLAIM_STATUSES)[number]);
      expect(str(result, "claim")).toBeTruthy();
      // Every claim status other than NO_CONFLICT_FOUND must not be dressed
      // up as proof; NO_CONFLICT_FOUND carries the explicit caveat flag.
      if (status === "NO_CONFLICT_FOUND") {
        expect(result["doesNotProveClaimTrue"]).toBe(true);
      }
      expect(strs(result["statusBasis"]).length).toBeGreaterThan(0);
    }
  });

  it.each(FIXTURE_FILES)("%s: requestLog carries engine counters and durationMs", (name) => {
    const result = terminalResult(readEvents(name));
    const log = asArray(result["requestLog"]);
    expect(log.length).toBeGreaterThan(0);
    const engines = new Set<string>();
    for (const entry of log) {
      const engine = str(entry, "engine");
      expect(engine).toBeTruthy();
      engines.add(engine as string);
      for (const key of ["attempted", "returned", "retained", "durationMs"]) {
        const v = entry[key];
        expect(typeof v, `${name}/${engine}/${key} must be a number`).toBe("number");
        expect(Number.isFinite(v as number), `${name}/${engine}/${key} finite`).toBe(true);
        expect(v as number).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(v as number), `${name}/${engine}/${key} integer`).toBe(true);
      }
      expect(entry["retained"] as number).toBeLessThanOrEqual(entry["returned"] as number);
    }
    expect(engines.size).toBe(log.length);
  });

  it.each(FIXTURE_FILES)("%s: policy, support, identity, date and origin fields", (name) => {
    const result = terminalResult(readEvents(name));
    const timeline = asArray(result["timeline"]);
    const supporting = asArray(result["supportingEvidence"]);
    const contextual = asArray(result["contextualEvidence"]);
    const undated = asArray(result["undatedEvidence"]);

    // support: every cross-reference resolves to an evidence id we actually
    // shipped, so the UI can never cite a phantom id.
    const knownIds = new Set<string>();
    for (const item of [...timeline, ...supporting, ...contextual, ...undated]) {
      const id = str(item, "evidenceId") ?? str(item, "occurrenceId");
      expect(id, `${name}: timeline item without an id`).toBeTruthy();
      expect(knownIds.has(id as string), `${name}: duplicate evidence id ${id}`).toBe(false);
      knownIds.add(id as string);
    }
    expect(knownIds.size).toBe(timeline.length + supporting.length + contextual.length + undated.length);

    for (const takeaway of asArray(result["takeaways"])) {
      const code = str(takeaway, "code");
      expect(TAKEAWAY_CODES.has(code as string), `${name}: unknown takeaway code ${code}`).toBe(true);
      for (const id of strs(takeaway["evidenceIds"])) {
        expect(knownIds.has(id), `${name}: takeaway cites unknown id ${id}`).toBe(true);
      }
    }

    for (const limitation of strs(result["limitations"])) {
      expect(LIMITATION_CODES.has(limitation), `${name}: unknown limitation ${limitation}`).toBe(true);
    }

    // policy: gates are enumerable, boolean, and cite real evidence ids.
    for (const gate of asArray(result["policyReasons"])) {
      expect(typeof gate["gate"]).toBe("string");
      expect(typeof gate["passed"]).toBe("boolean");
      expect(typeof gate["detail"]).toBe("string");
      for (const id of strs(gate["supportIds"])) {
        expect(knownIds.has(id), `${name}: policy gate cites unknown id ${id}`).toBe(true);
      }
    }

    // identity: every candidate's identity evidence is internally truthful.
    walk(readEvents(name), (node) => {
      const ie = node["identityEvidence"];
      if (!ie || typeof ie !== "object") return;
      const rec = ie as Json;
      const basis = str(rec, "basis");
      const status = str(rec, "verificationStatus");
      expect(IDENTITY_BASES.has(basis as string), `${name}: unknown identity basis ${basis}`).toBe(true);
      expect(
        VERIFICATION_STATUSES.has(status as string),
        `${name}: unknown verification status ${status}`,
      ).toBe(true);
      if (status === "verified") {
        expect(rec["verifierVersion"], `${name}: verified identity without a verifier version`).toBeTruthy();
        expect(rec["verifierConfigId"], `${name}: verified identity without a config id`).toBeTruthy();
        expect(typeof rec["hashDistance"], `${name}: verified identity without a hash distance`).toBe("number");
      } else {
        // An unverified identity must not pretend to carry verifier detail.
        expect(rec["verifierVersion"]).toBeNull();
        expect(rec["verifierConfigId"]).toBeNull();
      }
    });

    // date: usable dates are real ISO days; unknown dates are explicit.
    for (const item of timeline) {
      const status = str(item, "dateStatus");
      expect(DATE_STATUSES.has(status as string), `${name}: unknown dateStatus ${status}`).toBe(true);
      expect(DATE_PRECISIONS.has(String(item["datePrecision"])), `${name}: unknown datePrecision`).toBe(true);
      if (status === "usable") {
        expect(str(item, "observedAt")).toMatch(/^\d{4}-\d{2}-\d{2}/);
      } else {
        expect(item["observedAt"] ?? null).toBeNull();
      }
      expect(RELATIONSHIPS.has((str(item, "mediaRelationship") ?? null) as never), `${name}: unknown mediaRelationship`).toBe(true);
      const connector = (item["incomingConnector"] ?? null) as Json | null;
      const kind = connector ? str(connector, "kind") : null;
      expect(CONNECTORS.has(kind as never), `${name}: unknown connector ${kind}`).toBe(true);
      expect(str(item, "registrableDomain"), `${name}: timeline item missing origin domain`).toBeTruthy();
    }

    // origin: summary counters must agree with the arrays they summarize.
    expect(result["reportingGroupCount"]).toBe(asArray(result["reportingGroups"]).length);
    expect(result["unresolvedOriginCount"]).toBe(strs(result["unresolvedCandidateIds"]).length);
    expect(typeof result["sourceDomainCount"], `${name}: sourceDomainCount`).toBe("number");
    expect(result["sourceDomainCount"] as number).toBeGreaterThanOrEqual(0);
    // contextSegmentCount is null until segmentation actually ran.
    if (result["contextSegmentCount"] !== null) {
      expect(typeof result["contextSegmentCount"], `${name}: contextSegmentCount`).toBe("number");
      expect(result["contextSegmentCount"] as number).toBeGreaterThanOrEqual(0);
    }
    for (const group of asArray(result["reportingGroups"])) {
      expect(str(group, "groupId")).toBeTruthy();
      expect(strs(group["memberIds"]).length).toBeGreaterThan(0);
      for (const id of strs(group["memberIds"])) {
        expect(knownIds.has(id), `${name}: reporting group cites unknown id ${id}`).toBe(true);
      }
    }

    const coverage = (result["comparisonCoverage"] ?? null) as Json | null;
    if (coverage) {
      for (const key of ["eligible", "selected", "comparedPairs", "displayedDatedCore"]) {
        expect(typeof coverage[key], `${name}: comparisonCoverage.${key}`).toBe("number");
        expect(coverage[key] as number).toBeGreaterThanOrEqual(0);
      }
      for (const pair of strs(coverage["comparedPairIds"])) {
        for (const id of pair.split("|")) expect(knownIds.has(id)).toBe(true);
      }
    }

    if (timeline.length > 0) {
      const dated = timeline
        .map((t) => str(t, "observedAt"))
        .filter((d): d is string => !!d)
        .sort();
      expect(dated.length).toBeGreaterThan(0);
      expect(str(result, "earliestObservedOccurrence")).toBe(dated[0]);
      expect(result["sourceDomainCount"]).toBeGreaterThanOrEqual(1);
    }
  });

  it.each(FIXTURE_FILES)("%s: probability distributions are normalized", (name) => {
    const events = readEvents(name);
    let checked = 0;
    const verdict = terminalResult(readEvents(name));
    const hasCandidates = asArray(verdict["timeline"]).length > 0;
    walk(events, (node) => {
      const judgment = node["publicJudgment"];
      if (!judgment || typeof judgment !== "object") return;
      const j = judgment as Json;
      checked++;
      const relevance = j["relevance"];
      expect(typeof relevance, `${name}: judgment.relevance must be a number`).toBe("number");
      expect(relevance as number).toBeGreaterThanOrEqual(0);
      expect(relevance as number).toBeLessThanOrEqual(1);
      let published = 0;
      for (const [key, labels] of Object.entries(EXPECTED_LABELS)) {
        const dist = j[key];
        // Trace mode never asks the context/claim questions — an explicit
        // null is the truthful answer, not a missing distribution.
        if (dist === null || dist === undefined) continue;
        published++;
        const record = dist as Record<string, number>;
        expect(Object.keys(record).sort(), `${name}: ${key} labels`).toEqual([...labels].sort());
        for (const v of Object.values(record)) {
          expect(typeof v, `${name}: ${key} value type`).toBe("number");
          expect(v as number).toBeGreaterThan(0);
          expect(v as number).toBeLessThanOrEqual(1);
        }
        const sum = Object.values(record).reduce((a, b) => a + b, 0);
        expect(Math.abs(sum - 1), `${name}: ${key} sums to ${sum}`).toBeLessThan(1e-6);
        const winner = EXPECTED_ARGMAX[key];
        if (winner) {
          const argmax = Object.entries(record).sort((a, b) => b[1] - a[1])[0][0];
          expect(argmax, `${name}: ${key} mode must be ${winner}`).toBe(winner);
        }
      }
      expect(published, `${name}: judgment published no distribution`).toBeGreaterThan(0);
      expect(typeof j["model"], `${name}: judgment.model`).toBe("string");
      expect(j["schemaVersion"]).toBe("contexttrail-evidence-v1");
    });
    // Every classified candidate publishes its judgment distribution; a
    // fixture with no candidates is allowed to publish none.
    if (hasCandidates) expect(checked).toBeGreaterThan(0);
    else expect(checked).toBe(0);
  });

  it.each(FIXTURE_FILES)("%s: model identity is pinned and consistent", (name) => {
    const events = readEvents(name);
    const models = new Set<string>();
    const schemas = new Set<string>();
    let judgments = 0;
    walk(events, (node) => {
      if (node["relevance"] === undefined || node["model"] === undefined) return;
      judgments++;
      models.add(String(node["model"]));
      if (node["schemaVersion"] !== undefined) schemas.add(String(node["schemaVersion"]));
      expect(typeof node["relevance"]).toBe("number");
      expect(node["relevance"] as number).toBeGreaterThanOrEqual(0);
      expect(node["relevance"] as number).toBeLessThanOrEqual(1);
      for (const rel of ["contextRelation", "claimRelation", "pageRole", "locationRelation"]) {
        const dist = node[rel];
        if (dist === null || dist === undefined) continue;
        const values = Object.values(dist as Record<string, number>);
        const sum = values.reduce((a, b) => a + b, 0);
        expect(Math.abs(sum - 1), `${name}: ${rel} sums to ${sum}`).toBeLessThan(1e-6);
      }
    });
    if (judgments === 0) return;
    // The EXACT configured pin, not "any jev-* string": a fixture relabelled
    // jev-9.99.0 would otherwise sail through as internally consistent.
    expect([...models], `${name}: models observed: ${[...models].join(", ")}`).toEqual([JEV_MODEL]);
    expect(schemas.size).toBeLessThanOrEqual(1);
  });

  it.each(FIXTURE_FILES)("%s: every judged model is the configured pin, not a lookalike", (name) => {
    const events = readEvents(name);
    const seen = new Set<string>();
    walk(events, (node) => {
      for (const key of ["model", "jevModel", "modelIdentity"]) {
        const v = node[key];
        if (typeof v === "string") seen.add(v);
      }
      const identity = node["identity"] as Json | undefined;
      if (identity && typeof identity === "object") {
        for (const key of ["requested", "reported"]) {
          const v = (identity as Json)[key];
          if (typeof v === "string") seen.add(v);
        }
        if (identity["status"] === "verified" || identity["pinned"] === true) {
          expect(identity["requested"], `${name}: verified identity requested`).toBe(JEV_MODEL);
          expect(identity["reported"], `${name}: verified identity reported`).toBe(JEV_MODEL);
          expect(identity["pinned"], `${name}: verified identity pinned`).toBe(true);
        }
      }
    });
    for (const model of seen) {
      expect(model, `${name}: model ${model} is not the configured pin ${JEV_MODEL}`).toBe(JEV_MODEL);
    }
  });

  it.each(FIXTURE_FILES)(
    "%s: event chronology, ids and types are internally consistent",
    (name) => {
      const events = readEvents(name);
      const discovered = new Set<string>();
      const classified = new Map<string, number>();
      const stagesStarted = new Set<string>();
      const terminalTypes: string[] = [];
      let currentStage: string | null = null;
      let sawStarted = false;

      for (const [i, ev] of events.entries()) {
        const type = String(ev["type"] ?? "");
        const id = str(ev, "id") ?? str((ev["evidence"] ?? null) as Json, "id");
        const at = i;

        if (type === "investigation.started") {
          expect(sawStarted, `${name}: investigation.started appears twice`).toBe(false);
          sawStarted = true;
        }
        if (type === "investigation.completed" || type === "investigation.failed") {
          terminalTypes.push(type);
          expect(
            events.slice(i + 1).length,
            `${name}: ${type} is not the last event`,
          ).toBe(0);
        }
        if (type === "evidence.discovered") {
          const evId = str(ev, "id") ?? str((ev["evidence"] ?? null) as Json, "id");
          expect(evId, `${name}: evidence.discovered #${at} without an id`).toBeTruthy();
          expect(discovered.has(evId as string), `${name}: ${evId} discovered twice`).toBe(false);
          discovered.add(evId as string);
        }
        if (type === "evidence.classified") {
          // `evidence.classified` carries the occurrence id at the top level;
          // `evidence.discovered` nests the candidate under `evidence`.
          const evId = str(ev, "id") ?? str((ev["evidence"] ?? null) as Json, "id");
          expect(evId, `${name}: evidence.classified #${at} without an id`).toBeTruthy();
          // A classification for an id that was never discovered is a phantom.
          expect(
            discovered.has(evId as string),
            `${name}: evidence.classified references ${evId}, never discovered`,
          ).toBe(true);
          // A candidate may legitimately be classified again by REFINED_CLASSIFY
          // after its page text arrives; nothing else may re-classify it.
          const times = classified.get(evId as string) ?? 0;
          if (times > 0) {
            expect(
              currentStage,
              `${name}: ${evId} re-classified during ${String(currentStage)} rather than REFINED_CLASSIFY`,
            ).toBe("REFINED_CLASSIFY");
          }
          classified.set(evId as string, times + 1);
        }
        if (type === "stage.started" || type === "stage.completed") {
          const stage = str(ev, "stage");
          expect(stage, `${name}: ${type} #${at} without a stage`).toBeTruthy();
          if (type === "stage.started") {
            expect(
              stagesStarted.has(stage as string),
              `${name}: stage ${stage} started twice`,
            ).toBe(false);
            stagesStarted.add(stage as string);
            currentStage = stage as string;
          } else {
            // The terminal COMPLETE stage is reported as a completion only; no
            // other stage may complete without having started.
            if (!stagesStarted.has(stage as string)) {
              expect(
                stage,
                `${name}: stage ${stage} completed before it started`,
              ).toBe("COMPLETE");
            }
          }
        }
        expect(id === null || typeof id === "string", `${name}: #${at} id is not a string`).toBe(true);
      }

      expect(sawStarted, `${name}: no investigation.started`).toBe(true);
      expect(terminalTypes, `${name}: exactly one terminal event`).toHaveLength(1);
      expect(terminalTypes[0], `${name}: terminal event is a completion`).toBe(
        "investigation.completed",
      );
      // Every terminal row is an evidence id this stream actually published.
      const result = terminalResult(events);
      const published = new Set([
        ...asArray(result["timeline"]),
        ...asArray(result["supportingEvidence"]),
        ...asArray(result["contextualEvidence"]),
        ...asArray(result["undatedEvidence"]),
      ].map((o) => str(o, "evidenceId") ?? str(o, "occurrenceId")));
      for (const o of [
        ...asArray(result["timeline"]),
        ...asArray(result["supportingEvidence"]),
        ...asArray(result["contextualEvidence"]),
        ...asArray(result["undatedEvidence"]),
      ]) {
        const id = str(o, "evidenceId") ?? str(o, "occurrenceId");
        expect(
          published.has(id as string),
          `${name}: terminal row ${id} is not in the terminal collections`,
        ).toBe(true);
        expect(
          discovered.has(id as string),
          `${name}: terminal row ${id} was never discovered`,
        ).toBe(true);
      }
      // Deliberately NOT asserted: that every announced classification survives
      // into the terminal result, or that every published row was announced.
      // Both directions are observed in practice (candidates are dropped after
      // the deep read, and late candidates are published without an announced
      // classification), so neither is a property this fixture may require. The
      // identity that IS required — in both directions between discovered,
      // classified and published ids — is asserted above.
    },
  );

  it.each(FIXTURE_FILES)("%s: no real hosts and no credential material", (name) => {
    const events = readEvents(name);
    const raw = fs.readFileSync(path.join(OUT, `${name}.ndjson`), "utf8");
    expect(raw).not.toMatch(/api[_-]?key\s*[:=]/i);
    expect(raw).not.toMatch(/\b(sk|pk|key)[-_][A-Za-z0-9]{16,}/);
    expect(raw).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{16,}/);
    expect(raw).not.toMatch(/serpapi\.com\/search/i);
    for (const url of collectUrls(events)) {
      const host = hostOf(url);
      expect(host, `${name}: unparsable url ${url}`).toBeTruthy();
      expect(
        /^(fixture-[a-z0-9-]+\.example\.org|example\.(org|com|net|invalid))$/.test(host as string),
        `${name}: real host in fixture: ${host}`,
      ).toBe(true);
    }
  });

  it.each(FIXTURE_FILES)("%s: retrieved images are distinguishable", (name) => {
    const result = terminalResult(readEvents(name));
    const items = [
      ...asArray(result["timeline"]),
      ...asArray(result["supportingEvidence"]),
      ...asArray(result["contextualEvidence"]),
      ...asArray(result["undatedEvidence"]),
    ];
    // Data URIs count: identical 1×1 pixels render the same wherever they
    // appear, so a duplicate would make attribution unrecoverable.
    const images = items
      .map((i) => str(i, "imageUrl") ?? str(i, "thumbnailUrl"))
      .filter((u): u is string => !!u);
    if (asArray(result["timeline"]).length > 0) expect(images.length).toBeGreaterThan(0);
    expect(new Set(images).size, `${name}: duplicate retrieved image urls`).toBe(images.length);
  });

  it("controlled-pair: a real paired divergence with two live endpoints", () => {
    const result = terminalResult(readEvents("controlled-pair"));
    const timeline = asArray(result["timeline"]);
    const byId = new Map(timeline.map((t) => [str(t, "evidenceId") ?? str(t, "occurrenceId"), t]));
    const div = (result["firstObservedContextDivergence"] ?? null) as Json | null;
    expect(div, "controlled-pair must emit firstObservedContextDivergence").not.toBeNull();
    const fromId = str(div as Json, "fromOccurrenceId") as string;
    const toId = str(div as Json, "toOccurrenceId") as string;
    expect(fromId).toBeTruthy();
    expect(toId).toBeTruthy();
    expect(fromId).not.toBe(toId);
    // Both endpoints are occurrences this investigation actually displayed —
    // a pair pointing at a missing id is not a pair.
    const earlier = byId.get(fromId);
    const later = byId.get(toId);
    expect(earlier, `pair endpoint ${fromId} is not in the timeline`).toBeTruthy();
    expect(later, `pair endpoint ${toId} is not in the timeline`).toBeTruthy();
    expect(
      (str(earlier as Json, "observedAt") as string) < (str(later as Json, "observedAt") as string),
      "the earlier endpoint must be published before the later one",
    ).toBe(true);
    expect(str(div as Json, "observedAt")).toBe(str(later as Json, "observedAt"));
    expect(div?.["earlierTransitionsUnresolved"]).toBe(false);

    // The comparison that established the pair was really performed, and the
    // later endpoint carries the decisive edge.
    const coverage = (result["comparisonCoverage"] ?? null) as Json | null;
    const comparedPairs = strs(coverage?.["comparedPairIds"]);
    expect(comparedPairs).toContain(`${fromId}|${toId}`);
    const decisive = timeline.filter(
      (t) => str((t["incomingConnector"] ?? null) as Json, "kind") === "different_context",
    );
    expect(decisive.map((t) => str(t, "evidenceId")), "exactly one decisive edge").toEqual([toId]);
    expect(str((decisive[0]["incomingConnector"] ?? null) as Json, "fromOccurrenceId")).toBe(fromId);
    expect(later?.["isFirstObservedDivergencePoint"]).toBe(true);
  });

  it("controlled-pair: not-compared and inconclusive stay distinct claims", () => {
    const result = terminalResult(readEvents("controlled-pair"));
    const timeline = asArray(result["timeline"]);
    const comparedPairs = new Set(strs((result["comparisonCoverage"] ?? null as Json)?.["comparedPairIds"]));
    const byId = new Map(
      timeline.map((t) => [str(t, "evidenceId") ?? str(t, "occurrenceId"), t]),
    );
    const kindOf = (t: Json) => str((t["incomingConnector"] ?? null) as Json, "kind");
    const pairOf = (t: Json) => {
      const from = str((t["incomingConnector"] ?? null) as Json, "fromOccurrenceId");
      const id = str(t, "evidenceId") ?? str(t, "occurrenceId");
      return from && id ? `${from}|${id}` : null;
    };

    const unexamined = timeline.filter((t) => kindOf(t) === "unexamined");
    const uncertain = timeline.filter((t) => kindOf(t) === "uncertain");
    expect(unexamined.length, "the fixture must contain a NOT COMPARED edge").toBeGreaterThan(0);
    expect(uncertain.length, "the fixture must contain an INCONCLUSIVE edge").toBeGreaterThan(0);
    // Not compared: the pair was never sent for comparison, so it must not
    // appear in the compared-pair record.
    for (const t of unexamined) {
      expect(comparedPairs.has(pairOf(t) as string), `${pairOf(t)} must not be compared`).toBe(false);
      expect(byId.has(str(t, "evidenceId") ?? "")).toBe(true);
    }
    // Inconclusive: the pair WAS compared and the judgment did not settle it.
    for (const t of uncertain) {
      expect(comparedPairs.has(pairOf(t) as string), `${pairOf(t)} must be compared`).toBe(true);
    }
    // Both edges break the decisive run, so no exact segment count may be
    // claimed — an honest absence, not a zero.
    expect(result["contextSegmentCount"]).toBeNull();
    const kinds = timeline.map(kindOf);
    expect(new Set(kinds)).toEqual(new Set(["start", "different_context", "unexamined", "uncertain"]));
  });

  it("controlled-pair: retrieved images are distinguishable from the submitted input", () => {
    const result = terminalResult(readEvents("controlled-pair"));
    const timeline = asArray(result["timeline"]);
    const images = timeline.map((t) => str(t, "imageUrl") ?? str(t, "thumbnailUrl"));
    for (const [i, uri] of images.entries()) {
      expect(uri, `timeline item ${i} without an image`).toBeTruthy();
      expect(uri, `timeline item ${i} reuses the submitted input image`).not.toContain(
        SUBMITTED_1PX_BASE64,
      );
    }
    // One image per core occurrence, and each one a different solid colour —
    // the rendered <img> can therefore be attributed to a specific occurrence.
    expect(new Set(images).size).toBe(timeline.length);
    expect(timeline.length).toBeGreaterThanOrEqual(4);
  });

  it("the empty-collection fixture is genuinely empty", () => {
    const result = terminalResult(readEvents("controlled-insufficient"));
    expect(str(result, "status")).toBe("INSUFFICIENT_EVIDENCE");
    for (const key of ["timeline", "supportingEvidence", "contextualEvidence", "undatedEvidence"]) {
      expect(asArray(result[key]), `controlled-insufficient must not contain ${key}`).toHaveLength(0);
    }
    expect(result["earliestObservedOccurrence"] ?? null).toBeNull();
    expect(result["sourceDomainCount"]).toBe(0);
    expect(result["reportingGroupCount"]).toBe(0);
    const log = asArray(result["requestLog"]);
    expect(log.length).toBeGreaterThan(0);
    for (const entry of log) expect(entry["retained"]).toBe(0);
  });
});

/* ---------------------------------------------------------------------- *
 * Generator contract — runs on every `vitest run`, no GEN gate needed.
 * ---------------------------------------------------------------------- */

type JevResponse = {
  answers: Record<string, unknown>;
  model: string;
  identity: { requested: string; reported: string; status: string; pinned: boolean };
};

const jevAsk = (
  jev as unknown as { ask: (claim: unknown, qs: Record<string, unknown>) => Promise<JevResponse> }
).ask;

describe("generator contract", () => {
  it("the Jev client reports a truthful, pinned model identity", async () => {
    const res = await jevAsk("controlled claim", {
      relevance: {},
      context_relation: {},
      claim_relation: {},
      page_role: {},
    });
    expect(res.identity.requested).toBe(res.identity.reported);
    expect(res.identity.status).toBe("verified");
    expect(res.identity.pinned).toBe(true);
    expect(res.model).toBe(res.identity.reported);
    expect(res.model).toMatch(/^jev-/);
  });

  it("every published judgment distribution is normalized", () => {
    for (const winners of [
      { context_relation: "DIFFERENT_CONTEXT", claim_relation: "NEUTRAL", page_role: "REPORTING" },
      { context_relation: "SAME_CONTEXT", claim_relation: "SUPPORTS", page_role: "FACT_CHECK" },
    ]) {
      const qs = {
        relevance: {},
        context_relation: {},
        claim_relation: {},
        page_role: {},
        pairwise_context: {},
      } as unknown as Record<string, unknown>;
      const out = answers(qs, winners) as Record<
        string,
        { type: string; noul?: number; choice?: string; probabilities?: Record<string, number> }
      >;
      for (const [key, value] of Object.entries(out)) {
        if (value.type === "noul") {
          expect(typeof value.noul).toBe("number");
          expect(value.noul as number).toBeGreaterThan(0);
          expect(value.noul as number).toBeLessThanOrEqual(1);
          continue;
        }
        const probs = value.probabilities as Record<string, number>;
        const sum = Object.values(probs).reduce((a, b) => a + b, 0);
        expect(Math.abs(sum - 1), `${key} sums to ${sum}`).toBeLessThan(1e-6);
        const top = Math.max(...Object.values(probs));
        expect(probs[value.choice as string], `${key} choice must be the mode`).toBeCloseTo(top, 10);
        expect(Object.keys(probs).sort()).toEqual([...(CHOICE as Record<string, string[]>)[key]].sort());
      }
    }
  });
});
