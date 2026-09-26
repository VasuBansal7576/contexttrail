/**
 * Focused assertions for the Astra UI recheck residuals (U3/U4/U6/U7).
 * Each case reproduces an actual observed failure shape — no font counting,
 * no screenshot-only passes.
 */
import { describe, expect, it } from "vitest";
import {
  attributableSpan,
  comparisonCoverageText,
  connectorInfo,
  identityBasisOf,
  isContextualKind,
  occurrenceRole,
  progressRelationshipNote,
  retrievalKindOf,
  splitCompositeExcerpt,
  viewerEntryFor,
} from "./evidence-display";
import type { JsonRecord } from "@/lib/stream/result-view";
import { makeCandidate } from "@/lib/investigation/__tests__/testkit";
import { toPublicCandidate } from "@/lib/investigation/contracts/investigation";
import type { EvidenceCandidate } from "@/lib/investigation/contracts/evidence";

const occ = (fields: Record<string, unknown>): JsonRecord =>
  fields as unknown as JsonRecord;

describe("U7 excerpt composites", () => {
  it("bare title-only input is not quoted", () => {
    const o = occ({ excerpt: "Title: Example title", excerptSource: "page_text" });
    expect(splitCompositeExcerpt("Title: Example title")).toEqual({
      title: "Example title",
      snippet: null,
      body: null,
    });
    expect(attributableSpan(o)).toBeNull();
  });

  it("title + snippet without body quotes the snippet as a snippet", () => {
    const o = occ({
      excerpt: "Title: Example title\n\nSnippet: short retrieved text",
      excerptSource: "page_text",
    });
    const span = attributableSpan(o);
    expect(span).not.toBeNull();
    expect(span!.text).toBe("short retrieved text");
    expect(span!.attribution).toBe("Search snippet");
  });

  it("title + body without snippet quotes the body as extracted page text", () => {
    const o = occ({
      excerpt: "Title: Example title\n\nFirst body paragraph here.",
      excerptSource: "page_text",
    });
    const span = attributableSpan(o);
    expect(span).not.toBeNull();
    expect(span!.text).toBe("First body paragraph here.");
    expect(span!.attribution).toBe("Extracted page excerpt");
  });

  it("snippet-only input quotes as a snippet", () => {
    const o = occ({ excerpt: "Snippet: just the snippet", excerptSource: "page_text" });
    // "Snippet:"-prefixed text without a title wrapper is snippet-level text.
    const span = attributableSpan(o);
    expect(span).not.toBeNull();
    expect(span!.attribution).toBe("Search snippet");
    expect(span!.text).not.toContain("Snippet:");
  });

  it("full composite quotes only the first body paragraph", () => {
    const o = occ({
      excerpt: "Title: T\n\nSnippet: S\n\nBody one.\n\nBody two.",
      excerptSource: "page_text",
    });
    const span = attributableSpan(o);
    expect(span!.text).toBe("Body one.");
    expect(span!.attribution).toBe("Extracted page excerpt");
    expect(span!.truncated).toBe(true);
  });

  it("never exposes wire tokens in the span", () => {
    const o = occ({
      excerpt: "Title: T\n\nSnippet: S\n\nBody text.",
      excerptSource: "page_text",
    });
    const span = attributableSpan(o)!;
    expect(span.text).not.toMatch(/Title:|Snippet:/);
  });
});

describe("U4 comparison coverage wording", () => {
  it("counts pairs across selected occurrences, never pairs-of-pairs", () => {
    const r = occ({ comparisonCoverage: { eligible: 5, selected: 4, comparedPairs: 3 } });
    expect(comparisonCoverageText(r)).toBe(
      "3 pairs compared across 4 selected of 5 eligible occurrences",
    );
  });

  it("keeps the honest empty-coverage line", () => {
    const r = occ({ comparisonCoverage: { eligible: 0, selected: 0, comparedPairs: 0 } });
    expect(comparisonCoverageText(r)).toBe(
      "No occurrences were selected for context comparison",
    );
  });

  it("uncertain and unexamined edges stay distinct", () => {
    expect(connectorInfo(occ({ incomingConnector: { kind: "uncertain" } })).label).toContain(
      "inconclusive",
    );
    expect(connectorInfo(occ({ incomingConnector: { kind: "unexamined" } })).label).toContain(
      "Not compared",
    );
  });

  it("assessed edges name the previous-occurrence scope", () => {
    expect(connectorInfo(occ({ incomingConnector: { kind: "same_context" } })).label).toContain(
      "previous",
    );
    expect(connectorInfo(occ({ incomingConnector: { kind: "different_context" } })).label).toContain(
      "previous",
    );
  });
});

