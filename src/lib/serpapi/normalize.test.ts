import { describe, expect, it } from "vitest";
import {
  normalizeAboutThisImageResponse,
  normalizeExactMatchesResponse,
  normalizeLensAllResponse,
  normalizeSearchResponse,
  recordDateSources,
} from "./normalize";
import { serpapiResponseFailed } from "./client";
import type { EvidenceDateSources } from "../investigation/dates";

const retrievedAt = "2026-09-26T00:00:00.000Z";

describe("normalizeLensAllResponse", () => {
  const json = {
    search_metadata: { id: "search-abc", status: "Success" },
    visual_matches: [
      {
        position: 1,
        title: "A page",
        link: "https://news.example.com/story?utm_source=x#frag",
        source: "News",
        thumbnail: "https://img.example.com/t.png",
        image: "https://img.example.com/full.png",
        // navigation signal only — must NOT confer identity (§6.3)
        exact_matches: true,
        serpapi_exact_matches_link: "https://serpapi.com/search?x=1",
      },
      { position: 2, title: "Bad", link: "not a url" },
    ],
    related_content: [
      { query: "delhi floods", link: "https://google.com/q" },
      { query: "yamuna flood 2023", link: "https://google.com/q2" },
    ],
  };

  it("normalizes visual matches as unverified VISUAL_LEAD", () => {
    const batch = normalizeLensAllResponse(json, { retrievedAt });
    expect(batch.candidates).toHaveLength(1);
    const c = batch.candidates[0];
    expect(c.retrievalKind).toBe("lens_visual");
    expect(c.mediaRelationship).toBe("VISUAL_LEAD");
    expect(c.identityEvidence.basis).toBe("unverified");
    expect(c.canonicalUrl).toBe("https://news.example.com/story");
    expect(c.registrableDomain).toBe("example.com");
    expect(c.serpSearchId).toBe("search-abc");
  });

  it("collects bounded related-content queries", () => {
    const batch = normalizeLensAllResponse(json, { retrievedAt });
    expect(batch.relatedQueries).toEqual(["delhi floods", "yamuna flood 2023"]);
  });

  it("treats an embedded validated exact_matches collection as provider exact", () => {
    const withExact = {
      ...json,
      exact_matches: [
        { position: 1, title: "Exact", link: "https://x.example.com/a", thumbnail: "t" },
      ],
    };
    const batch = normalizeLensAllResponse(withExact, { retrievedAt });
    const exact = batch.candidates.find((c) => c.retrievalKind === "lens_exact");
    expect(exact?.mediaRelationship).toBe("EXACT_MATCH");
    expect(exact?.identityEvidence.basis).toBe("lens_exact_collection");
    expect(exact?.identityEvidence.verificationStatus).toBe("provider_reported");
  });
});

