/**
 * SerpApi response → EvidenceCandidate normalization (spec §6.3–6.5, §11).
 *
 * Field mapping uses only documented SerpApi surfaces:
 * - google_lens type=all:        `visual_matches`, `related_content`, and an
 *   optional top-level `exact_matches` collection.
 * - google_lens exact_matches:   `exact_matches` occurrence collection.
 * - google_lens about_this_image: `about_this_image.sections[].page_results`.
 * - google / google_news:        `organic_results` / `news_results`.
 *
 * A visual result's own `exact_matches` flag or `serpapi_exact_matches_link`
 * is a navigation signal only — it never produces an EXACT_MATCH candidate
 * here (§6.3). EXACT_MATCH comes solely from validated exact collections,
 * resolved through `resolveMediaRelationship` so the invariant lives in one
 * place.
 */

import type {
  EvidenceCandidate,
  RetrievalKind,
} from "../investigation/contracts/evidence";
import type { EvidenceDateSources } from "../investigation/dates";
import { registrableDomain } from "../investigation/domain";
import {
  classifyExactMatchCollection,
  resolveMediaRelationship,
} from "../investigation/identity";
import { unresolvedOrigin } from "../investigation/reporting-origins";
import { canonicalizeUrl, normalizedHostname } from "../investigation/url";
import { serpapiSearchId } from "./client";

export interface NormalizedBatch {
  candidates: EvidenceCandidate[];
  /** Raw result count on this response surface, for `search.batch` events. */
  reportedCount: number;
  /** Lens related_content queries usable for grounded expansion (§8). */
  relatedQueries: string[];
  /** Whether the response surface was absent/malformed vs. genuinely empty. */
  surfacePresent: boolean;
  /** Provider-reported date text per candidate id (fed into §19.2 resolution). */
  dateTexts: Map<string, string>;
}

let seq = 0;
function nextId(): string {
  seq += 1;
  return `ev-${Date.now().toString(36)}-${seq}`;
}

