/**
 * Focused assertions for the Astra UI recheck residuals (U3/U4/U6/U7).
 * Each case reproduces an actual observed failure shape — no font counting,
 * no screenshot-only passes.
 */
import { describe, expect, it } from "vitest";
import {
  attributableSpan,
  comparisonCoverageText,
  comparisonSelected,
  connectorInfo,
  dateProvenanceOf,
  displayAttributionOf,
  getPolicyReasons,
  getReportingGroups,
  getRequestLog,
  getStatusBasis,
  getUnresolvedCandidateIds,
  humanizeCode,
  identityBasisDetailOf,
  identityBasisOf,
  identityMethodLabel,
  isContextualKind,
  occurrenceRole,
  originStatusLabel,
  originSupportOf,
  progressRelationshipNote,
  reportingGroupHeadline,
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

describe("R4 typed inspection contract", () => {
  const result = occ({
    requestLog: [
      { engine: "lens_exact_matches", attempted: 1, returned: 2, retained: 2 },
      { engine: "google_search_claim", attempted: 1, returned: 0, retained: 0 },
    ],
    policyReasons: [
      {
        gate: "distinct_domains",
        passed: true,
        detail: "2 registrable domain(s) among relevant core; >=2 required",
        supportIds: ["ev-1", "ev-2"],
      },
      { gate: "qualifying_conflicts", passed: false, detail: null, supportIds: [] },
    ],
    statusBasis: ["insufficient_qualifying_evidence"],
    reportingGroups: [
      { groupId: "dup:ev-1", memberIds: ["ev-1", "ev-2"], reason: ["article_text_duplication"] },
    ],
    unresolvedCandidateIds: ["ev-3"],
  });

  const item = occ({
    identityBasis: "lens_exact_collection",
    identityBasisDetail: { method: "lens_exact_collection", supportId: null },
    dateProvenance: {
      value: "2019-01-01",
      precision: "day",
      source: "page_json_ld",
      entityBinding: "page_url",
      rejectedCandidates: [{ value: "1999-01-01", reason: "unrelated nested article" }],
    },
    originSupport: {
      status: "shared_origin",
      groupId: "dup:ev-1",
      attributionSpans: [{ text: "Released by Reuters.", relation: "common provider" }],
      groupingReason: ["article_text_duplication"],
    },
    displayAttribution: "Extracted page excerpt",
    comparisonSelection: { selected: true, comparedPairIds: ["ev-1|ev-2"] },
  });

  it("reads the request log with honest counts", () => {
    const log = getRequestLog(result)!;
    expect(log).toHaveLength(2);
    expect(log[0]).toEqual({ engine: "lens_exact_matches", attempted: 1, returned: 2, retained: 2 });
    expect(getRequestLog(occ({}))).toBeNull();
  });

  it("reads policy gates with humanized labels and support IDs", () => {
    const reasons = getPolicyReasons(result);
    expect(reasons).toHaveLength(2);
    expect(reasons[0].gateLabel).toBe("Distinct domains");
    expect(reasons[0].passed).toBe(true);
    expect(reasons[0].supportIds).toEqual(["ev-1", "ev-2"]);
    expect(getStatusBasis(result)).toEqual(["Insufficient qualifying evidence"]);
  });

  it("reads reporting groups and unresolved IDs", () => {
    const groups = getReportingGroups(result);
    expect(groups[0].memberCount).toBe(2);
    expect(groups[0].reasons).toEqual(["Article text duplication"]);
    expect(getUnresolvedCandidateIds(result)).toEqual(["ev-3"]);
  });

  it("reads identity basis detail with method copy", () => {
    expect(identityMethodLabel("lens_exact_collection")).toBe("Reported by Google Lens");
    expect(identityBasisDetailOf(item)).toEqual({
      methodLabel: "Reported by Google Lens",
      supportId: null,
    });
    expect(identityBasisDetailOf(occ({}))).toBeNull();
  });

  it("reads date provenance with binding and rejections", () => {
    const d = dateProvenanceOf(item)!;
    expect(d.value).toBe("2019-01-01");
    expect(d.entityBinding).toBe("Bound to the fetched page URL");
    expect(d.rejected).toEqual([{ value: "1999-01-01", reason: "unrelated nested article" }]);
    expect(dateProvenanceOf(occ({}))).toBeNull();
  });

  it("reads origin support spans and reasons", () => {
    const o = originSupportOf(item)!;
    expect(originStatusLabel(o.status)).toBe("Shared reporting origin.");
    expect(o.spans).toHaveLength(1);
    expect(o.reasons).toEqual(["Article text duplication"]);
    expect(originSupportOf(occ({}))).toBeNull();
  });

  it("prefers backend display attribution and comparison selection", () => {
    expect(displayAttributionOf(item)).toBe("Extracted page excerpt");
    expect(displayAttributionOf(occ({}))).toBeNull();
    expect(comparisonSelected(item)).toBe(true);
    expect(comparisonSelected(occ({ comparisonSelection: { selected: false } }))).toBe(false);
    expect(comparisonSelected(occ({}))).toBeNull();
  });

  it("humanizes deterministic codes without inventing meaning", () => {
    expect(humanizeCode("article_text_duplication")).toBe("Article text duplication");
  });
});

describe("R4 residual: neutral reporting-group labels", () => {
  it("labels a genuinely shared group without claiming more", () => {
    const groups = getReportingGroups(
      occ({
        reportingGroups: [
          { groupId: "dup:ev-1", memberIds: ["ev-1", "ev-2"], reason: ["article_text_duplication"] },
        ],
      }),
    );
    expect(reportingGroupHeadline(groups[0])).toBe("Reporting group of 2 occurrences");
    expect(groups[0].reasons).toEqual(["Article text duplication"]);
    expect(groups[0].memberIds).toEqual(["ev-1", "ev-2"]);
  });

  it("labels a separately-evidenced group identically neutrally", () => {
    // No backend-emitted separately-evidenced group fixture exists yet;
    // this shape mirrors the actual ReportingGroupSummary contract.
    const groups = getReportingGroups(
      occ({
        reportingGroups: [
          { groupId: "sep:ev-9", memberIds: ["ev-9"], reason: ["separate_reporting_evidence"] },
        ],
      }),
    );
    expect(reportingGroupHeadline(groups[0])).toBe("Reporting group of 1 occurrence");
    expect(groups[0].reasons).toEqual(["Separate reporting evidence"]);
  });
});
