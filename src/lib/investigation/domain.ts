/**
 * Registrable-domain extraction (spec §13).
 *
 * `sourceDomainCount` counts distinct registrable domains among core visual
 * occurrences, so it must be Public Suffix List-aware: `news.bbc.co.uk` and
 * `www.bbc.co.uk` are one domain family. Uses `tldts` (PSL-aware) rather than
 * a hand-rolled suffix list.
 *
 * Requires the `tldts` package — see src/lib/investigation/README.md.
 */

import { getDomain } from "tldts";

/**
 * Registrable domain for a hostname or URL: `news.bbc.co.uk` -> `bbc.co.uk`,
 * `www.reddit.com` -> `reddit.com`. Falls back to the input hostname for
 * IPs, localhost, and unparseable input so those remain distinguishable
 * rather than collapsing into a shared null bucket.
 */
export function registrableDomain(urlOrHostname: string): string | null {
  let hostname = urlOrHostname;
  if (urlOrHostname.includes("://") || urlOrHostname.includes("/")) {
    try {
      hostname = new URL(urlOrHostname).hostname;
    } catch {
      return null;
    }
  }
  hostname = hostname.toLowerCase();
  if (hostname === "") return null;
  if (hostname.startsWith("www.")) hostname = hostname.slice(4);
  const domain = getDomain(hostname, { allowPrivateDomains: false });
  return domain ?? hostname;
}

/**
 * Count distinct registrable domains among the given candidates (§13).
 * This is "Source domains" — never label it "Independent sources".
 */
export function countSourceDomains(
  candidates: ReadonlyArray<{ registrableDomain: string }>,
): number {
  return new Set(candidates.map((c) => c.registrableDomain)).size;
}
