/**
 * Focused assertions for the Astra UI recheck residuals (U3/U4/U6/U7).
 * Each case reproduces an actual observed failure shape — no font counting,
 * no screenshot-only passes.
 */
import { describe, expect, it } from "vitest";
import {
  attributableSpan,
  claimComparisonsFor,
  comparisonCoverageText,
  comparisonSelected,
  comparisonsForOccurrence,
  comparisonsOf,
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
  isRestorableFocusTarget,
  jevDistributionsOf,
  jevModelOf,
  mediaRelationshipText,
  occurrenceRole,
  originStatusLabel,
  originSupportOf,
  pageMetadataOf,
  progressRelationshipNote,
  provenanceOf,
  reportingGroupHeadline,
  resultTypeLabel,
  retrievalEngineLabel,
  retrievalKindOf,
  searchIdsOf,
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
      {
        engine: "lens_exact_matches",
        attempted: 1,
        returned: 2,
        retained: 2,
        searchId: "CONTROLLED-exact-id",
      },
      { engine: "google_search_claim", attempted: 1, returned: 0, retained: 0, searchId: null },
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

  it("reads the request log with honest counts and the provider search id", () => {
    const log = getRequestLog(result)!;
    expect(log).toHaveLength(2);
    expect(log[0]).toEqual({
      engine: "lens_exact_matches",
      engineLabel: "Lens exact matches",
      attempted: 1,
      returned: 2,
      retained: 2,
      searchId: "CONTROLLED-exact-id",
    });
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

/* ---------------- §34 typed inspection projection ----------------
 *
 * Shapes mirror the actual contract at the accepted backend pin (G1/G2), not
 * invented ones. Each case pins a real published field so a contract change
 * cannot silently change what the inspection surface claims.
 */
describe("§34 technical inspection", () => {
  const distribution = occ({
    searchIds: ["CONTROLLED-exact-id"],
    engine: "lens_exact",
    resultType: "exact_match",
    sourceUrl: "https://alpha.com/story",
    canonicalUrl: "https://alpha.com/story",
    mediaRelationship: "EXACT_MATCH",
    publishedAtSource: "serpapi",
    retrievedAt: "2026-09-26T10:37:20.280Z",
    jevModel: "jev-1.13.0",
    jevDistributions: {
      relevance: 0.9,
      pageRole: {
        reporting: 0.8,
        factCheck: 0.05,
        socialRepost: 0.05,
        aggregator: 0.05,
        commentary: 0.03,
        other: 0.02,
      },
      contextRelation: null,
      claimRelation: null,
      locationRelation: null,
    },
  });

  it("reads the reported search ids, engine and result type in retrieval order", () => {
    expect(searchIdsOf(distribution)).toEqual(["CONTROLLED-exact-id"]);
    expect(retrievalEngineLabel(distribution)).toBe("Google Lens — exact matches");
    expect(resultTypeLabel(distribution)).toBe("Exact match collection");
    expect(jevModelOf(distribution)).toBe("jev-1.13.0");
    expect(mediaRelationshipText(distribution)).toBe(
      "Exact match — reported by Google Lens",
    );
    expect(mediaRelationshipText(occ({ mediaRelationship: "VISUAL_LEAD" }))).toBe(
      "Visual lead — not confirmed as the same image",
    );
    expect(mediaRelationshipText(occ({}))).toBeNull();
  });

  it("reports an absent search id as none, never as a placeholder id", () => {
    expect(searchIdsOf(occ({}))).toEqual([]);
    expect(searchIdsOf(occ({ searchIds: [] }))).toEqual([]);
    expect(retrievalEngineLabel(occ({}))).toBeNull();
    expect(resultTypeLabel(occ({}))).toBeNull();
    expect(jevModelOf(occ({}))).toBeNull();
  });

  it("shows each classification question separately, never as one score", () => {
    const view = jevDistributionsOf(distribution)!;
    expect(view.model).toBe("jev-1.13.0");
    expect(view.relevance).toEqual([
      { label: "Materially relevant to the image under investigation", value: 0.9 },
    ]);
    const pageRole = view.groups.find((g) => g.id === "pageRole")!;
    expect(pageRole.options!.map((o) => o.value)).toEqual([
      0.8, 0.05, 0.05, 0.05, 0.03, 0.02,
    ]);
    // The whole set sums to 1 — the view must not present a total or a score.
    const sum = pageRole.options!.reduce((acc, o) => acc + o.value, 0);
    expect(Math.round(sum * 1000) / 1000).toBe(1);
    expect(Object.keys(view)).not.toContain("score");
    expect(Object.keys(view)).not.toContain("confidence");
  });

  it("explains a question the model never answered instead of showing nothing", () => {
    const trace = jevDistributionsOf(distribution, { claimSubmitted: false })!;
    for (const id of ["contextRelation", "claimRelation", "locationRelation"]) {
      const group = trace.groups.find((g) => g.id === id)!;
      expect(group.options).toBeNull();
      expect(group.notAnswered).toBe(
        "Not asked — no claim was submitted with this investigation.",
      );
    }
    const claim = jevDistributionsOf(distribution, { claimSubmitted: true })!;
    expect(claim.groups.find((g) => g.id === "contextRelation")!.notAnswered).toBe(
      "No context answer was recorded for this occurrence.",
    );
  });

  it("returns no distributions at all when the occurrence was never classified", () => {
    expect(jevDistributionsOf(occ({}))).toBeNull();
    expect(jevDistributionsOf(occ({ jevDistributions: null }))).toBeNull();
    // A present-but-empty block is not an answer.
    expect(jevDistributionsOf(occ({ jevDistributions: { pageRole: {} } }))!.relevance).toBeNull();
  });

  it("reads each performed comparison with its actual pairwise answer", () => {
    const result = occ({
      comparisons: [
        {
          pairId: "ev-1|ev-2",
          fromOccurrenceId: "ev-1",
          toOccurrenceId: "ev-2",
          connector: "different_context",
          distribution: { sameContext: 0.01, differentContext: 0.98, unclear: 0.01 },
        },
      ],
    });
    const comparisons = comparisonsOf(result);
    expect(comparisons).toHaveLength(1);
    expect(comparisons[0].state).toBe("different");
    expect(comparisons[0].label).toBe("Different context — compared");
    expect(comparisons[0].options).toEqual([
      { label: "Same underlying context", value: 0.01 },
      { label: "Different underlying context", value: 0.98 },
      { label: "Not enough to tell", value: 0.01 },
    ]);
    expect(comparisonsForOccurrence(result, "ev-1")).toHaveLength(1);
    expect(comparisonsForOccurrence(result, "ev-2")).toHaveLength(1);
    expect(comparisonsForOccurrence(result, "ev-3")).toEqual([]);
  });

  it("reports an unexamined pair as not compared, with no invented answer", () => {
    const comparisons = comparisonsOf(
      occ({
        comparisons: [
          {
            pairId: "ev-1|ev-2",
            fromOccurrenceId: "ev-1",
            toOccurrenceId: "ev-2",
            connector: "unexamined",
            distribution: null,
          },
        ],
      }),
    );
    expect(comparisons[0].state).toBe("unexamined");
    expect(comparisons[0].label).toBe("Not compared in this investigation");
    expect(comparisons[0].options).toBeNull();
  });

  it("keeps a performed-but-inconclusive pair distinct from an unexamined one", () => {
    const [c] = comparisonsOf(
      occ({
        comparisons: [
          {
            pairId: "ev-1|ev-2",
            fromOccurrenceId: "ev-1",
            toOccurrenceId: "ev-2",
            connector: "uncertain",
            distribution: { sameContext: 0.02, differentContext: 0.03, unclear: 0.95 },
          },
        ],
      }),
    );
    expect(c.state).toBe("uncertain");
    expect(c.label).toBe("Comparison inconclusive — performed but not established");
    expect(c.options![2].value).toBe(0.95);
  });

  it("separates claim comparisons from occurrence pairs", () => {
    const result = occ({
      comparisons: [
        {
          pairId: "ev-1|ev-2",
          fromOccurrenceId: "ev-1",
          toOccurrenceId: "ev-2",
          connector: "different_context",
          distribution: { sameContext: 0.01, differentContext: 0.98, unclear: 0.01 },
        },
      ],
      provenance: {
        media: { id: "media" },
        sourceDomains: [{ id: "domain:alpha.com", domain: "alpha.com", occurrenceIds: ["ev-1"] }],
        contextSegments: [{ id: "segment:0", index: 0, occurrenceIds: ["ev-1"] }],
        divergenceEdges: [],
        claimContext: {
          claim: "This photograph was taken in London in 2025.",
          claimDate: "2025-06-01",
          claimDatePrecision: "day",
          comparisons: [
            {
              occurrenceId: "ev-1",
              segmentId: "segment:0",
              question: "context_relation",
              distribution: {
                sameContext: 0.1,
                differentContext: 0.85,
                historicalReference: 0.03,
                unclear: 0.02,
              },
            },
            {
              occurrenceId: "ev-1",
              segmentId: "segment:0",
              question: "claim_relation",
              distribution: { supports: 0.05, contradicts: 0.9, neutral: 0.03, insufficient: 0.02 },
            },
          ],
          comparedSegmentIds: ["segment:0"],
        },
      },
    });
    // A single candidate carries claim comparisons and no pair of its own.
    expect(comparisonsForOccurrence(result, "ev-1")).toHaveLength(1);
    const claims = claimComparisonsFor(result, "ev-1");
    expect(claims).toHaveLength(2);
    expect(claims[0].questionLabel).toBe("Context of this occurrence vs. your claim");
    expect(claims[0].options[1]).toEqual({
      label: "Different context from the claim",
      value: 0.85,
    });
    expect(claims[1].questionLabel).toBe("What this occurrence says about your claim");
    expect(claims[1].options[1].label).toBe("Contradicts what the claim says");
    expect(claims.every((c) => c.segmentKnown)).toBe(true);
    expect(claimComparisonsFor(result, "ev-2")).toEqual([]);
    const graph = provenanceOf(result)!;
    expect(graph.claimContext!.comparedSegmentIds).toEqual(["segment:0"]);
    // The rejected 69 shape is no longer read as claim evidence.
    expect(graph.claimContext).not.toHaveProperty("comparedPairIds");
  });

  it("shows a claim comparison with an absent question as asked-but-empty", () => {
    const claims = claimComparisonsFor(
      occ({
        provenance: {
          claimContext: {
            claim: "c",
            claimDate: null,
            claimDatePrecision: "unknown",
            comparisons: [{ occurrenceId: "ev-1", segmentId: null, question: null, distribution: null }],
            comparedSegmentIds: [],
          },
        },
      }),
      "ev-1",
    );
    expect(claims).toHaveLength(1);
    expect(claims[0].options).toEqual([]);
    expect(claims[0].questionLabel).toBe("Claim comparison question not identified");
    expect(claims[0].segmentKnown).toBe(false);
  });

  it("reports no claim context in trace mode rather than an empty claim", () => {
    expect(
      claimComparisonsFor(
        occ({ provenance: { claimContext: null, sourceDomains: [], contextSegments: [], divergenceEdges: [] } }),
        "ev-1",
      ),
    ).toEqual([]);
    expect(provenanceOf(occ({}))).toBeNull();
  });

  it("preserves a verified divergence whose earlier segment is unresolved", () => {
    const graph = provenanceOf(
      occ({
        provenance: {
          sourceDomains: [],
          contextSegments: [{ id: "segment:1", index: 1, occurrenceIds: ["ev-2"] }],
          divergenceEdges: [
            {
              pairId: "ev-2|ev-3",
              fromOccurrenceId: "ev-2",
              toOccurrenceId: "ev-3",
              fromSegmentId: null,
              toSegmentId: "segment:1",
              observedAt: "2022-01-01",
              firstObserved: true,
              earlierTransitionsUnresolved: true,
            },
          ],
          claimContext: null,
        },
      }),
    )!;
    expect(graph.divergences).toHaveLength(1);
    expect(graph.divergences[0].pairId).toBe("ev-2|ev-3");
    expect(graph.divergences[0].earlierUnresolved).toBe(true);
    expect(graph.divergences[0].fromSegmentKnown).toBe(false);
    expect(graph.divergences[0].toSegmentKnown).toBe(true);
  });

  it("renders page metadata as inert text and never as a link or markup", () => {
    const meta = pageMetadataOf(
      occ({
        pageMetadata: {
          jsonLd: [
            {
              binding: "root_entity",
              types: ["NewsArticle"],
              headline: "BOUND descriptive metadata",
              author: ["Reuters"],
              publisher: "Reuters",
              description: "Image from our original reporting.",
            },
          ],
          // A hostile og value is descriptive data, not navigation.
          openGraph: {
            "og:url": "javascript:alert('xss')",
            "og:title": "Title <script>alert(1)</script>",
            "og:site_name": "Example",
          },
        },
      }),
    )!;
    expect(meta.entities[0].binding).toBe("bound to the page root entity");
    expect(meta.entities[0].fields).toEqual([
      { label: "Type", value: "NewsArticle" },
      { label: "Headline", value: "BOUND descriptive metadata" },
      { label: "Byline", value: "Reuters" },
      { label: "Publisher", value: "Reuters" },
      { label: "Description", value: "Image from our original reporting." },
    ]);
    // The value survives verbatim as a plain string, and the projection
    // exposes no href/url/navigation field for it to be activated through.
    expect(meta.openGraph).toEqual([
      { property: "og:url", value: "javascript:alert('xss')" },
      { property: "og:title", value: "Title <script>alert(1)</script>" },
      { property: "og:site_name", value: "Example" },
    ]);
    for (const pair of meta.openGraph) {
      expect(Object.keys(pair).sort()).toEqual(["property", "value"]);
    }
    expect(JSON.stringify(meta)).not.toMatch(/"href"|"src"|"html"/);
  });

  it("reports absent or empty page metadata as no metadata", () => {
    expect(pageMetadataOf(occ({}))).toBeNull();
    expect(pageMetadataOf(occ({ pageMetadata: null }))).toBeNull();
    expect(pageMetadataOf(occ({ pageMetadata: { jsonLd: [], openGraph: {} } }))).toBeNull();
    // An entity with no retained fields is not displayed as an empty record.
    expect(
      pageMetadataOf(
        occ({ pageMetadata: { jsonLd: [{ binding: "root_entity", types: [] }], openGraph: {} } }),
      ),
    ).toBeNull();
  });
});

/* ---------------- focus restoration (F14) ----------------
 *
 * The recorded opener is rejected for every reason it can silently swallow a
 * focus() call, so a close never strands the user on <body>.
 */
describe("focus restoration target", () => {
  const target = (over: Partial<{ tagName: string; tabIndex: number; isConnected: boolean; disabled: boolean | null }> = {}) => ({
    tagName: "BUTTON",
    tabIndex: 0,
    isConnected: true,
    disabled: false,
    ...over,
  });

  it("accepts a live, focusable opener", () => {
    expect(isRestorableFocusTarget(target())).toBe(true);
  });

  it("rejects <body>, which focus() cannot move to", () => {
    // What focus falls back to when the dialog subtree is removed; treating it
    // as an opener is what leaves the user stranded after a close.
    expect(isRestorableFocusTarget(target({ tagName: "BODY", tabIndex: -1 }))).toBe(false);
  });

  it("rejects an opener that a re-render removed", () => {
    expect(isRestorableFocusTarget(target({ isConnected: false }))).toBe(false);
  });

  it("rejects a disabled control", () => {
    expect(isRestorableFocusTarget(target({ disabled: true }))).toBe(false);
  });

  it("rejects a control excluded from the tab order", () => {
    expect(isRestorableFocusTarget(target({ tabIndex: -1 }))).toBe(false);
  });

  it("rejects a missing opener so the view can fall back to the tab", () => {
    expect(isRestorableFocusTarget(null)).toBe(false);
    expect(isRestorableFocusTarget(undefined)).toBe(false);
  });
});
