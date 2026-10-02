/**
 * Readable page extraction and deterministic excerpt construction
 * (spec §18.2, §18.3, §19.2). Fetched HTML is parsed with jsdom +
 * @mozilla/readability; page text is treated strictly as data (§30).
 */

import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { EXCERPT_MAX_CHARS } from "../investigation/limits";
import type { JsonLdEntityMetadata } from "../investigation/contracts/evidence";
import { extractSourceLinks, type SourceLink } from './source-links';
import { canonicalizeUrl } from '../investigation/url';

export interface PageExtraction {
  sourceLinks: SourceLink[];
  title: string | null;
  /** Main readable text content; null when extraction fails. */
  text: string | null;
  /** Paragraphs of the readable text, for excerpt composition. */
  paragraphs: string[];
  /** datePublished-ish values from JSON-LD blocks, bound to the fetched page's entity. */
  jsonLdDates: string[];
  /** Binding tier that produced the selected JSON-LD date — "page_url",
   *  "main_entity", or "root_entity"; null when none was accepted. */
  jsonLdDateBinding: "page_url" | "main_entity" | "root_entity" | null;
  /** JSON-LD dates rejected for the page, with the binding reason. */
  rejectedJsonLdDates: Array<{ value: string; reason: string }>;
  /** Descriptive metadata retained ONLY from JSON-LD publication entities
   *  bound to the fetched page — never from contradicted or unbound nested
   *  entities (§18.2, §19.2). Bounded allowlist fields. */
  jsonLdMetadata: JsonLdEntityMetadata[];
  /** OpenGraph (`og:*`, `article:*`) meta pairs actually present on the
   *  page, bounded — raw retained candidates, never invented (§18.2). */
  openGraph: Record<string, string>;
  /** article:published_time / equivalent meta values. */
  metaDates: string[];
  /** Explicit publication <time datetime itemprop="datePublished"> values. */
  timeDates: string[];
  rejectedTimeDates: Array<{ value: string; reason: string }>;
}

/**
 * Entity-bound JSON-LD publication dates (§19.2). A publication date must
 * come from the entity being published — an article/posting node — never
 * from an arbitrary nested container such as a wrapping WebPage's
 * dateCreated or a BreadcrumbList. When no article-bound date exists, a
 * root-level node's explicit `datePublished` is the only fallback;
 * container `dateCreated`/`datePosted` never stand in for publication.
 */
// Creation/filming times are not publication times, even on a bound entity.
const JSONLD_DATE_KEYS = ["datePublished", "datePosted"] as const;

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

type Binding = "page_url" | "main_entity" | "root_entity" | "nested";

interface DateCandidate {
  value: string;
  bound: Binding;
  /** The node asserted an absolute URL/@id that is NOT the fetched page —
   *  it identifies as a different page, so its dates can never bind here. */
  contradicted?: boolean;
}

function normalizePageUrl(u: string): string {
  // Post IDs and case-sensitive paths identify resources. Tracking-only
  // normalization may bind a publication entity; dropping every query may not.
  return canonicalizeUrl(u)?.canonicalUrl ?? u;
}

/** Absolute page-identity URLs a node claims for itself. Relative or
 *  fragment identifiers are not page identity and are ignored. */
function ownPageUrls(o: Record<string, unknown>): string[] {
  const urls: string[] = [];
  for (const key of ["url", "@id", "mainEntityOfPage"] as const) {
    const v = o[key];
    const s =
      typeof v === "string"
        ? v
        : typeof v === "object" && v !== null &&
            typeof (v as Record<string, unknown>)["@id"] === "string"
          ? ((v as Record<string, unknown>)["@id"] as string)
          : null;
    if (s === null || !/^https?:/i.test(s.trim())) continue;
    urls.push(normalizePageUrl(s));
  }
  return urls;
}

/* -------- §18.2 — bounded metadata retention from bound entities -------- */

const META_STRING_CAP = 400;
const META_LIST_CAP = 8;
const META_ENTITY_CAP = 8;
const OG_ENTRY_CAP = 32;

function metaString(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== ""
    ? v.trim().slice(0, META_STRING_CAP)
    : null;
}

