/**
 * Readable page extraction and deterministic excerpt construction
 * (spec §18.2, §18.3, §19.2). Fetched HTML is parsed with jsdom +
 * @mozilla/readability; page text is treated strictly as data (§30).
 */

import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { EXCERPT_MAX_CHARS } from "../investigation/limits";

export interface PageExtraction {
  title: string | null;
  /** Main readable text content; null when extraction fails. */
  text: string | null;
  /** Paragraphs of the readable text, for excerpt composition. */
  paragraphs: string[];
  /** datePublished-ish values from JSON-LD blocks. */
  jsonLdDates: string[];
  /** article:published_time / equivalent meta values. */
  metaDates: string[];
  /** Explicit <time datetime> values. */
  timeDates: string[];
}

/**
 * Entity-bound JSON-LD publication dates (§19.2). A publication date must
 * come from the entity being published — an article/posting node — never
 * from an arbitrary nested container such as a wrapping WebPage's
 * dateCreated or a BreadcrumbList. When no article-bound date exists, a
 * root-level node's explicit `datePublished` is the only fallback;
 * container `dateCreated`/`datePosted` never stand in for publication.
 */
const JSONLD_DATE_KEYS = ["datePublished", "dateCreated", "datePosted"] as const;

function isPublicationEntity(node: Record<string, unknown>): boolean {
  const t = node["@type"];
  const types = Array.isArray(t) ? t : [t];
  return types.some(
    (x) => typeof x === "string" && /(article|posting|report)/i.test(x),
  );
}

function directDateFields(node: Record<string, unknown>, out: string[]): void {
  for (const key of JSONLD_DATE_KEYS) {
    const v = node[key];
    if (typeof v === "string" && v.trim() !== "") out.push(v.trim());
  }
}

function collectEntityDates(node: unknown, out: string[]): void {
  if (typeof node !== "object" || node === null) return;
  if (Array.isArray(node)) {
    for (const n of node) collectEntityDates(n, out);
    return;
  }
  const o = node as Record<string, unknown>;
  if (isPublicationEntity(o)) directDateFields(o, out);
  for (const v of Object.values(o)) collectEntityDates(v, out);
}

function rootPublicationDate(node: unknown, out: string[]): void {
  const roots = Array.isArray(node) ? node : [node];
  for (const r of roots) {
    if (typeof r !== "object" || r === null) continue;
    const v = (r as Record<string, unknown>).datePublished;
    if (typeof v === "string" && v.trim() !== "") out.push(v.trim());
  }
}

const META_DATE_KEYS = new Set([
  "article:published_time",
  "og:published_time",
  "datepublished",
  "date",
  "dc.date",
  "dc.date.issued",
  "parsely-pub-date",
  "sailthru.date",
  "publish-date",
  "pubdate",
]);

export function extractPage(html: string): PageExtraction {
  const dom = new JSDOM(html, { contentType: "text/html" });
  const doc = dom.window.document;

  const parsedLd: unknown[] = [];
  for (const el of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      parsedLd.push(JSON.parse(el.textContent ?? ""));
    } catch {
      // malformed JSON-LD is skipped, not fatal
    }
  }
  const jsonLdDates: string[] = [];
  for (const p of parsedLd) collectEntityDates(p, jsonLdDates);
  if (jsonLdDates.length === 0) {
    for (const p of parsedLd) rootPublicationDate(p, jsonLdDates);
  }

  const metaDates: string[] = [];
  for (const el of doc.querySelectorAll("meta")) {
    const key = (
      el.getAttribute("property") ??
      el.getAttribute("name") ??
      ""
    ).toLowerCase();
    if (META_DATE_KEYS.has(key)) {
      const content = el.getAttribute("content");
      if (content !== null && content.trim() !== "") metaDates.push(content.trim());
    }
  }

  const timeDates: string[] = [];
  for (const el of doc.querySelectorAll("time[datetime]")) {
    const dt = el.getAttribute("datetime");
    if (dt !== null && dt.trim() !== "") timeDates.push(dt.trim());
  }

  let title: string | null = null;
  let text: string | null = null;
  try {
    const article = new Readability(doc.cloneNode(true) as Document).parse();
    if (article !== null) {
      title = typeof article.title === "string" && article.title.trim() !== "" ? article.title.trim() : null;
      text = typeof article.textContent === "string" && article.textContent.trim() !== "" ? article.textContent : null;
    }
  } catch {
    // Readability failure is non-fatal; metadata still usable.
  }
  title ??= doc.title?.trim() || null;

  const paragraphs = (text ?? "")
    .split(/\n{2,}|\r?\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length >= 40);

  return { title, text, paragraphs, jsonLdDates, metaDates, timeDates };
}

/* ---------------- deterministic excerpt builder (§18.3) ---------------- */

const STOP_WORDS = new Set(
  "a an and are as at be been but by for from has have he her his i in is it its of on or she that the their they this to was we were will with you your".split(
    " ",
  ),
);

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOP_WORDS.has(t)),
  );
}

/**
 * Compose an excerpt: title, SERP snippet, first two useful paragraphs, then
 * the highest-overlap paragraphs against claim/title tokens. Deterministic;
 * no generative summarizer; hard cap EXCERPT_MAX_CHARS.
 */
export function buildExcerpt(input: {
  title: string | null;
  snippet: string | null;
  paragraphs: string[];
  claim: string | null;
}): string | null {
  const parts: string[] = [];
  const query = tokens(`${input.title ?? ""} ${input.claim ?? ""}`);

  if (input.title) parts.push(`Title: ${input.title}`);
  if (input.snippet) parts.push(`Snippet: ${input.snippet}`);

  const paras = input.paragraphs.filter((p) => p.length > 0);
  const first = paras.slice(0, 2);
  const rest = paras
    .slice(2)
    .map((p, i) => {
      const pt = tokens(p);
      let overlap = 0;
      for (const t of pt) if (query.has(t)) overlap += 1;
      return { p, overlap, i };
    })
    .sort((a, b) => b.overlap - a.overlap || a.i - b.i)
    .filter((r) => r.overlap > 0)
    .map((r) => r.p);

  for (const p of [...first, ...rest]) {
    parts.push(p);
  }
  if (parts.length === 0) return null;
  const joined = parts.join("\n\n");
  return joined.length > EXCERPT_MAX_CHARS
    ? joined.slice(0, EXCERPT_MAX_CHARS)
    : joined;
}

/* ------------- normalized text shingles for duplication checks --------- */

/**
 * Word 5-gram shingle set for article-text duplication screening (§13).
 * Normalized aggressively: lowercase, punctuation stripped, digits kept.
 */
export function textShingles(text: string, n = 5): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) {
    out.add(words.slice(i, i + n).join(" "));
  }
  return out;
}

/** Jaccard overlap of two shingle sets; 0 when either is empty. */
export function shingleOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const s of a) if (b.has(s)) inter += 1;
  return inter / (a.size + b.size - inter);
}
