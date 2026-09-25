import { describe, expect, it } from "vitest";
import { canonicalizeUrl, normalizedHostname } from "../url";

describe("canonicalizeUrl (§12)", () => {
  it("lowercases hostname, removes www. and fragment", () => {
    const r = canonicalizeUrl("HTTPS://WWW.Example.COM/Path#frag");
    expect(r?.hostname).toBe("example.com");
    expect(r?.canonicalUrl).toBe("https://example.com/Path");
  });

  it("removes default ports but keeps non-default ones", () => {
    expect(
      canonicalizeUrl("https://example.com:443/a")?.canonicalUrl,
    ).toBe("https://example.com/a");
    expect(
      canonicalizeUrl("http://example.com:80/a")?.canonicalUrl,
    ).toBe("http://example.com/a");
    expect(
      canonicalizeUrl("https://example.com:8443/a")?.canonicalUrl,
    ).toBe("https://example.com:8443/a");
  });

  it("strips known tracking params and utm_*", () => {
    const r = canonicalizeUrl(
      "https://x.com/a?utm_source=n&fbclid=1&gclid=2&igshid=3&ref_src=tw&mc_cid=4&mc_eid=5&real=1",
    );
    expect(r?.canonicalUrl).toBe("https://x.com/a?real=1");
  });

  it("keeps generic ref — it may be meaningful", () => {
    const r = canonicalizeUrl("https://x.com/a?ref=homepage");
    expect(r?.canonicalUrl).toBe("https://x.com/a?ref=homepage");
  });

  it("sorts remaining query parameters", () => {
    const r = canonicalizeUrl("https://x.com/a?b=2&a=1&a=0");
    expect(r?.canonicalUrl).toBe("https://x.com/a?a=0&a=1&b=2");
  });

  it("removes trailing slash on non-root paths only", () => {
    expect(canonicalizeUrl("https://x.com/a/")?.canonicalUrl).toBe(
      "https://x.com/a",
    );
    expect(canonicalizeUrl("https://x.com/")?.canonicalUrl).toBe(
      "https://x.com/",
    );
  });

  it("rejects non-http(s) and invalid URLs", () => {
    expect(canonicalizeUrl("ftp://x.com/a")).toBeNull();
    expect(canonicalizeUrl("not a url")).toBeNull();
    expect(canonicalizeUrl("javascript:alert(1)")).toBeNull();
  });

  it("makes tracking-param variants of one URL identical", () => {
    const a = canonicalizeUrl("https://x.com/p?utm_medium=a&id=9");
    const b = canonicalizeUrl("https://www.x.com/p/?id=9");
    expect(a?.canonicalUrl).toBe(b?.canonicalUrl);
  });
});

describe("normalizedHostname", () => {
  it("returns null on invalid input", () => {
    expect(normalizedHostname(":::bad")).toBeNull();
  });
});