function asObj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function strField(o: Record<string, unknown> | null, key: string): string | null {
  const v = o?.[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function numField(o: Record<string, unknown> | null, key: string): number | null {
  const v = o?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function baseCandidate(input: {
  retrievalKind: RetrievalKind;
  link: string;
  title: string | null;
  snippet: string | null;
  serpPosition: number | null;
  serpSearchId: string | null;
  thumbnailUrl: string | null;
  resultImageUrl: string | null;
  resultType: string;
  retrievedAt: string;
}): EvidenceCandidate | null {
  const canonical = canonicalizeUrl(input.link);
  if (canonical === null) return null;
  const domain = normalizedHostname(input.link) ?? canonical.hostname;
  const registrable = registrableDomain(domain) ?? domain;
  const id = nextId();
  const resolved = resolveMediaRelationship({
    fromValidatedExactCollection: false,
    verification: null,
  });
  return {
    id,
    retrievalKind: input.retrievalKind,
    sourceUrl: input.link,
    canonicalUrl: canonical.canonicalUrl,
    domain,
    registrableDomain: registrable,
    title: input.title,
    snippet: input.snippet,
    serpPosition: input.serpPosition,
    serpSearchId: input.serpSearchId,
    publishedAt: null,
    publishedAtSource: null,
    thumbnailUrl: input.thumbnailUrl,
    resultImageUrl: input.resultImageUrl,
    mediaRelationship: resolved.mediaRelationship,
    identityEvidence: resolved.identityEvidence,
    reportingOrigin: unresolvedOrigin(id),
    datePrecision: "unknown",
    dateStatus: "unknown",
    excerptSource: input.snippet !== null ? "serp_snippet" : null,
    retrievals: [
      {
        kind: input.retrievalKind,
        searchId: input.serpSearchId,
        resultType: input.resultType,
        retrievedAt: input.retrievedAt,
      },
    ],
    pageText: null,
    judgment: null,
  };
}

function exactCandidate(
  raw: Record<string, unknown>,
  link: string,
  ctx: { searchId: string | null; retrievedAt: string },
): EvidenceCandidate | null {
  const c = baseCandidate({
    retrievalKind: "lens_exact",
    link,
    title: strField(raw, "title"),
    snippet: strField(raw, "snippet"),
    serpPosition: numField(raw, "position"),
    serpSearchId: ctx.searchId,
    thumbnailUrl: strField(raw, "thumbnail"),
    resultImageUrl: strField(raw, "image"),
    resultType: "exact_match",
    retrievedAt: ctx.retrievedAt,
  });
  if (c === null) return null;
  const resolved = resolveMediaRelationship({
    fromValidatedExactCollection: true,
    verification: null,
  });
  c.mediaRelationship = resolved.mediaRelationship;
  c.identityEvidence = resolved.identityEvidence;
  return c;
}

/**
 * SerpApi's documented no-results convention
 * (https://serpapi.com/api-status-and-error-codes): a completed search
 * whose engine returned no results keeps `search_metadata.status` =
 * "Success" and describes the empty state in the top-level `error`
 * string, e.g. "Google Lens hasn't returned any results for this
 * query." Only that documented shape may be read as provider-reported
 * empty — an arbitrary Success+error stays "unavailable" and an
 * unexplained absent collection stays "malformed" (§29).
 */
const SERPAPI_NO_RESULTS_ERROR =
  /hasn'?t returned|has not returned|didn'?t return|did not return|no results/i;

function searchMetadataStatus(o: Record<string, unknown> | null): string | null {
  return strField(asObj(o?.search_metadata), "status");
}

/**
 * Normalize a dedicated Lens `type=exact_matches` response (§6.3).
 * `requestFailed` marks transport/provider failure — kept distinct from a
 * missing, malformed, or empty collection per §29. The boundary also
 * re-checks `search_metadata.status` itself rather than relying on the
 * caller's failure flag alone.
 */
export function normalizeExactMatchesResponse(
  json: unknown,
  opts: { requestFailed: boolean; retrievedAt: string },
): NormalizedBatch & {
  exactState: ReturnType<typeof classifyExactMatchCollection>["state"];
} {
  const o = asObj(json);
  const searchId = serpapiSearchId(json);
  const metaStatus = searchMetadataStatus(o);
  const providerError = strField(o, "error");
  const requestFailed = opts.requestFailed || metaStatus === "Error";
  const collection = classifyExactMatchCollection({
    requestFailed,
    collection: o?.exact_matches,
  });
  let exactState = collection.state;
  if (exactState === "malformed" && o !== null && !("exact_matches" in o)) {
    if (providerError !== null) {
      exactState =
        metaStatus === "Success" && SERPAPI_NO_RESULTS_ERROR.test(providerError)
          ? "empty"
          : "unavailable";
    }
    // No provider error and no collection: unexplained shape — malformed.
  }
  const candidates = collection.entries
    .map((e) => exactCandidate(e.raw, e.link, { searchId, retrievedAt: opts.retrievedAt }))
    .filter((c): c is EvidenceCandidate => c !== null);
  return {
    candidates,
    reportedCount: Array.isArray(o?.exact_matches) ? (o.exact_matches as unknown[]).length : 0,
    relatedQueries: [],
    surfacePresent: exactState !== "malformed",
    exactState,
    dateTexts: new Map(),
  };
}

/**
 * Normalize a Lens `type=all` response: visual matches, any embedded
 * validated `exact_matches` collection (merged as provider-reported exact
 * occurrences), and bounded related-content queries.
 */
export function normalizeLensAllResponse(
  json: unknown,
  opts: { retrievedAt: string },
): NormalizedBatch {
  const o = asObj(json);
  const searchId = serpapiSearchId(json);
  const candidates: EvidenceCandidate[] = [];

  const visual = Array.isArray(o?.visual_matches) ? (o.visual_matches as unknown[]) : [];
  for (const v of visual) {
    const raw = asObj(v);
    const link = strField(raw, "link");
    if (raw === null || link === null) continue;
    // `exact_matches` flag / `serpapi_exact_matches_link` on a visual result
    // is a navigation signal only — ignored for identity (§6.3).
    const c = baseCandidate({
      retrievalKind: "lens_visual",
      link,
      title: strField(raw, "title"),
      snippet: strField(raw, "snippet"),
      serpPosition: numField(raw, "position"),
      serpSearchId: searchId,
      thumbnailUrl: strField(raw, "thumbnail"),
      resultImageUrl: strField(raw, "image"),
      resultType: "visual_match",
      retrievedAt: opts.retrievedAt,
    });
    if (c !== null) candidates.push(c);
  }

  const exact = classifyExactMatchCollection({
    requestFailed: false,
    collection: o?.exact_matches,
  });
  if (exact.state === "validated_occurrences") {
    for (const e of exact.entries) {
      const c = exactCandidate(e.raw, e.link, { searchId, retrievedAt: opts.retrievedAt });
      if (c !== null) candidates.push(c);
    }
  }

  const related = Array.isArray(o?.related_content) ? (o.related_content as unknown[]) : [];
  const relatedQueries = related
    .map((r) => strField(asObj(r), "query"))
    .filter((q): q is string => q !== null)
    .slice(0, 5);

  return {
    candidates,
    reportedCount: visual.length + exact.entries.length,
    relatedQueries,
    surfacePresent: o !== null,
    dateTexts: new Map(),
  };
}

/** Normalize a Lens `type=about_this_image` response (§6.4). */
export function normalizeAboutThisImageResponse(
  json: unknown,
  opts: { retrievedAt: string },
): NormalizedBatch {
  const o = asObj(json);
  const searchId = serpapiSearchId(json);
  const about = asObj(o?.about_this_image);
  const sections = Array.isArray(about?.sections) ? (about.sections as unknown[]) : [];
  const candidates: EvidenceCandidate[] = [];
  const dateTexts = new Map<string, string>();
  let count = 0;
  for (const s of sections) {
    const section = asObj(s);
    const pages = Array.isArray(section?.page_results)
      ? (section.page_results as unknown[])
      : [];
    for (const p of pages) {
      const raw = asObj(p);
      const link = strField(raw, "link");
      if (raw === null || link === null) continue;
      count += 1;
      const c = baseCandidate({
        retrievalKind: "lens_about_image",
        link,
        title: strField(raw, "title"),
        snippet: strField(raw, "snippet"),
        serpPosition: numField(raw, "position"),
        serpSearchId: searchId,
        thumbnailUrl: strField(raw, "thumbnail"),
        resultImageUrl: null,
        resultType: "about_this_image",
        retrievedAt: opts.retrievedAt,
      });
      if (c !== null) {
        candidates.push(c);
        const date = strField(raw, "date");
        if (date !== null) dateTexts.set(c.id, date);
      }
    }
  }
  return {
    candidates,
    reportedCount: count,
    relatedQueries: [],
    surfacePresent: about !== null,
    dateTexts,
  };
}

/**
 * Normalize SerpApi `google` (`organic_results`) or `google_news`
 * (`news_results`) responses.
 */
export function normalizeSearchResponse(
  json: unknown,
  kind: "google_search" | "google_news",
  opts: { retrievedAt: string },
): NormalizedBatch {
  const o = asObj(json);
  const searchId = serpapiSearchId(json);
  const key = kind === "google_news" ? "news_results" : "organic_results";
  const results = Array.isArray(o?.[key]) ? (o[key] as unknown[]) : [];
  const candidates: EvidenceCandidate[] = [];
  const dateTexts = new Map<string, string>();
  for (const r of results) {
    const raw = asObj(r);
    const link = strField(raw, "link");
    if (raw === null || link === null) continue;
    const c = baseCandidate({
      retrievalKind: kind,
      link,
      title: strField(raw, "title"),
      snippet: strField(raw, "snippet"),
      serpPosition: numField(raw, "position"),
      serpSearchId: searchId,
      thumbnailUrl: strField(raw, "thumbnail"),
      resultImageUrl: null,
      resultType: key === "news_results" ? "news_result" : "organic_result",
      retrievedAt: opts.retrievedAt,
    });
    if (c !== null) {
      candidates.push(c);
      const date = strField(raw, "date");
      if (date !== null) dateTexts.set(c.id, date);
    }
  }
  return {
    candidates,
    reportedCount: results.length,
    relatedQueries: [],
    surfacePresent: o !== null,
    dateTexts,
  };
}

/**
 * Collect provider-reported date text into the shared evidence-date source
 * map (§19.2 precedence resolves it later, possibly alongside page sources).
 */
export function recordDateSources(
  map: Map<string, EvidenceDateSources>,
  batch: NormalizedBatch,
): void {
  for (const [id, raw] of batch.dateTexts) {
    map.set(id, { ...(map.get(id) ?? {}), serpapi: raw });
  }
}
