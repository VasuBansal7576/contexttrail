/**
 * Candidate normalization, deduplication, and retention (spec §11, §14).
 *
 * - URL dedupe merges repeated retrievals of one canonical URL into a single
 *   candidate, preserving every retrieval record and the strongest identity
 *   evidence instead of picking a winner silently.
 * - Per-kind retention caps apply before classification.
 * - MAX_JEV_CANDIDATES selection prefers exact visual evidence, dated
 *   evidence, distinct source domains/reporting origins, then SERP rank.
 */

import type {
  EvidenceCandidate,
  RetrievalKind,
} from "./contracts/evidence";
import {
  MAX_JEV_CANDIDATES,
  RETENTION_CAPS,
} from "./limits";
import { isCoreOccurrence } from "./identity";

const KIND_PRIORITY: Record<RetrievalKind, number> = {
  lens_exact: 0,
  lens_visual: 1,
  lens_about_image: 2,
  google_search: 3,
  google_news: 4,
};

const REL_STRENGTH: Record<string, number> = {
  EXACT_MATCH: 3,
  NEAR_MATCH: 2,
  VISUAL_LEAD: 1,
};

function relStrength(c: EvidenceCandidate): number {
  return REL_STRENGTH[c.mediaRelationship ?? ""] ?? 0;
}

function serpRank(c: EvidenceCandidate): number {
  return c.serpPosition ?? Number.MAX_SAFE_INTEGER;
}

function hasUsableDate(c: EvidenceCandidate): boolean {
  return c.dateStatus === "usable" && c.publishedAt !== null;
}

/** Merge duplicate retrievals of one canonical URL into `base`. */
function mergeInto(base: EvidenceCandidate, other: EvidenceCandidate): void {
  const seen = new Set(
    base.retrievals.map((r) => `${r.kind}|${r.searchId ?? ""}|${r.resultType}`),
  );
  for (const r of other.retrievals) {
    const key = `${r.kind}|${r.searchId ?? ""}|${r.resultType}`;
    if (!seen.has(key)) {
      base.retrievals.push(r);
      seen.add(key);
    }
  }
  // Keep the strongest media relationship + its identity evidence.
  if (relStrength(other) > relStrength(base)) {
    base.mediaRelationship = other.mediaRelationship;
    base.identityEvidence = other.identityEvidence;
  }
  // Fill gaps, never overwrite real values with null.
  base.title ??= other.title;
  base.snippet ??= other.snippet;
  base.serpPosition ??= other.serpPosition;
  base.serpSearchId ??= other.serpSearchId;
  base.publishedAt ??= other.publishedAt;
  base.publishedAtSource ??= other.publishedAtSource;
  base.thumbnailUrl ??= other.thumbnailUrl;
  base.resultImageUrl ??= other.resultImageUrl;
  base.pageText ??= other.pageText;
  base.judgment ??= other.judgment;
  base.excerptSource ??= other.excerptSource;
  if (base.dateStatus === "unknown" && other.dateStatus !== "unknown") {
    base.dateStatus = other.dateStatus;
    base.datePrecision = other.datePrecision;
  }
}

/**
 * Deduplicate candidates by canonical URL. Order-stable: the first-seen
 * candidate for each URL is the merge base, so higher-priority retrieval
 * kinds win ties when they arrive first.
 */
export function dedupeByCanonicalUrl(
  candidates: readonly EvidenceCandidate[],
): EvidenceCandidate[] {
  const byUrl = new Map<string, EvidenceCandidate>();
  for (const c of candidates) {
    const existing = byUrl.get(c.canonicalUrl);
    if (existing === undefined) {
      byUrl.set(c.canonicalUrl, c);
    } else {
      mergeInto(existing, c);
    }
  }
  return [...byUrl.values()];
}

/**
 * §14 — retain at most the per-kind caps before classification:
 * exact 8, visual 8, about 5, search 5, news 5. Keeps best SERP positions.
 */
export function applyRetentionCaps(
  candidates: readonly EvidenceCandidate[],
): EvidenceCandidate[] {
  const kept: EvidenceCandidate[] = [];
  for (const kind of Object.keys(RETENTION_CAPS) as RetrievalKind[]) {
    const cap = RETENTION_CAPS[kind];
    const ofKind = candidates
      .filter((c) => c.retrievalKind === kind)
      .sort(
        (a, b) =>
          serpRank(a) - serpRank(b) || a.id.localeCompare(b.id),
      );
    kept.push(...ofKind.slice(0, cap));
  }
  return kept;
}

function preferenceKey(c: EvidenceCandidate): string {
  // exact visual evidence > dated > earlier SERP rank > stable id
  const exact = isCoreOccurrence(c) ? 0 : 1;
  const dated = hasUsableDate(c) ? 0 : 1;
  return `${exact}${dated}${String(serpRank(c)).padStart(8, "0")}|${c.id}`;
}

/**
 * §14 — choose up to `max` (default MAX_JEV_CANDIDATES=24) candidates for
 * classification. Preference: exact visual evidence, dated evidence,
 * distinct source domains/reporting origins, earlier SERP rank.
 *
 * Deterministic two-phase selection: first take the best candidate from
 * each registrable domain, then fill remaining slots by raw preference.
 */
export function selectForClassification(
  candidates: readonly EvidenceCandidate[],
  max = MAX_JEV_CANDIDATES,
): EvidenceCandidate[] {
  const sorted = [...candidates].sort((a, b) =>
    preferenceKey(a) < preferenceKey(b)
      ? -1
      : preferenceKey(a) > preferenceKey(b)
        ? 1
        : 0,
  );
  const selected: EvidenceCandidate[] = [];
  const seenDomains = new Set<string>();
  const deferred: EvidenceCandidate[] = [];

  for (const c of sorted) {
    if (!seenDomains.has(c.registrableDomain)) {
      selected.push(c);
      seenDomains.add(c.registrableDomain);
    } else {
      deferred.push(c);
    }
    if (selected.length >= max) break;
  }
  for (const c of deferred) {
    if (selected.length >= max) break;
    selected.push(c);
  }
  return selected.slice(0, max);
}
