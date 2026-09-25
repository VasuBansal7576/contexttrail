import { describe, expect, it } from "vitest";
import { countSourceDomains, registrableDomain } from "../domain";

describe("registrableDomain (§13, PSL-aware)", () => {
  it("collapses subdomains into one domain family", () => {
    expect(registrableDomain("news.bbc.co.uk")).toBe("bbc.co.uk");
    expect(registrableDomain("www.bbc.co.uk")).toBe("bbc.co.uk");
    expect(registrableDomain("bbc.co.uk")).toBe("bbc.co.uk");
  });

  it("treats reddit subdomains as one source domain", () => {
    expect(registrableDomain("old.reddit.com")).toBe("reddit.com");
    expect(registrableDomain("https://www.reddit.com/r/x")).toBe("reddit.com");
  });

  it("handles multi-part public suffixes", () => {
    expect(registrableDomain("foo.blogspot.com")).toBe("blogspot.com");
    expect(registrableDomain("a.b.github.io")).toBe("github.io");
  });

  it("falls back to the hostname for IPs/localhost rather than null", () => {
    expect(registrableDomain("127.0.0.1")).toBe("127.0.0.1");
    expect(registrableDomain("localhost")).toBe("localhost");
  });
});

describe("countSourceDomains", () => {
  it("counts distinct registrable domains", () => {
    expect(
      countSourceDomains([
        { registrableDomain: "bbc.co.uk" },
        { registrableDomain: "bbc.co.uk" },
        { registrableDomain: "reuters.com" },
      ]),
    ).toBe(2);
  });
});