/** Names only — a Person/Organization node's own name, never its subtree. */
function metaNames(v: unknown, cap = META_LIST_CAP): string[] {
  const arr = Array.isArray(v) ? v : [v];
  const out: string[] = [];
  for (const n of arr) {
    const s =
      typeof n === "string"
        ? metaString(n)
        : metaString(
            (n as Record<string, unknown> | null)?.name ??
              (n as Record<string, unknown> | null)?.["@id"],
          );
    if (s !== null) out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

/** Sanitized allowlist of descriptive fields from a bound publication
 *  entity. Values are trimmed/capped strings or name lists — nothing else. */
function entityMetadata(
  o: Record<string, unknown>,
  binding: Exclude<Binding, "nested">,
): JsonLdEntityMetadata {
  const t = o["@type"];
  return {
    binding,
    types: (Array.isArray(t) ? t : [t])
      .filter((x): x is string => typeof x === "string")
      .slice(0, META_LIST_CAP),
    headline: metaString(o.headline ?? o.name),
    author: metaNames(o.author ?? o.creator),
    publisher: metaNames(o.publisher, 1)[0] ?? null,
    description: metaString(o.description),
  };
}

/**
 * Walk a JSON-LD graph collecting publication dates with the entity
 * binding that produced them. A date is bound to the fetched page when
 * its entity's url/@id/mainEntityOfPage matches the fetched URL, or the
 * entity is reached through a `mainEntity` edge, or it is a root-level
 * publication entity. Dates on unrelated nested entities (related
 * articles, ItemList members, embeds) are collected as `nested` and
 * never stand in for the page's own publication date.
 */
function collectEntityDates(
  node: unknown,
  out: DateCandidate[],
  pageUrl: string | null,
  bound: Binding,
  depth: number,
  metaOut?: JsonLdEntityMetadata[],
): void {
  if (typeof node !== "object" || node === null || depth > 8) return;
  if (Array.isArray(node)) {
    for (const n of node) collectEntityDates(n, out, pageUrl, bound, depth, metaOut);
    return;
  }
  const o = node as Record<string, unknown>;

  const ownUrls = pageUrl === null ? [] : ownPageUrls(o);

  let selfBound = bound;
  let contradicted = false;
  if (ownUrls.length > 0) {
    if (ownUrls.includes(pageUrl ?? "")) {
      selfBound = "page_url";
    } else {
      // The entity identifies as a different page — it can never bind here.
      selfBound = "nested";
      contradicted = true;
    }
  }
  if (!contradicted && selfBound === "nested" && depth === 0 && isPublicationEntity(o)) {
    selfBound = "root_entity";
  }

  if (isPublicationEntity(o)) {
    const fields: string[] = [];
    directDateFields(o, fields);
    for (const v of fields) out.push({ value: v, bound: selfBound, contradicted });
    // §18.2 — retain descriptive metadata only from entities that bind to
    // the fetched page; contradicted/unbound nested entities contribute
    // nothing (their dates are rejected for the same reason).
    if (
      metaOut !== undefined &&
      metaOut.length < META_ENTITY_CAP &&
      selfBound !== "nested" &&
      !contradicted
    ) {
      metaOut.push(entityMetadata(o, selfBound));
    }
  }

  for (const [k, v] of Object.entries(o)) {
    // Only a `mainEntity` edge binds a child to the page — and only when the
    // parent itself is the page (bound) or the document root. Ordinary
    // containment (hasPart, ItemList members, related articles) never
    // inherits page identity.
    const childBound =
      k === "mainEntity" && (selfBound !== "nested" || depth === 0)
        ? "main_entity"
        : "nested";
    collectEntityDates(v, out, pageUrl, childBound, depth + 1, metaOut);
  }
}

const META_DATE_KEYS = new Set([
  "article:published_time",
  "og:published_time",
  "datepublished",
  "dc.date.issued",
  "parsely-pub-date",
  "sailthru.date",
  "publish-date",
  "pubdate",
]);

export function extractPage(html: string, pageUrl?: string): PageExtraction {
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
  const candidates: DateCandidate[] = [];
  const jsonLdMetadata: JsonLdEntityMetadata[] = [];
  const normalizedUrl = pageUrl !== undefined ? normalizePageUrl(pageUrl) : null;
  for (const p of parsedLd) {
    collectEntityDates(p, candidates, normalizedUrl, "nested", 0, jsonLdMetadata);
  }

  // Strongest binding wins: a page-url-bound entity date beats a
  // mainEntity date, which beats a root-level publication entity. Dates
  // on entities bound to other pages (related articles, list members)
  // are rejected with their reason preserved.
  const rank: Record<Binding, number> = {
    page_url: 0,
    main_entity: 1,
    root_entity: 2,
    nested: 3,
  };
  const accepted = candidates
    .filter((c) => c.bound !== "nested")
    .sort((a, b) => rank[a.bound] - rank[b.bound]);
  const jsonLdDates = accepted.map((c) => c.value);
  let jsonLdDateBinding: PageExtraction["jsonLdDateBinding"] =
    accepted[0] === undefined || accepted[0].bound === "nested"
      ? null
      : accepted[0].bound;
  const rejectedJsonLdDates = candidates
    .filter((c) => c.bound === "nested")
    .map((c) => ({
      value: c.value,
      reason: c.contradicted
        ? "contradictory_entity_binding"
        : "unbound_nested_entity",
    }));
  if (jsonLdDates.length === 0) {
    // The root-level fallback must not re-admit a date the binding pass
    // already rejected: a root entity asserting a different absolute
    // page URL identifies as another page, so its datePublished is not
    // this page's publication date.
    for (const p of parsedLd) {
      const roots = Array.isArray(p) ? p : [p];
      for (const r of roots) {
        if (typeof r !== "object" || r === null) continue;
        const own = normalizedUrl === null ? [] : ownPageUrls(r as Record<string, unknown>);
        if (own.length > 0 && !own.includes(normalizedUrl ?? "")) continue;
        const v = (r as Record<string, unknown>).datePublished;
        if (typeof v === "string" && v.trim() !== "") jsonLdDates.push(v.trim());
      }
    }
    if (jsonLdDates.length > 0) jsonLdDateBinding = "root_entity";
  }

  const metaDates: string[] = [];
  const openGraph: Record<string, string> = {};
  for (const el of doc.querySelectorAll("meta")) {
    const rawKey = el.getAttribute("property") ?? el.getAttribute("name") ?? "";
    const key = rawKey.toLowerCase();
    if (META_DATE_KEYS.has(key)) {
      const content = el.getAttribute("content");
      if (content !== null && content.trim() !== "") metaDates.push(content.trim());
    }
    // §18.2 — retain OpenGraph pairs (og:* + the OG article:* namespace) as
    // bounded first-wins candidates; non-OG meta stays out.
    if (
      (key.startsWith("og:") || key.startsWith("article:")) &&
      Object.keys(openGraph).length < OG_ENTRY_CAP &&
      !(key in openGraph)
    ) {
      const content = el.getAttribute("content");
      if (content !== null && content.trim() !== "") {
        openGraph[key] = content.trim().slice(0, META_STRING_CAP);
      }
    }
  }

  const timeDates: string[] = [];
  const rejectedTimeDates: PageExtraction['rejectedTimeDates'] = [];
  for (const el of doc.querySelectorAll('time[datetime][itemprop~="datePublished"], time[datetime][itemprop~="datePosted"]')) {
    const dt = el.getAttribute("datetime");
    if (!dt?.trim()) continue;
    if (el.closest('blockquote, figure, aside, nav, header, footer')) {
      rejectedTimeDates.push({ value: dt.trim(), reason: 'quoted_time_owner' }); continue;
    }
    const owner = el.closest('[itemscope]');
    const itemId = owner?.getAttribute('itemid');
    if (!itemId || !pageUrl) {
      rejectedTimeDates.push({ value: dt.trim(), reason: 'unbound_time_owner' }); continue;
    }
    let ownerUrl: string;
    try { ownerUrl = new URL(itemId, pageUrl).toString(); } catch {
      rejectedTimeDates.push({ value: dt.trim(), reason: 'unbound_time_owner' }); continue;
    }
    if (normalizePageUrl(ownerUrl) !== normalizePageUrl(pageUrl)) {
      rejectedTimeDates.push({ value: dt.trim(), reason: 'contradictory_time_owner' }); continue;
    }
    timeDates.push(dt.trim());
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

  const sourceLinks = pageUrl ? extractSourceLinks(doc, pageUrl) : [];
  return { title, text, paragraphs, jsonLdDates, jsonLdDateBinding, rejectedJsonLdDates, jsonLdMetadata, openGraph, metaDates, timeDates, rejectedTimeDates, sourceLinks };
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

/** A verbatim paragraph with lexical overlap, never a title/snippet composite.
 * Overlap only selects a candidate: the model must still assess relevance and scope.
 * A supplied question takes precedence over the page's own title, which can be off-topic.
 */
export function selectDisplayQuote(input: { title: string | null; claim: string | null; paragraphs: string[] }): string | null {
  const queryText = input.claim?.trim() || input.title?.trim() || "";
  const query = tokens(queryText);
  const ranked = input.paragraphs.map(p => p.slice(0, EXCERPT_MAX_CHARS)).filter((p) => p.trim().length > 0).map((p, i) => ({
    p, i, overlap: [...tokens(p)].filter((t) => query.has(t)).length,
  })).filter(item => queryText === "" || item.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || a.i - b.i);
  return ranked[0]?.p.slice(0, EXCERPT_MAX_CHARS) ?? null;
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
