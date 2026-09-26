/**
 * Fixture helpers for deterministic unit tests (spec §38.1). These build
 * synthetic candidates for tests only — they are never wired into the
 * production path (§40).
 */

import type { EvidenceCandidate } from "../contracts/evidence";
import type { EvidenceJudgment } from "../contracts/judgment";

let counter = 0;

export function makeCandidate(
  overrides: Partial<EvidenceCandidate> = {},
): EvidenceCandidate {
  counter += 1;
  const id = overrides.id ?? `cand-${counter}`;
  const url = overrides.sourceUrl ?? `https://example-${counter}.com/page`;
  return {
    id,
    retrievalKind: "lens_visual",
    sourceUrl: url,
    canonicalUrl: url,
    domain: new URL(url).hostname,
    registrableDomain: new URL(url).hostname.replace(/^www\./, ""),
    title: `Candidate ${id}`,
    snippet: null,
    serpPosition: counter,
    serpSearchId: "search-1",
    publishedAt: null,
    publishedAtSource: null,
    thumbnailUrl: null,
    resultImageUrl: null,
    mediaRelationship: "VISUAL_LEAD",
    identityEvidence: {
      basis: "unverified",
      hashDistance: null,
      verifierVersion: null,
      verifierConfigId: null,
      verificationStatus: "unavailable",
      comparisonMetrics: null,
    },
    reportingOrigin: {
      groupId: `unresolved:${id}`,
      status: "unresolved",
      basis: ["origin_unresolved_missing_evidence"],
      evidenceIds: [],
      attributionSpans: [],
    },
    datePrecision: "unknown",
    dateStatus: "unknown",
    excerptSource: null,
    retrievals: [
      {
        kind: "lens_visual",
        searchId: "search-1",
        resultType: "visual_match",
        retrievedAt: "2026-09-25T00:00:00.000Z",
      },
    ],
    pageText: null,
    judgment: null,
    ...overrides,
  };
}

export function makeExact(
  overrides: Partial<EvidenceCandidate> = {},
): EvidenceCandidate {
  const c = makeCandidate({ retrievalKind: "lens_exact", ...overrides });
  c.mediaRelationship = "EXACT_MATCH";
  c.identityEvidence = {
    basis: "lens_exact_collection",
    hashDistance: null,
    verifierVersion: null,
    verifierConfigId: null,
    verificationStatus: "provider_reported",
    comparisonMetrics: null,
  };
  c.retrievals = [
    {
      kind: "lens_exact",
      searchId: "search-exact",
      resultType: "exact_match",
      retrievedAt: "2026-09-25T00:00:00.000Z",
    },
  ];
  return c;
}

export function makeJudgment(
  overrides: Partial<EvidenceJudgment> = {},
): EvidenceJudgment {
  return {
    relevance: 0.9,
    contextRelation: {
      sameContext: 0.8,
      differentContext: 0.05,
      historicalReference: 0.05,
      unclear: 0.1,
    },
    pageRole: {
      reporting: 0.8,
      factCheck: 0.05,
      socialRepost: 0.05,
      aggregator: 0.05,
      commentary: 0.03,
      other: 0.02,
    },
    claimRelation: {
      supports: 0.8,
      contradicts: 0.05,
      neutral: 0.1,
      insufficient: 0.05,
    },
    locationRelation: null,
    model: "jev-1.13.0",
    schemaVersion: "contexttrail-evidence-v1",
    ...overrides,
  };
}

export function separateOrigin(
  c: EvidenceCandidate,
  groupId: string,
): EvidenceCandidate {
  c.reportingOrigin = {
    groupId,
    status: "separate_origin_evidenced",
    basis: ["separate_reporting_evidence"],
    evidenceIds: [c.id],
    attributionSpans: [],
  };
  return c;
}

export function sharedOrigin(
  c: EvidenceCandidate,
  groupId: string,
): EvidenceCandidate {
  c.reportingOrigin = {
    groupId,
    status: "shared_origin",
    basis: ["article_text_duplication"],
    evidenceIds: [c.id],
    attributionSpans: [],
  };
  return c;
}
