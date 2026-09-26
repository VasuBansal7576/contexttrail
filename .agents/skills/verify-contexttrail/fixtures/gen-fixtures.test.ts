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
import { createHash } from "node:crypto";
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

/* --------------------------- pixel-level decoding ---------------------------
 *
 * Distinct URLs are not distinct images: two different encodings of the same
 * pixels (a re-encoded PNG, an extra `tEXt` chunk) give different URI strings
 * and different bytes while rendering identically. Attribution and
 * non-substitution can only be proved on the decoded pixels, so the controlled
 * imagery is decoded here rather than compared as text.
 *
 * Scope: 8-bit, non-interlaced, truecolour (type 2) or truecolour+alpha
 * (type 6) — which is exactly what the generator emits. Anything else returns
 * null and is reported as undecodable rather than silently passing.
 */

type Decoded = { width: number; height: number; channels: number; pixels: Buffer };

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function decodePng(buf: Buffer): Decoded | null {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_MAGIC)) return null;
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString("ascii");
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8] as number;
      colorType = body[9] as number;
      interlace = body[12] as number;
    } else if (type === "IDAT") {
      idat.push(Buffer.from(body));
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0) return null;
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  if (channels === 0) return null;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] as number;
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const x = line[i] as number;
      const a = i >= channels ? (cur[i - channels] as number) : 0;
      const b = prev[i] as number;
      const c = i >= channels ? (prev[i - channels] as number) : 0;
      let value = x;
      if (filter === 1) value = x + a;
      else if (filter === 2) value = x + b;
      else if (filter === 3) value = x + Math.floor((a + b) / 2);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      cur[i] = value & 0xff;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { width, height, channels, pixels: out };
}

/** Decode a data-URI/URL image reference, or null when it is not decodable. */
function decodeImageRef(ref: string | null | undefined): Decoded | null {
  if (!ref) return null;
  const m = /^data:image\/png;base64,(.+)$/.exec(ref);
  if (!m) return null;
  return decodePng(Buffer.from(m[1] as string, "base64"));
}

const sha256 = (b: Buffer | string): string =>
  createHash("sha256").update(b).digest("hex");

/** Identity of decoded pixels: dimensions plus a hash of the pixel bytes. */
function pixelIdentity(img: Decoded | null): string | null {
  if (!img) return null;
  return `${img.width}x${img.height}x${img.channels}:${sha256(img.pixels)}`;
}

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

/* ======================================================================== *
 * A8 — current-source state generators.
 *
 * Every state below is produced by driving the REAL runInvestigation
 * orchestrator (from the accepted 9d404cb product authority) with controlled
 * SerpApi / Jev / page-fetch doubles. Nothing writes a terminal status, date,
 * graph, distribution or caveat directly: those are all derived by the
 * product from the returned envelopes. The Jev doubles return the pinned model
 * identity jev-1.13.0 through valid raw envelopes, and `answers()` keeps every
 * choice distribution normalized so the validated contract cannot reject an
 * unnormalized envelope.
 *
 * The knobs that decide each state are product-side, not cosmetic:
 *   - reporting origin comes from NAMED EVIDENCE IN PAGE TEXT
 *     ("the photograph was released by <Outlet>"), which is what promotes a
 *     candidate to separate_origin_evidenced or groups it as shared origin;
 *   - a DISPUTED date comes from two disagreeing PAGE-level date sources;
 *   - an UNKNOWN date comes from having no usable date at all;
 *   - qualifying conflicts / strong support come from the returned pairwise
 *     relation probabilities against STRONG_RELATION_THRESHOLD (0.75);
 *   - selection is capped at MAX_DIVERGENCE_OCCURRENCES (8), and an exact
 *     segment count is only claimed when selection covers the whole run.
 * ======================================================================== */

/** One controlled occurrence. All fields are inputs, never outputs. */
type Occ = {
  /** Human title; also the key the Jev double dispatches on. */
  title: string;
  /** Registered host, which becomes the candidate's registrable domain. */
  host: string;
  /** SerpApi-visible date text. Omit for an unknown date. */
  serpDate?: string;
  /** Page JSON-LD date. Conflicts with pageMeta to produce a DISPUTED date. */
  jsonLd?: string | null;
  /** Page <meta> date. */
  meta?: string | null;
  /** Outlet name credited in the page text; drives reporting origin. */
  credit?: string;
  /** Jev winners for this occurrence, e.g. { claim_relation: "SUPPORTS" }. */
  winners?: Record<string, string>;
  /** Noul relevance. Must clear RELEVANCE_THRESHOLD (0.7) to be relevant. */
  relevance?: number;
  /** Pairwise winners keyed "fromTitle→toTitle". */
  pair?: Record<string, Record<string, string>>;
};

/** The sentence that actually drives origin separation, per the product's
 *  MEDIA_BOUND_PUBLISHER_PATTERN. nameKey("Conflict Alpha") must equal
 *  ownOutletKey("conflict-alpha.example.org"). */
const creditSentence = (outlet: string) =>
  `The photograph was released by ${outlet} during the original reporting effort. `;

const bodyFor = (o: Occ) => {
  const parts: string[] = [];
  if (o.credit) parts.push(creditSentence(o.credit));
  // Long enough (>=400 chars) to be fetched, and distinct enough that article
  // text duplication does not silently merge unrelated outlets.
  parts.push(
    `CONTROLLED FIXTURE body text for ${o.host} describing the reported photograph, ` +
      `its acquisition and the surrounding context of the investigation. `.repeat(6),
  );
  return parts.join(" ");
};