describe("normalizeExactMatchesResponse", () => {
  it("distinguishes unavailable vs empty vs malformed (§29)", () => {
    expect(
      normalizeExactMatchesResponse(null, { requestFailed: true, retrievedAt }).exactState,
    ).toBe("unavailable");
    expect(
      normalizeExactMatchesResponse({ exact_matches: [] }, { requestFailed: false, retrievedAt }).exactState,
    ).toBe("empty");
    expect(
      normalizeExactMatchesResponse({ nope: 1 }, { requestFailed: false, retrievedAt }).exactState,
    ).toBe("malformed");
    expect(
      normalizeExactMatchesResponse(
        { exact_matches: [{ title: "no link" }] },
        { requestFailed: false, retrievedAt },
      ).exactState,
    ).toBe("malformed");
  });

  it("produces EXACT_MATCH candidates from validated entries only", () => {
    const batch = normalizeExactMatchesResponse(
      { exact_matches: [{ position: 1, title: "E", link: "https://e.example.com/p" }] },
      { requestFailed: false, retrievedAt },
    );
    expect(batch.exactState).toBe("validated_occurrences");
    expect(batch.candidates[0].mediaRelationship).toBe("EXACT_MATCH");
    expect(batch.candidates[0].retrievals[0].kind).toBe("lens_exact");
  });

  it("treats the documented Success + no-results error + absent collection as provider-reported empty", () => {
    // Observed live + documented at serpapi.com/api-status-and-error-codes:
    // status=Success with a "hasn't returned any results" style error and
    // no exact_matches key.
    const batch = normalizeExactMatchesResponse(
      {
        search_metadata: { status: "Success", id: "x" },
        error: "Google Lens hasn't returned any results for this query.",
      },
      { requestFailed: false, retrievedAt },
    );
    expect(batch.exactState).toBe("empty");
    expect(batch.candidates).toHaveLength(0);
  });

  it("keeps Success + an arbitrary error + absent collection unavailable, not empty", () => {
    const batch = normalizeExactMatchesResponse(
      {
        search_metadata: { status: "Success" },
        error: "Some unrecognised provider condition.",
      },
      { requestFailed: false, retrievedAt },
    );
    expect(batch.exactState).toBe("unavailable");
  });

  it("keeps absent collection without any provider error malformed", () => {
    const batch = normalizeExactMatchesResponse(
      { search_metadata: { status: "Success" } },
      { requestFailed: false, retrievedAt },
    );
    expect(batch.exactState).toBe("malformed");
  });

  it("marks metadata status=Error unavailable even when the caller did not flag failure", () => {
    const batch = normalizeExactMatchesResponse(
      {
        search_metadata: { status: "Error" },
        error: "We couldn't get valid results for this search.",
      },
      { requestFailed: false, retrievedAt },
    );
    expect(batch.exactState).toBe("unavailable");
  });

  it("keeps a non-array collection malformed", () => {
    const batch = normalizeExactMatchesResponse(
      { search_metadata: { status: "Success" }, exact_matches: { bogus: true } },
      { requestFailed: false, retrievedAt },
    );
    expect(batch.exactState).toBe("malformed");
  });
});

describe("serpapiResponseFailed", () => {
  it("treats Success + result-level error as completed (provider-reported empty)", () => {
    expect(
      serpapiResponseFailed({
        search_metadata: { status: "Success" },
        error: "no results",
      }),
    ).toBe(false);
    expect(serpapiResponseFailed({ search_metadata: { status: "Error" } })).toBe(true);
    expect(serpapiResponseFailed({ error: "denied" })).toBe(true);
    expect(serpapiResponseFailed({ error: "denied", search_metadata: { status: "Success" } })).toBe(false);
    expect(serpapiResponseFailed({ visual_matches: [] })).toBe(false);
    expect(serpapiResponseFailed(null)).toBe(true);
  });
});

describe("normalizeAboutThisImageResponse", () => {
  it("extracts page_results across sections with date texts", () => {
    const batch = normalizeAboutThisImageResponse(
      {
        about_this_image: {
          header: { title: "Similar images are old" },
          sections: [
            {
              position: 1,
              title: "Found on these pages",
              page_results: [
                {
                  position: 1,
                  title: "P1",
                  link: "https://a.example.com/1",
                  date: "Jun 28, 2025",
                  snippet: "s",
                },
                { position: 2, title: "P2", link: "https://b.example.com/2" },
              ],
            },
          ],
        },
      },
      { retrievedAt },
    );
    expect(batch.candidates).toHaveLength(2);
    expect(batch.candidates[0].retrievalKind).toBe("lens_about_image");
    expect(batch.dateTexts.get(batch.candidates[0].id)).toBe("Jun 28, 2025");
    expect(batch.reportedCount).toBe(2);
  });
});

describe("normalizeSearchResponse", () => {
  it("handles google organic results", () => {
    const batch = normalizeSearchResponse(
      { organic_results: [{ position: 1, title: "T", link: "https://g.example.com", snippet: "sn" }] },
      "google_search",
      { retrievedAt },
    );
    expect(batch.candidates[0].retrievalKind).toBe("google_search");
    expect(batch.candidates[0].excerptSource).toBe("serp_snippet");
  });

  it("handles google_news news_results with dates", () => {
    const batch = normalizeSearchResponse(
      { news_results: [{ position: 1, title: "N", link: "https://n.example.com", date: "3 days ago" }] },
      "google_news",
      { retrievedAt },
    );
    expect(batch.candidates[0].retrievalKind).toBe("google_news");
    const map = new Map<string, EvidenceDateSources>();
    recordDateSources(map, batch);
    expect(map.get(batch.candidates[0].id)?.serpapi).toBe("3 days ago");
  });
});
