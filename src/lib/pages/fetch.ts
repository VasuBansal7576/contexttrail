/**
 * Safe source-page fetch (spec §18.1, §30).
 *
 * Canonical http/https URLs, only public IP literals and DNS answers; each
 * fresh socket is pinned to an approved address. At most 3 redirects with
 * each hop re-resolved and revalidated; 5s timeout; 2 MB body cap; content-type must be
 * text/html. Fetched bytes are untrusted data — callers must never execute
 * or render them raw.
 */

import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { pinnedPageRequest, type PageAddress } from "./pinned-http";
import { TIMEOUTS, PAGE_FETCH_MAX_BYTES, PAGE_FETCH_MAX_REDIRECTS } from "../investigation/limits";
import { ProviderError, deadlineSignal, readBodyCapped, sanitizeFetchError } from "../providers/http";

export interface FetchedPage {
  /** Final URL after redirects. */
  url: string;
  html: string;
}

// Conservative special-use exclusions from IANA's IPv4/IPv6 registries:
// https://www.iana.org/assignments/iana-ipv4-special-registry
// https://www.iana.org/assignments/iana-ipv6-special-registry
const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(network, prefix, "ipv4");
// Fail closed outside global unicast, and exclude special-use/transition ranges
// within it. Mapped IPv4, NAT64, ULA, link-local and multicast never qualify.
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [network, prefix] of [
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
] as const) blocked.addSubnet(network, prefix, "ipv6");

export function isPublicPageAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, "ipv4")
    : family === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

function validatedHttpUrl(raw: string): URL | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  const literal = host.replace(/^\[|\]$/g, "");
  if (isIP(literal)) {
    if (!isPublicPageAddress(literal)) return null;
  } else {
    if (!host.includes(".") || host.length > 253 || host.split(".").some(
      (label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
    )) return null;
    if (["localhost", "local", "internal", "home.arpa"].some(
      (name) => host === name || host.endsWith(`.${name}`),
    )) return null;
  }
  url.hostname = host;
  url.hash = "";
  return url;
}

export interface PageFetchDeps {
  resolve?: (host: string) => Promise<Array<{ address: string; family: number }>>;
  request?: (url: URL, address: PageAddress, signal: AbortSignal) => Promise<Response>;
}

async function resolvePublicAddress(url: URL, signal: AbortSignal, deps: PageFetchDeps): Promise<PageAddress> {
  signal.throwIfAborted();
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(host);
  let addresses: Array<{ address: string; family: number }>;
  if (family) addresses = [{ address: host, family }];
  else {
    const resolve = deps.resolve ?? ((hostname: string) => lookup(hostname, { all: true, verbatim: true }));
    // DNS lookup has no AbortSignal API. Stop waiting at the shared deadline,
    // remove our listener, and never dispatch if its eventual result arrives late.
    addresses = await new Promise((accept, reject) => {
      const cleanup = () => signal.removeEventListener("abort", onAbort);
      const onAbort = () => { cleanup(); reject(signal.reason); };
      signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve().then(() => resolve(host)).then(
        (result) => { cleanup(); accept(result); },
        (error) => { cleanup(); reject(error); },
      );
    });
  }
  signal.throwIfAborted();
  if (!addresses.length || addresses.some((a) =>
    isIP(a.address) !== a.family || !isPublicPageAddress(a.address),
  )) throw new ProviderError("malformed", "page DNS destination rejected");
  return { address: addresses[0].address, family: addresses[0].family as 4 | 6 };
}

/**
 * Fetch one page safely. Throws ProviderError (sanitized) on any failure —
 * callers treat failure as non-fatal (§29).
 */
export async function fetchPageHtml(
  rawUrl: string,
  signal?: AbortSignal,
  deps: PageFetchDeps = {},
): Promise<FetchedPage> {
  let url = validatedHttpUrl(rawUrl);
  if (url === null) {
    throw new ProviderError("malformed", "page destination rejected");
  }
  const { signal: bound, cancel } = deadlineSignal(signal, TIMEOUTS.pageFetchMs);
  try {
    for (let redirects = 0; ; redirects += 1) {
      const address = await resolvePublicAddress(url, bound, deps);
      const res = await (deps.request ?? pinnedPageRequest)(url, address, bound);
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        await res.body?.cancel().catch(() => undefined);
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
        await res.body?.cancel().catch(() => undefined);
        throw new ProviderError("http", `page fetch failed (HTTP ${res.status})`, res.status);
      }
      const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
      if (!contentType.includes("text/html")) {
        await res.body?.cancel().catch(() => undefined);
        throw new ProviderError("malformed", "page response was not text/html");
      }
      const encoding = res.headers.get("content-encoding");
      if (encoding && encoding.toLowerCase() !== "identity") {
        await res.body?.cancel().catch(() => undefined);
        throw new ProviderError("malformed", "page response ignored identity encoding");
      }
      const length = res.headers.get("content-length");
      if (length !== null && Number(length) > PAGE_FETCH_MAX_BYTES) {
        await res.body?.cancel().catch(() => undefined);
        throw new ProviderError("malformed", "page response exceeded byte limit");
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