const pageHtml = (url: string, o: Occ) => {
  const ld =
    o.jsonLd != null
      ? `<script type="application/ld+json">${JSON.stringify({
          "@context": "https://schema.org",
          "@type": "NewsArticle",
          headline: "CONTROLLED article",
          datePublished: o.jsonLd,
        })}</script>`
      : "";
  const meta =
    o.meta != null
      ? `<meta property="article:published_time" content="${o.meta}" />`
      : "";
  return `<html><head><title>CONTROLLED page</title>${ld}${meta}</head><body><article><p>${bodyFor(o)}</p></article></body></html>`;
};

/**
 * Controlled SerpApi: lens exact_matches as the core occurrence source.
 *
 * `mirrorOrganicDates` additionally returns the SAME links from
 * organic_results carrying a provider date. That is not decoration: the lens
 * exact-match normalizer records no provider date at all, so a Lens-only
 * investigation can date a candidate only by spending the deep-read page
 * budget, which is capped at MAX_DEEP_READ_PAGES (5). Mirroring the link lets
 * the product's own cross-retrieval date merge supply a date without a page
 * fetch, which is the only way to reach more than five dated core occurrences.
 */
const buildSerpapi = (occs: Occ[], mirrorOrganicDates = false): SearchProvider => ({
  uploadImage: async () => "fixture-upload-id",
  search: async (p: SerpapiParams) => {
    if (p.engine === "google_lens" && p.type === "exact_matches") {
      return {
        search_metadata: { id: "fixture-lens-a8", status: "Success" },
        exact_matches: occs.map((o, i) => ({
          position: i + 1,
          title: o.title,
          link: `https://${o.host}/controlled/${i + 1}`,
          ...(o.serpDate ? { date: o.serpDate } : {}),
          thumbnail: `https://example.invalid/a8-${i + 1}.png`,
        })),
      };
    }
    if (p.engine === "google_lens" && p.type === "about_this_image") {
      return { search_metadata: { id: "fixture-about-a8", status: "Success" }, about_this_image: { sections: [] } };
    }
    if (p.engine === "google_lens") {
      return { search_metadata: { id: "fixture-lens-all-a8", status: "Success" }, visual_matches: [], related_content: [] };
    }
    if (p.engine === "google_news") {
      return { search_metadata: { id: "fixture-news-a8", status: "Success" }, news_results: [] };
    }
    if (mirrorOrganicDates) {
      return {
        search_metadata: { id: "fixture-google-a8", status: "Success" },
        organic_results: occs
          .filter((o) => o.serpDate)
          .map((o, i) => ({
            position: i + 1,
            title: o.title,
            link: `https://${o.host}/controlled/${occs.indexOf(o) + 1}`,
            date: o.serpDate,
          })),
      };
    }
    return { search_metadata: { id: "fixture-google-a8", status: "Success" }, organic_results: [] };
  },
});

/** Controlled Jev double. Model identity is the pinned jev-1.13.0, reported
 *  through a valid returned raw envelope — never asserted by the fixture. */
const buildJev = (occs: Occ[]): JevClient => {
  const byTitle = new Map(occs.map((o) => [o.title, o]));
  // The real pairwise state carries `occurrence_a`/`occurrence_b`; the
  // classify state carries `result`. Dispatch on those exact shapes.
  const pairFor = (s: unknown) => {
    const st = (s ?? {}) as { occurrence_a?: { title?: string }; occurrence_b?: { title?: string } };
    const at = st.occurrence_a?.title ?? "";
    const bt = st.occurrence_b?.title ?? "";
    const key = `${at}→${bt}`;
    return byTitle.get(bt)?.pair?.[key] ?? byTitle.get(at)?.pair?.[key] ?? {};
  };
  const titleFor = (s: unknown) => (s as { result?: { title?: string } } | null | undefined)?.result?.title ?? "";
  const base = {
    ask: async (s: unknown, qs: Record<string, unknown>) => {
      const o = byTitle.get(titleFor(s));
      return {
        answers: answers(qs, { ...pairFor(s), ...(o?.winners ?? {}) }, o?.relevance ?? 0.9),
        model: "jev-1.13.0",
        identity: { requested: "jev-1.13.0", reported: "jev-1.13.0", status: "verified", pinned: true },
      };
    },
  };
  return base as unknown as JevClient;
};

/** Controlled page fetch. Per-host text/dates are the origin and date inputs. */
const buildFetch = (occs: Occ[]) => {
  const byHost = new Map(occs.map((o) => [o.host, o]));
  return async (url: string): Promise<FetchedPage> => {
    const host = new URL(url).hostname;
    const o = byHost.get(host);
    return { url, html: o ? pageHtml(url, o) : `<html><head><title>CONTROLLED page</title></head><body><article><p>${"Controlled unlisted host text. ".repeat(20)}</p></article></body></html>` };
  };
};

/* ---------------------------------------------------------------------- *
 * The nine current-source states.
 *
 * Each is a list of controlled occurrences. The claim string is only set
 * where the state is a claim-mode result; trace-mode states pass null.
 * ---------------------------------------------------------------------- */

const SUPPORTS = { claim_relation: "SUPPORTS" } as const;
const CONTRADICTS = { claim_relation: "CONTRADICTS" } as const;
const SAME = { context_relation: "SAME_CONTEXT" } as const;
const DIFF = { context_relation: "DIFFERENT_CONTEXT" } as const;

