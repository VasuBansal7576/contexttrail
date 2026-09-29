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

/** IPv4 private/loopback/link-local ranges — shared by dotted literals
 *  and IPv4-mapped/compatible IPv6 literals. */
function ipv4Rejected(a: number, b: number): boolean {
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/**
 * Parse an IPv6 literal (with or without brackets) into 16 bytes, or null
 * when the host is not an IPv6 literal. Handles `::` compression and a
 * trailing dotted-quad (IPv4-mapped/compatible forms).
 */
function ipv6Bytes(host: string): number[] | null {
  const s = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (!s.includes(":")) return null;
  if ((s.match(/::/g) ?? []).length > 1) return null;
  const hasCompression = s.includes("::");
  const [headRaw, tailRaw] = hasCompression ? s.split("::") : [s, ""];
  const toShorts = (part: string): number[] | null => {
    if (part === "") return [];
    const segs = part.split(":");
    const out: number[] = [];
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(seg);
      if (v4 !== null && i === segs.length - 1) {
        const b = v4.slice(1).map(Number);
        if (b.some((n) => n > 255)) return null;
        out.push((b[0] << 8) | b[1], (b[2] << 8) | b[3]);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(seg)) return null;
      out.push(parseInt(seg, 16));
    }
    return out;
  };
  const head = toShorts(headRaw);
  const tail = toShorts(tailRaw);
  if (head === null || tail === null) return null;
  const zeros = 8 - head.length - tail.length;
  if (zeros < 0 || (!hasCompression && zeros !== 0)) return null;
  const shorts = [...head, ...new Array<number>(zeros).fill(0), ...tail];
  const bytes: number[] = [];
  for (const w of shorts) bytes.push((w >> 8) & 0xff, w & 0xff);
  return bytes;
}

function hostnameRejected(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) {
    return true;
  }
  // Literal IPv6 — parsed canonically so unique-local (fc00::/7),
  // link-local (fe80::/10) and mapped/compatible private IPv4 are covered.
  const ip6 = ipv6Bytes(h);
  if (ip6 !== null) {
    const first12Zero = ip6.slice(0, 12).every((b) => b === 0);
    // Unspecified (::) and loopback (::1)
    if (first12Zero && ip6[12] === 0 && ip6[13] === 0 && ip6[14] === 0 && ip6[15] <= 1) return true;
    // IPv4-mapped ::ffff:a.b.c.d and compatible ::a.b.c.d → IPv4 rules.
    const mapped = ip6.slice(0, 10).every((b) => b === 0) && ip6[10] === 0xff && ip6[11] === 0xff;
    if ((mapped || first12Zero) && ipv4Rejected(ip6[12], ip6[13])) return true;
    // Unique-local fc00::/7
    if ((ip6[0] & 0xfe) === 0xfc) return true;
    // Link-local fe80::/10
    if (ip6[0] === 0xfe && (ip6[1] & 0xc0) === 0x80) return true;
    return false;
  }
  // Literal IPv4 dotted-decimal.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m && ipv4Rejected(Number(m[1]), Number(m[2]))) return true;
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
