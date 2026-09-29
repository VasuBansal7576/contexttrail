import { describe, expect, it } from "vitest";
import {
  classifyExactMatchCollection,
  enforceIdentityInvariants,
  isCoreOccurrence,
  resolveMediaRelationship,
} from "../identity";
import { makeCandidate, makeExact } from "./testkit";

describe("classifyExactMatchCollection (§6.3, §29)", () => {
  it("keeps empty distinct from unavailable and malformed", () => {
    expect(
      classifyExactMatchCollection({ requestFailed: false, collection: [] })
        .state,
    ).toBe("empty");
    expect(
      classifyExactMatchCollection({ requestFailed: true, collection: [] })
        .state,
    ).toBe("unavailable");
    expect(
      classifyExactMatchCollection({ requestFailed: false, collection: null })
        .state,
    ).toBe("malformed");
    expect(
      classifyExactMatchCollection({
        requestFailed: false,
        collection: [{ noLink: true }],
      }).state,
    ).toBe("malformed");
  });

  it("returns validated entries only when they carry a link", () => {
    const r = classifyExactMatchCollection({
      requestFailed: false,
      collection: [{ link: "https://a.com/x" }, { source: "https://b.com/y" }],
    });
    expect(r.state).toBe("validated_occurrences");
    expect(r.entries).toHaveLength(2);
  });
});

describe("resolveMediaRelationship (§10.2–10.3)", () => {
  it("marks validated exact-collection entries EXACT_MATCH provider_reported", () => {
    const r = resolveMediaRelationship({
      fromValidatedExactCollection: true,
      verification: null,
    });
    expect(r.mediaRelationship).toBe("EXACT_MATCH");
    expect(r.identityEvidence.basis).toBe("lens_exact_collection");
    expect(r.identityEvidence.verificationStatus).toBe("provider_reported");
  });

  it("never promotes a hash-only pass to NEAR_MATCH", () => {
    const r = resolveMediaRelationship({
      fromValidatedExactCollection: false,
      verification: {
        hashDistance: 3,
        verificationStatus: "unavailable",
        verifierVersion: null,
        verifierConfigId: null,
        comparisonMetrics: null,
      },
    });
    expect(r.mediaRelationship).toBe("VISUAL_LEAD");
  });

  it("requires verifier pass + pinned IDs + metrics for NEAR_MATCH", () => {
    const ok = resolveMediaRelationship({
      fromValidatedExactCollection: false,
      verification: {
        hashDistance: 5,
        verificationStatus: "passed",
        verifierVersion: "spatial-1.0.0",
        verifierConfigId: "cfg-a",
        comparisonMetrics: { ssim: 0.97, regionAgreement: 0.9 },
      },
    });
    expect(ok.mediaRelationship).toBe("NEAR_MATCH");
    expect(ok.identityEvidence.basis).toBe("local_spatial_verification");

    const ambiguous = resolveMediaRelationship({
      fromValidatedExactCollection: false,
      verification: {
        hashDistance: 5,
        verificationStatus: "ambiguous",
        verifierVersion: "spatial-1.0.0",
        verifierConfigId: "cfg-a",
        comparisonMetrics: { ssim: 0.8 },
      },
    });
    expect(ambiguous.mediaRelationship).toBe("VISUAL_LEAD");

    const hashIneligible = resolveMediaRelationship({
      fromValidatedExactCollection: false,
      verification: {
        hashDistance: 9,
        verificationStatus: "passed",
        verifierVersion: "v",
        verifierConfigId: "c",
        comparisonMetrics: { ssim: 0.99 },
      },
    });
    expect(hashIneligible.mediaRelationship).toBe("VISUAL_LEAD");
  });
});

describe("enforceIdentityInvariants (§11, §38.3)", () => {
  it("demotes EXACT_MATCH lacking a lens_exact retrieval record", () => {
    const c = makeExact();
    c.retrievals = [
      {
        kind: "lens_visual",
        searchId: "s",
        resultType: "visual_match",
        retrievedAt: "2026-09-25T00:00:00.000Z",
      },
    ];
    expect(enforceIdentityInvariants(c)).toBe("VISUAL_LEAD");
  });

  it("demotes NEAR_MATCH without recorded verifier evidence", () => {
    const c = makeCandidate({
      mediaRelationship: "NEAR_MATCH",
      identityEvidence: {
        basis: "local_spatial_verification",
        hashDistance: 4,
        verifierVersion: null, // missing pin
        verifierConfigId: "cfg",
        verificationStatus: "passed",
        comparisonMetrics: { ssim: 0.9 },
      },
    });
    expect(enforceIdentityInvariants(c)).toBe("VISUAL_LEAD");
  });

  it("keeps a properly evidenced EXACT_MATCH", () => {
    expect(enforceIdentityInvariants(makeExact())).toBe("EXACT_MATCH");
  });

  it("visual leads are not core occurrences", () => {
    expect(isCoreOccurrence(makeCandidate())).toBe(false);
    expect(isCoreOccurrence(makeExact())).toBe(true);
  });
});