/** 1. CONTEXT_CONFLICT — two qualifying conflicts, two registrable domains,
 *  two separately evidenced reporting groups, identity condition met. */
const STATE_CONFLICT: Occ[] = [
  { title: "A8 conflict alpha", host: "conflict-alpha.test", serpDate: "Mar 3, 2019", jsonLd: "2019-03-03", credit: "Conflict Alpha", winners: CONTRADICTS, relevance: 0.95 },
  { title: "A8 conflict beta", host: "conflict-beta.test", serpDate: "Apr 8, 2020", jsonLd: "2020-04-08", credit: "Conflict Beta", winners: CONTRADICTS, relevance: 0.93 },
];

/** 2. NO_CONFLICT_FOUND — zero qualifiers, >=3 relevant core, >=2 domains,
 *  >=2 evidenced groups, >=1 strong support. Always carries the caveat. */
const STATE_NO_CONFLICT: Occ[] = [
  { title: "A8 calm alpha", host: "calm-alpha.test", serpDate: "Jan 4, 2019", jsonLd: "2019-01-04", credit: "Calm Alpha", winners: SUPPORTS, relevance: 0.95 },
  { title: "A8 calm beta", host: "calm-beta.test", serpDate: "Feb 6, 2020", jsonLd: "2020-02-06", credit: "Calm Beta", winners: SUPPORTS, relevance: 0.93 },
  { title: "A8 calm gamma", host: "calm-gamma.test", serpDate: "May 9, 2021", jsonLd: "2021-05-09", credit: "Calm Gamma", winners: SAME, relevance: 0.91 },
];

/** 3. Strong trace — many dated core, all same-context, no divergence. */
const STATE_TRACE_STRONG: Occ[] = [
  { title: "A8 strong one", host: "strong-one.test", serpDate: "2019-01-10", jsonLd: "2019-01-10", credit: "Strong One", winners: SAME, relevance: 0.95 },
  { title: "A8 strong two", host: "strong-two.test", serpDate: "2019-06-11", jsonLd: "2019-06-11", credit: "Strong Two", winners: SAME, relevance: 0.94 },
  { title: "A8 strong three", host: "strong-three.test", serpDate: "2020-03-12", jsonLd: "2020-03-12", credit: "Strong Three", winners: SAME, relevance: 0.93 },
  { title: "A8 strong four", host: "strong-four.test", serpDate: "2021-09-13", jsonLd: "2021-09-13", credit: "Strong Four", winners: SAME, relevance: 0.92 },
];

/** 4. Limited trace — one qualifying conflict whose origin stays unresolved,
 *  so it can never be corroborated into CONTEXT_CONFLICT. */
const STATE_TRACE_LIMITED: Occ[] = [
  { title: "A8 limited kept", host: "limited-kept.test", serpDate: "2019-02-02", jsonLd: "2019-02-02", credit: "Limited Kept", winners: SAME, relevance: 0.95 },
  { title: "A8 limited kept two", host: "limited-kept-two.test", serpDate: "2019-08-02", jsonLd: "2019-08-02", credit: "Limited Kept Two", winners: SAME, relevance: 0.93 },
  { title: "A8 limited orphan", host: "limited-orphan.test", serpDate: "2020-05-02", jsonLd: "2020-05-02", winners: CONTRADICTS, relevance: 0.92 },
];

/** 5. No dated trace — nothing carries a usable date. */
const STATE_TRACE_NO_DATED: Occ[] = [
  { title: "A8 undated one", host: "undated-one.test", winners: SAME, relevance: 0.95 },
  { title: "A8 undated two", host: "undated-two.test", winners: SAME, relevance: 0.93 },
  { title: "A8 undated three", host: "undated-three.test", winners: SAME, relevance: 0.91 },
];

/** 6. Divergent trace — a genuine later verified divergence on a
 *  separately evidenced origin. */
const STATE_TRACE_DIVERGENT: Occ[] = [
  { title: "A8 diverge one", host: "diverge-one.test", serpDate: "2019-03-01", jsonLd: "2019-03-01", credit: "Diverge One", winners: SAME, relevance: 0.95,
    pair: { "A8 diverge one→A8 diverge two": { pairwise_context: "SAME_CONTEXT" } } },
  { title: "A8 diverge two", host: "diverge-two.test", serpDate: "2019-09-01", jsonLd: "2019-09-01", credit: "Diverge Two", winners: SAME, relevance: 0.94,
    pair: { "A8 diverge two→A8 diverge three": { pairwise_context: "DIFFERENT_CONTEXT" } } },
  { title: "A8 diverge three", host: "diverge-three.test", serpDate: "2020-04-01", jsonLd: "2020-04-01", credit: "Diverge Three", winners: SAME, relevance: 0.93 },
];

/** 7. Disputed vs unknown placement — one occurrence has two disagreeing
 *  PAGE date sources (disputed), the others have no date at all (unknown). */
const STATE_PLACEMENT: Occ[] = [
  { title: "A8 placed dated", host: "placed-dated.test", serpDate: "2019-04-04", jsonLd: "2019-04-04", credit: "Placed Dated", winners: SAME, relevance: 0.95 },
  { title: "A8 placed disputed", host: "placed-disputed.test", jsonLd: "2019-04-04", meta: "2021-11-11", winners: SAME, relevance: 0.93 },
  { title: "A8 placed unknown", host: "placed-unknown.test", winners: SAME, relevance: 0.91 },
];

