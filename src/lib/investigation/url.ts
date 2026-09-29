/**
 * Canonical URL normalization (spec §12).
 *
 * Steps, in order: lowercase hostname, remove default ports, remove a leading
 * "www.", remove the fragment, remove known tracking parameters, sort the
 * remaining query parameters, remove a trailing slash when safe.
 *
 * Generic `ref` is preserved — it may be semantically meaningful.
 */

/** Exact-match removable tracking parameters (§12). */
const REMOVABLE_PARAMS = new Set([
  "fbclid",
  "gclid",
  "igshid",
  "ref_src",
  "mc_cid",
  "mc_eid",
]);

/** Any utm_* parameter is removable. */
const REMOVABLE_PREFIXES = ["utm_"];

function isRemovableParam(name: string): boolean {
  const lower = name.toLowerCase();
  if (REMOVABLE_PARAMS.has(lower)) return true;
  return REMOVABLE_PREFIXES.some((p) => lower.startsWith(p));
}

export interface CanonicalUrl {
  /** Normalized absolute URL string. */
  canonicalUrl: string;
  /** Lowercase hostname with a leading "www." removed. */
  hostname: string;
}

/**
 * Normalize a raw candidate URL. Returns null for non-http(s) or unparseable
 * input — callers keep the raw `sourceUrl` regardless.
 */
export function canonicalizeUrl(raw: string): CanonicalUrl | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  // Lowercase hostname + remove a single leading "www.".
  url.hostname = url.hostname.toLowerCase();
  if (url.hostname.startsWith("www.")) {
    url.hostname = url.hostname.slice(4);
  }

  // Remove default ports.
  if (
    (url.protocol === "http:" && url.port === "80") ||
    (url.protocol === "https:" && url.port === "443")
  ) {
    url.port = "";
  }

  // Remove fragment.
  url.hash = "";

  // Remove known tracking params, sort the rest (key, then value) for a
  // stable canonical ordering.
  const kept: Array<[string, string]> = [];
  for (const [name, value] of url.searchParams.entries()) {
    if (!isRemovableParam(name)) kept.push([name, value]);
  }
  kept.sort(([an, av], [bn, bv]) =>
    an === bn ? (av < bv ? -1 : av > bv ? 1 : 0) : an < bn ? -1 : 1,
  );
  url.search = "";
  for (const [name, value] of kept) url.searchParams.append(name, value);

  // Remove a trailing slash on non-root paths only; never turn "/" or a
  // path-less URL into something its server might treat differently.
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }

  return { canonicalUrl: url.toString(), hostname: url.hostname };
}

/** Lowercase, www-stripped hostname for a raw URL; null when invalid. */
export function normalizedHostname(raw: string): string | null {
  return canonicalizeUrl(raw)?.hostname ?? null;
}
