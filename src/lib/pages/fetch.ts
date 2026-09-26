/**
 * Safe source-page fetch (spec §18.1, §30).
 *
 * http/https only; localhost, literal private IPs, and .local/.internal
 * destinations are rejected to reduce SSRF risk; at most 3 redirects with
 * each hop revalidated; 5s timeout; 2 MB body cap; content-type must be
 * text/html. Fetched bytes are untrusted data — callers must never execute
 * or render them raw.
 */

import { TIMEOUTS, PAGE_FETCH_MAX_BYTES, PAGE_FETCH_MAX_REDIRECTS } from "../investigation/limits";
import { ProviderError, deadlineSignal, readBodyCapped, sanitizeFetchError } from "../providers/http";

export interface FetchedPage {
  /** Final URL after redirects. */
  url: string;
  html: string;
}

function hostnameRejected(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) {
    return true;
  }
  // Literal IPv6 loopback / unspecified
  if (h === "[::1]" || h === "::1" || h === "[::]" || h === "::") return true;
  // Literal IPv4 private/loopback/link-local ranges.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }
  return false;
}

function validatedHttpUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (hostnameRejected(url.hostname)) return null;
  return url;
}

/**
 * Fetch one page safely. Throws ProviderError (sanitized) on any failure —
 * callers treat failure as non-fatal (§29).
 */
export async function fetchPageHtml(
  rawUrl: string,
  signal?: AbortSignal,
  fetchImpl?: typeof fetch,
): Promise<FetchedPage> {
  let url = validatedHttpUrl(rawUrl);
  if (url === null) {
    throw new ProviderError("malformed", "page destination rejected");
  }
  const { signal: bound, cancel } = deadlineSignal(signal, TIMEOUTS.pageFetchMs);
  const doFetch = fetchImpl ?? fetch;
  try {
    for (let redirects = 0; ; redirects += 1) {
      const res = await doFetch(url.toString(), {
        signal: bound,
        redirect: "manual",
        headers: { accept: "text/html,*/*;q=0.1" },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        void res.body?.cancel().catch(() => undefined);
        if (loc === null || redirects >= PAGE_FETCH_MAX_REDIRECTS) {
          throw new ProviderError("http", `page fetch stopped after ${redirects} redirects`, res.status);
        }
        const next = validatedHttpUrl(new URL(loc, url).toString());
        if (next === null) {
          throw new ProviderError("malformed", "page redirect destination rejected");
        }
        url = next;
        continue;
      }
      if (!res.ok) {
        throw new ProviderError("http", `page fetch failed (HTTP ${res.status})`, res.status);
      }
      const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
      if (!contentType.includes("text/html")) {
        void res.body?.cancel().catch(() => undefined);
        throw new ProviderError("malformed", "page response was not text/html");
      }
      const html = await readBodyCapped(res, PAGE_FETCH_MAX_BYTES, "page");
      return { url: url.toString(), html };
    }
  } catch (err) {
    throw sanitizeFetchError(err, "page");
  } finally {
    cancel();
  }
}