/** 8. The REACHABLE dated-core ceiling.
 *
 *  The original state list asked for "more than eight dated core occurrences
 *  with at most eight selected". That condition is NOT reachable at 9d404cb,
 *  and this fixture deliberately encodes the ceiling that IS reachable rather
 *  than faking an unreachable one:
 *
 *   - core occurrences (EXACT_MATCH / NEAR_MATCH) arise only from a validated
 *     lens exact collection; contextual web/news/about-image surfaces are
 *     explicitly given `mediaRelationship: null` (normalize.ts);
 *   - `normalizeExactMatchesResponse` returns an EMPTY `dateTexts`, so the
 *     provider date on an exact match is dropped;
 *   - the only remaining date source is a fetched page, and deep reads are
 *     capped at MAX_DEEP_READ_PAGES (5).
 *
 *  So at most 5 dated core occurrences can exist, which makes
 *  MAX_DIVERGENCE_OCCURRENCES (8) structurally unreachable, selection is never
 *  truncated, and `comparison_coverage_incomplete` can never be emitted by a
 *  real investigation. See the structural ceiling check below, and the API-owner
 *  routing note in the handover. No product source was changed to work around it. */
const ORDINAL_WORDS = ["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven"];

const STATE_OVER_EIGHT: Occ[] = ORDINAL_WORDS.map((word, i) => {
  const day = `${2018 + Math.floor(i / 4)}-${String((i % 4) + 1).padStart(2, "0")}-15`;
  return {
    title: `A8 many ${word}`,
    // Alphabetic host label: the outlet-credit pattern cannot capture a digit,
    // so "many-01" would collapse every outlet into one shared group.
    host: `many-${word.toLowerCase()}.test`,
    serpDate: day,
    // Trace mode runs no text-search engine, so the provider date is never
    // read; a fetched page is the only date source. Eleven occurrences against
    // a five-page budget is what makes the ceiling observable.
    jsonLd: day,
    credit: `Many ${word}`,
    winners: SAME,
    relevance: 0.95 - i * 0.01,
  };
});

/** 9. An uncertain earlier transition (imprecise window overlapping the next
 *  occurrence) preceding a later verified divergence. */
const STATE_UNCERTAIN_TRANSITION: Occ[] = [
  { title: "A8 uncertain early", host: "uncertain-early.test", serpDate: "2019-05-01", jsonLd: "2019-05-01", credit: "Uncertain Early", winners: SAME, relevance: 0.95,
    pair: { "A8 uncertain early→A8 later verified": { pairwise_context: "SAME_CONTEXT" } } },
  { title: "A8 later verified", host: "later-verified.test", serpDate: "2019-05-01", jsonLd: "2019-05-01", credit: "Later Verified", winners: SAME, relevance: 0.94,
    pair: { "A8 later verified→A8 final verified": { pairwise_context: "DIFFERENT_CONTEXT" } } },
  { title: "A8 final verified", host: "final-verified.test", serpDate: "2020-07-07", jsonLd: "2020-07-07", credit: "Final Verified", winners: SAME, relevance: 0.93 },
];

/**
 * Per-fixture expected distribution modes. A single global triple could only
 * describe fixtures that all share one neutral default, so it silently
 * forbade any state that deliberately asserts supports / contradicts /
 * same-context. Each state now declares the mode it is actually driving, which
 * asserts real semantics instead of one blanket value.
 */
const LEGACY_ARGMAX: Record<string, string | undefined> = {
  contextRelation: "differentContext",
  pageRole: "reporting",
  claimRelation: "neutral",
};
const EXPECTED_ARGMAX_BY_FIXTURE: Record<string, Record<string, string | undefined>> = {};
const argmaxFor = (name: string) => EXPECTED_ARGMAX_BY_FIXTURE[name] ?? LEGACY_ARGMAX;

/**
 * The distribution mode each state actually drives, asserted per fixture. These
 * are the semantic outputs under test, not snapshots.
 */
const A8_ARGMAX: Record<string, Record<string, string>> = {
  "controlled-conflict": { contextRelation: "sameContext", claimRelation: "contradicts" },
  "controlled-no-conflict": { contextRelation: "sameContext", claimRelation: "supports" },
  "controlled-trace-strong": { contextRelation: "sameContext", claimRelation: "neutral" },
  "controlled-trace-limited": { contextRelation: "sameContext", claimRelation: "neutral" },
  "controlled-trace-no-dated": { contextRelation: "sameContext", claimRelation: "neutral" },
  "controlled-trace-divergent": { contextRelation: "sameContext", claimRelation: "neutral" },
  "controlled-placement-disputed-vs-unknown": { contextRelation: "sameContext", claimRelation: "neutral" },
  "controlled-trace-dated-core-ceiling": { contextRelation: "sameContext", claimRelation: "neutral" },
  "controlled-trace-uncertain-transition": { contextRelation: "sameContext", claimRelation: "neutral" },
};
for (const [n, m] of Object.entries(A8_ARGMAX)) EXPECTED_ARGMAX_BY_FIXTURE[n] = m;