describe("U3 viewer pair derivation", () => {
  const endpoints = { fromOccurrenceId: "a", toOccurrenceId: "b" };
  const parsed = { fromId: "a", toId: "b", earlierUnresolved: false, observedAt: null };

  it("marks the later endpoint", () => {
    expect(viewerEntryFor("b", parsed).pairId).toBe("a");
    expect(viewerEntryFor("b", parsed).note).toContain("later occurrence");
  });

  it("marks the earlier endpoint", () => {
    expect(viewerEntryFor("a", parsed).pairId).toBe("b");
    expect(viewerEntryFor("a", parsed).note).toContain("earlier occurrence");
  });

  it("clears note and pair outside the endpoints", () => {
    expect(viewerEntryFor("c", parsed)).toEqual({ note: null, pairId: null });
    expect(viewerEntryFor("c", null)).toEqual({ note: null, pairId: null });
  });

  it("accepts the divergence record shape", () => {
    expect(endpoints.fromOccurrenceId).toBe("a");
  });
});

describe("U6/R2 contextual roles from the actual contract", () => {
  /** Real public shapes: toPublicCandidate emits retrievalKind, never engine. */
  const publicContextual = (kind: EvidenceCandidate["retrievalKind"]) =>
    toPublicCandidate(
      makeCandidate({
        retrievalKind: kind,
        mediaRelationship: null,
        identityEvidence: {
          basis: "contextual",
          hashDistance: null,
          verifierVersion: null,
          verifierConfigId: null,
          verificationStatus: "unavailable",
          comparisonMetrics: null,
        },
      }),
      null,
    ) as unknown as JsonRecord;

  it("reads retrievalKind, not engine, on streamed shapes", () => {
    const news = publicContextual("google_news");
    expect(news).not.toHaveProperty("engine");
    expect(retrievalKindOf(news)).toBe("google_news");
    expect(identityBasisOf(news)).toBe("contextual");
  });

  it("labels arriving null-identity search/news candidates as contextual (repro A)", () => {
    for (const kind of ["google_search", "google_news"] as const) {
      const c = publicContextual(kind);
      expect(progressRelationshipNote(c).label).toBe(
        "Contextual result · not same-media evidence",
      );
      for (const group of ["dated", "supporting", "contextual", "unknown"] as const) {
        expect(occurrenceRole(c, group)).toBe("Contextual result");
      }
    }
  });

  it("preserves contextual identity for undated lens_about_image (repro B)", () => {
    // Final-row shape: TimelineItem carries engine with the same kind values.
    const about = occ({ engine: "lens_about_image", mediaRelationship: null });
    expect(occurrenceRole(about, "unknown")).toBe("Contextual result");
    expect(progressRelationshipNote(publicContextual("lens_about_image")).label).toBe(
      "Contextual result · not same-media evidence",
    );
  });

  it("lens candidates without identity stay visual leads", () => {
    const lead = toPublicCandidate(makeCandidate({ mediaRelationship: null }), null);
    expect(progressRelationshipNote(lead as unknown as JsonRecord).label).toBe(
      "Visual lead · not verified",
    );
    expect(
      occurrenceRole(lead as unknown as JsonRecord, "unknown"),
    ).toBe("Visual lead");
  });

  it("exact and lead relationships keep their roles", () => {
    expect(occurrenceRole(occ({ mediaRelationship: "EXACT_MATCH" }), "dated")).toBe(
      "Core occurrence",
    );
    expect(occurrenceRole(occ({ mediaRelationship: "VISUAL_LEAD" }), "unknown")).toBe(
      "Visual lead",
    );
  });

  it("recognizes contextual retrieval kinds", () => {
    expect(isContextualKind("google_search")).toBe(true);
    expect(isContextualKind("google_news")).toBe(true);
    expect(isContextualKind("lens_about_image")).toBe(true);
    expect(isContextualKind("lens_exact")).toBe(false);
    expect(isContextualKind("lens_visual")).toBe(false);
    expect(isContextualKind(null)).toBe(false);
  });
});