/** name → { claim, occurrences }. The claim is null for trace-mode states. */
const A8_STATES: Array<[string, string | null, Occ[], boolean?]> = [
  ["controlled-conflict", "A controlled claim used to drive a corroborated context conflict.", STATE_CONFLICT],
  ["controlled-no-conflict", "A controlled claim used to drive a corroborated no-conflict result.", STATE_NO_CONFLICT],
  ["controlled-trace-strong", null, STATE_TRACE_STRONG],
  ["controlled-trace-limited", null, STATE_TRACE_LIMITED],
  ["controlled-trace-no-dated", null, STATE_TRACE_NO_DATED],
  ["controlled-trace-divergent", null, STATE_TRACE_DIVERGENT],
  ["controlled-placement-disputed-vs-unknown", null, STATE_PLACEMENT],
  ["controlled-trace-dated-core-ceiling", null, STATE_OVER_EIGHT],
  ["controlled-trace-uncertain-transition", null, STATE_UNCERTAIN_TRANSITION],
];

describe.skipIf(!GEN)("controlled fixture generation", () => {
  it.each([
    ["controlled-trace", null, serpapi, jev],
    ["controlled-claim", "This controlled claim describes a fictional event today.", serpapi, jev],
    ["controlled-viewer", "This controlled claim describes a fictional event today.", serpapiViewer, jev],
    ["controlled-insufficient", "This controlled claim describes a fictional event today.", serpapiEmpty, jev],
    ["controlled-pair", "This controlled claim describes a fictional event today.", serpapiPair, jevPair],
    ...A8_STATES.map(
      ([name, claim, occs, mirrorDates]) =>
        [name, claim, buildSerpapi(occs, mirrorDates === true), buildJev(occs), buildFetch(occs)] as const,
    ),
  ])("writes %s.ndjson", async (name, claim, provider, jevClient, pageFetchOverride) => {
    const events: unknown[] = [];
    await runInvestigation(
      { media: new Uint8Array([1, 2, 3]), claim, timezone: "UTC", locale: "en" },
      (e) => events.push(e),
      { serpapi: provider, jev: jevClient, fetchPage: pageFetchOverride ?? fetchPage },
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
  // A8: a corroborated conflict and a corroborated no-conflict, each driven
  // into its terminal status by the real policy gates rather than asserted.
  "controlled-conflict",
  "controlled-no-conflict",
]);
const TRACE_FIXTURES = new Set([
  "controlled-trace",
  // A8 trace states.
  "controlled-trace-strong",
  "controlled-trace-limited",
  "controlled-trace-no-dated",
  "controlled-trace-divergent",
  "controlled-placement-disputed-vs-unknown",
  "controlled-trace-dated-core-ceiling",
  "controlled-trace-uncertain-transition",
]);
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
/**
 * Fixture hosts must be non-resolving. The original allowlist only accepted
 * `fixture-*.example.org` and `example.*`, which pins every occurrence to the
 * single registrable domain `example.org` — and a single registrable domain
 * makes the corroborating-domain gate, and self-bound outlet credits,
 * unreachable, so CONTEXT_CONFLICT and NO_CONFLICT_FOUND could never be
 * driven. The IANA-reserved names below are the RFC 2606 / RFC 6761 set whose
 * entire purpose is "never resolves", which is what this check is protecting.
 * A real host is still rejected; see the reserved-host control below.
 */
const RESERVED_TLDS = ["test", "invalid", "example", "localhost"];
const isFixtureHost = (host: string): boolean =>
  /^(fixture-[a-z0-9-]+\.example\.org|example\.(org|com|net|invalid))$/.test(host) ||
  new RegExp(`^[a-z0-9-]+\\.(${RESERVED_TLDS.join("|")})$`).test(host);

const LIMITATION_CODES = new Set([
  "exact_match_retrieval_unavailable",
  "about_this_image_unavailable",
  "insufficient_dated_occurrences",
  "near_match_verifier_disabled",
  "reporting_origins_unresolved",
  "unknown_dates_present",
  "unverified_visual_leads_present",
  "web_context_unavailable",
  "semantic_classification_unavailable",
  // Codes the product actually emits that the original set never listed. Kept
  // honest by `limitation codes cover the product union` below, which reads the
  // product's declared union and fails if the two ever drift apart again.
  "no_exact_occurrences_returned",
  "news_unavailable",
  "semantic_classification_partial",
  "page_fetch_partial_failure",
  "analysis_time_limit_reached",
  "comparison_coverage_incomplete",
  "claim_date_unresolved",
  "disputed_dates_present",
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
    // "Has candidates" must come from the discovered evidence, NOT from the
    // timeline. A trace whose occurrences are all undated has an empty
    // timeline and still publishes a judgment for every candidate; keying this
    // off the timeline wrongly demanded that such a fixture publish none.
    const hasCandidates = events.some((e) => str(e, "type") === "evidence.discovered");
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
        const winner = argmaxFor(name)[key];
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

  it("limitation codes cover the product union, so the allowlist cannot go stale", () => {
    // Reads the product's own declared union. If the product gains a code and
    // the fixture allowlist does not, this fails — which is exactly the drift
    // that let real codes (claim_date_unresolved, disputed_dates_present) reach
    // a fixture unnoticed.
    const src = fs.readFileSync(
      path.resolve(OUT, "../../../../src/lib/investigation/contracts/investigation.ts"),
      "utf8",
    );
    const unionOf = (typeName: string): string[] => {
      const at = src.indexOf(`export type ${typeName}`);
      expect(at, `product contract must declare ${typeName}`).toBeGreaterThan(-1);
      return [...src.slice(at, src.indexOf(";", at)).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    };
    const limitationUnion = unionOf("LimitationCode");
    const takeawayUnion = unionOf("TakeawayCode");
    expect(limitationUnion.length).toBeGreaterThan(10);
    for (const code of limitationUnion) {
      expect(LIMITATION_CODES.has(code), `limitation code missing from allowlist: ${code}`).toBe(true);
    }
    for (const code of LIMITATION_CODES) {
      expect(limitationUnion, `limitation allowlist lists a code the product no longer declares: ${code}`).toContain(code);
    }
    for (const code of takeawayUnion) {
      expect(TAKEAWAY_CODES.has(code), `takeaway code missing from allowlist: ${code}`).toBe(true);
    }
    for (const code of TAKEAWAY_CODES) {
      expect(takeawayUnion, `takeaway allowlist lists a code the product no longer declares: ${code}`).toContain(code);
    }
  });

  it("the reserved-host allowlist still rejects real hosts", () => {
    // Meaningful opposing control: widening the allowlist for RFC 2606 names
    // must not have weakened the original intent.
    for (const bad of [
      "reuters.com",
      "www.bbc.co.uk",
      "news.bbc.co.uk",
      "contexttrail.ai",
      "fixture-news-a.example.org.attacker.net",
      "conflict-alpha.test.evil.com",
    ]) {
      expect(isFixtureHost(bad), `real host must be rejected: ${bad}`).toBe(false);
    }
    for (const good of [
      "fixture-news-a.example.org",
      "example.invalid",
      "conflict-alpha.test",
      "calm-beta.invalid",
      "many-one.test",
    ]) {
      expect(isFixtureHost(good), `reserved host must be accepted: ${good}`).toBe(true);
    }
  });

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
        isFixtureHost(host as string),
        `${name}: real host in fixture: ${host}`,
      ).toBe(true);
    }
  });

  it.each(FIXTURE_FILES)("%s: loaded imagery is distinguishable by DECODED pixels", (name) => {
    const result = terminalResult(readEvents(name));
    const items = [
      ...asArray(result["timeline"]),
      ...asArray(result["supportingEvidence"]),
      ...asArray(result["contextualEvidence"]),
      ...asArray(result["undatedEvidence"]),
    ];
    const refs = items
      .map((i) => str(i, "imageUrl") ?? str(i, "thumbnailUrl"))
      .filter((u): u is string => !!u);
    const dataRefs = refs.filter((u) => u.startsWith("data:image/png;base64,"));
    if (dataRefs.length === 0) return; // nothing decodable to compare in this fixture

    // Every controlled PNG must decode, and the decoded PIXELS — not the URI
    // text and not the encoded bytes — must be unique. A second encoding of the
    // same pixels has a different URL and different bytes but one identity.
    const identities = dataRefs.map((ref) => {
      const img = decodeImageRef(ref);
      expect(img, `${name}: controlled image does not decode`).not.toBeNull();
      return pixelIdentity(img) as string;
    });
    const dupes = identities.filter((id, i) => identities.indexOf(id) !== i);
    expect(dupes, `${name}: identical decoded pixels across occurrences: ${[...new Set(dupes)].join(", ")}`).toEqual([]);

    // Dimensions must be real, not a decoded header of nothing.
    for (const [i, ref] of dataRefs.entries()) {
      const img = decodeImageRef(ref) as Decoded;
      expect(img.width, `${name}: image ${i} width`).toBeGreaterThan(0);
      expect(img.height, `${name}: image ${i} height`).toBeGreaterThan(0);
      expect(img.pixels.length, `${name}: image ${i} pixel buffer`).toBe(img.width * img.height * img.channels);
    }

    // Non-substitution at the pixel level: no controlled image may render the
    // harness's submitted 1×1 transparent PNG.
    const submitted = decodeImageRef(`data:image/png;base64,${SUBMITTED_1PX_BASE64}`);
    const submittedId = pixelIdentity(submitted);
    for (const id of identities) {
      expect(id, `${name}: a controlled image renders the submitted input pixels`).not.toBe(submittedId);
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

/* ======================================================================== *
 * A8 — semantic state assertions.
 *
 * These assert the product's ACTUAL derived semantics per state — terminal
 * status, support ids, origin separation, nulls, coverage, limitations and
 * date precision — rather than snapshotting whole results. Every expectation
 * here is about a value the orchestrator computed, never one a fixture wrote.
 * ======================================================================== */

describe("A8 current-source state semantics", () => {
  const result = (name: string) => terminalResult(readEvents(name));
  const all = (r: Record<string, unknown>, k: string) => asArray(r[k]) as Record<string, unknown>[];
  const items = (r: Record<string, unknown>) => [
    ...all(r, "timeline"), ...all(r, "undatedEvidence"),
    ...all(r, "supportingEvidence"), ...all(r, "contextualEvidence"),
  ];

  it("CONTEXT_CONFLICT: two qualifiers, two domains, two evidenced groups", () => {
    const r = result("controlled-conflict");
    expect(str(r, "status")).toBe("CONTEXT_CONFLICT");
    expect(str(r, "mode")).toBe("claim_check");
    // The corroborating-pair gate is what upgrades POSSIBLE -> CONTEXT.
    const gates = all(r, "policyReasons");
    const pair = gates.find((g) => str(g, "gate") === "corroborating_pair");
    expect(pair?.["passed"], "the corroborating-pair gate must be the one that fired").toBe(true);
    const ids = strs(pair?.["supportIds"]);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    const qg = gates.find((g) => str(g, "gate") === "qualifying_conflicts");
    expect(strs(qg?.["supportIds"]).length).toBeGreaterThanOrEqual(2);
    const cited = items(r).filter((x) => ids.includes(str(x, "evidenceId") as string));
    expect(new Set(cited.map((x) => str(x, "registrableDomain"))).size).toBeGreaterThanOrEqual(2);
    // Origin separation: the corroboration requires SEPARATELY EVIDENCED
    // origins, not merely distinct domains.
    for (const c of cited) {
      expect(str(c, "reportingOriginStatus"), `origin of ${str(c, "evidenceId")}`).toBe("separate_origin_evidenced");
    }
    expect(new Set(cited.map((x) => str(x, "reportingOriginGroupId"))).size).toBeGreaterThanOrEqual(2);
    expect(r["unresolvedOriginCount"]).toBe(0);
  });

  it("NO_CONFLICT_FOUND: every gate passes and the caveat is carried", () => {
    const r = result("controlled-no-conflict");
    expect(str(r, "status")).toBe("NO_CONFLICT_FOUND");
    // The mandatory caveat: this status must never read as proof.
    expect(r["doesNotProveClaimTrue"]).toBe(true);
    expect(strs(r["statusBasis"]).length).toBeGreaterThan(0);
    // Every gate NO_CONFLICT_FOUND requires must actually be present and pass.
    // The qualifying_conflicts gate is deliberately the one that does NOT pass:
    // this status is only reachable with zero qualifiers.
    const gates = all(r, "policyReasons");
    const byGate = new Map(gates.map((g) => [str(g, "gate") as string, g]));
    expect(byGate.get("qualifying_conflicts")?.["passed"]).toBe(false);
    expect(strs(byGate.get("qualifying_conflicts")?.["supportIds"]).length).toBe(0);
    for (const g of ["relevant_core_coverage", "distinct_domains", "distinct_reporting_groups", "corroborating_pair", "strong_support"]) {
      expect(byGate.get(g), `missing gate ${g}`).toBeTruthy();
      expect(byGate.get(g)!["passed"], `gate ${g} must pass`).toBe(true);
    }
    expect(r["reportingGroupCount"]).toBeGreaterThanOrEqual(2);
    expect(r["unresolvedOriginCount"]).toBe(0);
    expect((r["sourceDomainCount"] as number) ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("NO_CONFLICT_FOUND caveat is load-bearing, not decorative", () => {
    // Opposing control: remove the caveat from the fixture and the contract
    // predicate must fail. Without this the caveat assertion could be a green
    // that no fixture change would ever turn red.
    const r = { ...result("controlled-no-conflict"), doesNotProveClaimTrue: false };
    expect(str(r, "status")).toBe("NO_CONFLICT_FOUND");
    expect(r["doesNotProveClaimTrue"], "caveat removed: the gate must notice").not.toBe(true);
  });

  it("strong trace: dated core across separate origins, one coherent segment", () => {
    const r = result("controlled-trace-strong");
    const tl = all(r, "timeline");
    expect(tl.length).toBeGreaterThanOrEqual(3);
    expect(r["contextSegmentCount"]).toBe(1);
    expect(r["firstObservedContextDivergence"]).toBeFalsy();
    expect(new Set(tl.map((x) => str(x, "reportingOriginGroupId"))).size).toBe(tl.length);
    for (const x of tl) expect(str(x, "dateStatus")).toBe("usable");
  });

  it("limited trace: an unresolved origin is reported, never silently promoted", () => {
    const r = result("controlled-trace-limited");
    expect((r["unresolvedOriginCount"] as number) ?? 0).toBeGreaterThanOrEqual(1);
    expect(strs(r["limitations"])).toContain("reporting_origins_unresolved");
    // An unresolved origin must not be counted as an evidenced group.
    const unres = items(r).filter((x) => str(x, "reportingOriginStatus") === "unresolved");
    expect(unres.length).toBeGreaterThanOrEqual(1);
    // An unresolved origin must not be dressed up as an evidenced group.
    for (const x of unres) {
      expect(String(str(x, "reportingOriginGroupId") ?? ""), "unresolved origin must not claim a group").toBe("");
    }
    const evidenced = items(r).filter((x) => str(x, "reportingOriginStatus") === "separate_origin_evidenced");
    expect(evidenced.length).toBeGreaterThanOrEqual(2);
  });

  it("no-dated trace: nothing enters the dated timeline and the count is withheld", () => {
    const r = result("controlled-trace-no-dated");
    expect(all(r, "timeline").length).toBe(0);
    expect(all(r, "undatedEvidence").length).toBeGreaterThanOrEqual(3);
    // No dated run cannot claim an exact segment count.
    expect(r["contextSegmentCount"]).toBeNull();
    expect(strs(r["limitations"])).toContain("unknown_dates_present");
    for (const x of all(r, "undatedEvidence")) {
      expect(str(x, "publishedAt")).toBeNull();
      expect(str(x, "dateStatus")).toBe("unknown");
    }
  });

  it("divergent trace: a real later divergence with decisive support ids", () => {
    const r = result("controlled-trace-divergent");
    const d = r["firstObservedContextDivergence"] as Record<string, unknown> | null;
    expect(d, "a verified divergence must exist").toBeTruthy();
    const from = str(d!, "fromOccurrenceId");
    const to = str(d!, "toOccurrenceId");
    const shipped = new Set(items(r).map((x) => str(x, "evidenceId")));
    expect(shipped.has(from as string), "divergence source must be a shipped occurrence").toBe(true);
    expect(shipped.has(to as string), "divergence target must be a shipped occurrence").toBe(true);
    // The edge must be ordered and the later occurrence must actually be later.
    const byId = new Map(items(r).map((x) => [str(x, "evidenceId") as string, x]));
    expect(String(str(byId.get(to as string)!, "observedAt")) > String(str(byId.get(from as string)!, "observedAt"))).toBe(true);
    expect((r["contextSegmentCount"] as number) ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("placement: a disputed date and an unknown date are distinguished, not merged", () => {
    const r = result("controlled-placement-disputed-vs-unknown");
    const und = all(r, "undatedEvidence");
    const byStatus = new Map(und.map((x) => [str(x, "dateStatus") as string, x]));
    expect(byStatus.has("disputed"), "a disputed date must be present and kept").toBe(true);
    expect(byStatus.has("unknown"), "an unknown date must be present and kept").toBe(true);
    // Disputed is a real, recorded outcome: a null value AND a retained
    // rejected-candidate ledger. It must never be silently filled in.
    const disputed = byStatus.get("disputed")!;
    expect(str(disputed, "publishedAt")).toBeNull();
    expect(asArray((disputed["dateProvenance"] as Record<string, unknown>)?.["rejectedCandidates"]).length)
      .toBeGreaterThan(0);
    // Neither may enter the dated timeline.
    expect(all(r, "timeline").some((x) => str(x, "dateStatus") === "disputed")).toBe(false);
    expect(strs(r["limitations"])).toContain("disputed_dates_present");
  });

  it("dated-core ceiling: the reachable maximum, with the shortfall recorded", () => {
    const r = result("controlled-trace-dated-core-ceiling");
    const tl = all(r, "timeline");
    const cc = r["comparisonCoverage"] as Record<string, unknown>;
    // The ceiling is the deep-read page budget, not the selection cap.
    expect(tl.length).toBe(5);
    expect((cc["displayedDatedCore"] as number)).toBe(tl.length);
    // Because the ceiling is below the cap, selection is never truncated and
    // coverage is complete — which is precisely why the >8 state is
    // unreachable, and why this fixture records that instead of faking it.
    expect((cc["selected"] as number)).toBe((cc["eligible"] as number));
    expect(r["contextSegmentCount"]).not.toBeNull();
    expect(strs(r["limitations"])).not.toContain("comparison_coverage_incomplete");
  });

  it("the >8 dated-core state is structurally unreachable at this pin", () => {
    // Pins WHY, so the ceiling fixture cannot be mistaken for a passing
    // >8 state and the gap cannot be quietly forgotten.
    const lim = fs.readFileSync(path.resolve(OUT, "../../../../src/lib/investigation/limits.ts"), "utf8");
    const deep = Number(/MAX_DEEP_READ_PAGES\s*=\s*(\d+)/.exec(lim)?.[1]);
    const sel = Number(/MAX_DIVERGENCE_OCCURRENCES\s*=\s*(\d+)/.exec(lim)?.[1]);
    expect(deep).toBeGreaterThan(0);
    expect(sel).toBeGreaterThan(0);
    // The selection cap cannot be reached, because the only dateable core
    // surface is bounded by the deep-read budget.
    expect(deep, `deep-read budget ${deep} must stay below the selection cap ${sel} for this ceiling to hold`).toBeLessThan(sel);
    // And the exact-match normalizer must still be dropping its provider date.
    const norm = fs.readFileSync(path.resolve(OUT, "../../../../src/lib/serpapi/normalize.ts"), "utf8");
    const at = norm.indexOf("export function normalizeExactMatchesResponse");
    const exact = norm.slice(at, norm.indexOf("export function", at + 10));
    expect(exact, "the exact-match normalizer must still drop its provider date").toContain("dateTexts: new Map()");
  });

  it("uncertain earlier transition: an unorderable pair blocks an ordered edge", () => {
    const r = result("controlled-trace-uncertain-transition");
    const d = r["firstObservedContextDivergence"] as Record<string, unknown> | null;
    // The equal-date pair before the verified divergence cannot manufacture an
    // ordered transition, so no exact segment count may be claimed overall.
    expect(r["contextSegmentCount"]).toBeNull();
    // The later verified divergence is still recorded, with shipped ids.
    expect(d, "the later verified divergence must survive").toBeTruthy();
    const shipped = new Set(items(r).map((x) => str(x, "evidenceId")));
    expect(shipped.has(str(d!, "fromOccurrenceId") as string)).toBe(true);
    expect(shipped.has(str(d!, "toOccurrenceId") as string)).toBe(true);
    // The unorderable adjacent pair is reported as unexamined, not as a
    // decided transition.
    const comps = all(r, "comparisons");
    expect(comps.some((c) => str(c, "connector") === "unexamined")).toBe(true);
  });

  it("model identity is the pinned jev-1.13.0 through valid returned envelopes", () => {
    for (const [name] of A8_STATES) {
      const r = result(name);
      const judged = items(r).filter((x) => str(x, "jevModel") !== null);
      expect(judged.length, `${name}: some occurrence must carry a judgment`).toBeGreaterThan(0);
      for (const x of judged) expect(str(x, "jevModel")).toBe("jev-1.13.0");
      // A real final status is required for the claim states, and is derived.
      if (CLAIM_FIXTURES.has(name)) expect(str(r, "status")).not.toBeNull();
      else expect(str(r, "status")).toBeNull();
    }
  });
});
