/**
 * Defensive selectors over the completed `InvestigationResult` payload.
 *
 * The backend owns the authoritative result detail; these selectors read
 * tolerant, commonly-named fields and degrade to explicit "unknown" states
 * when detail is absent. They never invent values.
 *
 * Exact user-facing copy for statuses comes from spec section 3.7.
 */
import { arr, asRecord, num, rec, str, type JsonRecord } from "./events";

/** Re-exported so views share one defensive-access import site. */
export { arr, asRecord, num, rec, str, type JsonRecord };
export type { JsonValue } from "./events";

/* ---------------- status copy (spec 3.7, verbatim) ---------------- */

export const STATUS_COPY: Record<string, { headline: string; support: string; note?: string }> = {
  CONTEXT_CONFLICT: {
    headline: "Context conflict found",
    support:
      "Matching occurrences from multiple source domains, with separately evidenced reporting origins, associate this image with a different context than the submitted claim.",
  },
  POSSIBLE_CONTEXT_CONFLICT: {
    headline: "Possible context conflict",
    support:
      "Matching evidence associates this image with a different context, but corroboration is limited or its reporting origins are unresolved.",
  },
  NO_CONFLICT_FOUND: {
    headline: "No conflict found in retrieved evidence",
    support: "The retrieved visual evidence did not reveal a strong contradiction to the submitted claim.",
    note: "This does not prove the claim is true.",
  },
  INSUFFICIENT_EVIDENCE: {
    headline: "Insufficient evidence",
    support:
      "The live search did not return enough qualifying visual evidence and corroboration for a reliable context comparison.",
  },
};

export const TRACE_HEADLINE = "Media history reconstructed";
export const TRACE_HEADLINE_WEAK = "Limited media history found";

export function getStatus(result: JsonRecord | null): string | null {
  if (!result) return null;
  const candidates = [
    str(result, "status"),
    str(rec(result, "verdict"), "status"),
    str(rec(result, "policy"), "status"),
    str(result, "claimStatus"),
  ];
  return candidates.find((c): c is string => c !== null) ?? null;
}

export function getMode(result: JsonRecord | null): "trace" | "claim-check" {
  if (!result) return "trace";
  if (str(result, "claim") ?? str(rec(result, "input"), "claim")) return "claim-check";
  const status = getStatus(result);
  if (status) return "claim-check";
  return "trace";
}

/* ---------------- metrics (spec 3.8, at most three) ---------------- */

export interface ResultMetrics {
  sourceDomains: number | null;
  observedContexts: number | "unresolved" | null;
  earliest: JsonRecord | null;
}

export function getMetrics(result: JsonRecord | null): ResultMetrics {
  if (!result) return { sourceDomains: null, observedContexts: null, earliest: null };
  const metrics = rec(result, "metrics");

  const sourceDomains =
    num(metrics, "sourceDomains") ?? num(result, "sourceDomains") ?? num(result, "sourceDomainCount");

  let observedContexts: ResultMetrics["observedContexts"] = null;
  // `contextSegmentCount` is the contract field; null means unresolved.
  const rawContexts =
    metrics?.["observedContexts"] ?? result["observedContexts"] ?? result["contextSegmentCount"];
  if (typeof rawContexts === "number" && Number.isFinite(rawContexts)) {
    observedContexts = rawContexts;
  } else if (typeof rawContexts === "string" && /unresolv/i.test(rawContexts)) {
    observedContexts = "unresolved";
  } else if (rawContexts == null) {
    // Absence of a comparison result is itself unresolved, not zero.
    observedContexts = "unresolved";
  }

  // The contract exposes `earliestObservedOccurrence` as an ISO date string;
  // wrap it so date selectors render it like any occurrence date.
  const earliestString =
    str(result, "earliestObservedOccurrence") ?? str(metrics, "earliestObservedOccurrence");
  const earliest =
    rec(metrics, "earliestObserved") ??
    rec(result, "earliestObserved") ??
    rec(result, "earliest") ??
    (earliestString !== null ? ({ date: earliestString } satisfies JsonRecord) : null);

  return { sourceDomains, observedContexts, earliest };
}

/* ---------------- takeaways (spec 3.9, at most three) ---------------- */

export interface Takeaway {
  text: string;
  evidenceIds: string[];
}

/** §33 — fixed copy per deterministic takeaway code. */
export const TAKEAWAY_COPY: Record<string, string> = {
  temporal_conflict:
    "Matching media was found before the date asserted in the claim.",
  location_conflict:
    "Matching media is associated with a different location in retrieved evidence.",
  historical_reuse:
    "Retrieved sources show this media being used historically before the submitted claim.",
  no_current_media_corroboration:
    "No qualifying current media corroboration was found for the submitted claim.",
};

export function getTakeaways(result: JsonRecord | null): Takeaway[] {
  if (!result) return [];
  const raw = arr(result, "takeaways") ?? arr(rec(result, "summary"), "takeaways") ?? [];
  return raw.slice(0, 3).flatMap((item) => {
    const r = asRecord(item);
    if (!r) return [];
    const text = str(r, "text") ?? (str(r, "code") ? (TAKEAWAY_COPY[str(r, "code")!] ?? null) : null);
    if (!text) return [];
    const ids = arr(r, "evidenceIds") ?? arr(r, "evidence") ?? [];
    return [
      {
        text,
        evidenceIds: ids.filter((id): id is string => typeof id === "string"),
      },
    ];
  });
}

/* ---------------- limitations (spec 3.8 "Evidence limits") ---------------- */

/** §3.8 / §29 — fixed copy for deterministic limitation codes. */
export const LIMITATION_COPY: Record<string, string> = {
  exact_match_retrieval_unavailable: "Exact-match retrieval was unavailable.",
  no_exact_occurrences_returned: "No exact occurrences were returned.",
  web_context_unavailable: "Web context search was unavailable.",
  news_unavailable: "News search was unavailable.",
  about_this_image_unavailable: "Google discontinued About This Image. This trail uses supported search results and inspected source pages; missing history remains unknown.",
  semantic_classification_unavailable: "Semantic evidence classification was unavailable.",
  semantic_classification_partial: "Semantic classification failed for some evidence.",
  reporting_origins_unresolved: "Reporting origins are unresolved for some evidence.",
  unverified_visual_leads_present: "Unverified visual leads are shown as leads only.",
  near_match_verifier_disabled: "Near-match verification is disabled; hash-only matches stay visual leads.",
  page_fetch_partial_failure: "Some source pages could not be fetched.",
  analysis_time_limit_reached: "Analysis stopped at the investigation's time limit; findings use the evidence retained before the cutoff.",
  insufficient_dated_occurrences: "Fewer than two dated core occurrences were found.",
  comparison_coverage_incomplete: "Context comparison coverage was incomplete.",
  claim_date_unresolved: "No usable date was found in the claim.",
  disputed_dates_present: "Some evidence has disputed dates.",
  unknown_dates_present: "Some evidence has unknown dates.",
};

export function getLimitations(result: JsonRecord | null): string[] {
  if (!result) return [];
  const raw = arr(result, "limitations") ?? arr(result, "evidenceLimits") ?? arr(rec(result, "summary"), "limitations") ?? [];
  return raw
    .filter((item): item is string => typeof item === "string" && item.length > 0)
    .map((item) => LIMITATION_COPY[item] ?? item);
}

/* ---------------- timeline occurrences (spec 3.11) ---------------- */

export function getTimeline(result: JsonRecord | null): { dated: JsonRecord[]; unknownDate: JsonRecord[] } {
  const empty = { dated: [] as JsonRecord[], unknownDate: [] as JsonRecord[] };
  if (!result) return empty;
  // Contract shape: `timeline` is a TimelineItem[]; `undatedEvidence` holds
  // the rest. Older/alternate shapes ({timeline:{dated}}, `occurrences`)
  // stay tolerated.
  const timelineValue = result["timeline"];
  const timelineObj = asRecord(timelineValue);
  const timelineArr = Array.isArray(timelineValue) ? timelineValue : null;
  const datedRaw =
    timelineArr ??
    (timelineObj ? arr(timelineObj, "dated") ?? arr(timelineObj, "occurrences") : null) ??
    arr(rec(result, "provenance"), "dated") ??
    arr(result, "occurrences") ??
    [];
  const unknownRaw =
    arr(result, "undatedEvidence") ??
    (timelineObj ? arr(timelineObj, "unknownDate") ?? arr(timelineObj, "dateUnknown") : null) ??
    arr(result, "unknownDateEvidence") ??
    [];

  const clean = (items: typeof datedRaw) =>
    items.map((i) => asRecord(i)).filter((i): i is JsonRecord => i !== null);

  return { dated: clean(datedRaw), unknownDate: clean(unknownRaw) };
}

export function occurrenceId(o: JsonRecord, fallback: string): string {
  return str(o, "id") ?? str(o, "occurrenceId") ?? fallback;
}

export function occurrenceDate(o: JsonRecord): string | null {
  return str(o, "date") ?? str(o, "observedAt") ?? str(o, "publishedDate") ?? str(o, "observedDate");
}

export function occurrenceDatePrecision(o: JsonRecord): string | null {
  return str(o, "datePrecision") ?? str(o, "precision");
}

export function occurrenceDateSource(o: JsonRecord): string | null {
  const raw = str(o, "dateSource") ?? str(o, "publicationDateSource") ?? str(o, "publishedAtSource");
  if (raw === null) return null;
  const labels: Record<string, string> = {
    page_json_ld: "Page structured data (JSON-LD)",
    page_meta: "Page metadata",
    page_time: "Page time element",
    serpapi: "Search result metadata",
  };
  return labels[raw] ?? raw;
}

/** Numeric result position as displayable text. */
export function occurrencePosition(o: JsonRecord): string | null {
  const s = str(o, "position") ?? str(o, "resultPosition");
  if (s !== null) return s;
  const n = num(o, "serpPosition") ?? num(o, "position");
  return n !== null ? String(n) : null;
}

export function occurrenceExcerpt(o: JsonRecord): { text: string | null; source: string | null } {
  return {
    text: str(o, "excerpt") ?? str(o, "snippet"),
    source: str(o, "excerptSource") ?? str(o, "excerptAttribution"),
  };
}

export function occurrenceImage(o: JsonRecord): string | null {
  return str(o, "imageUrl") ?? str(o, "thumbnailUrl") ?? str(o, "image");
}

/** Badge copy from spec 3.11; unknown relationships stay unlabeled, never guessed. */
export function mediaRelationshipLabel(o: JsonRecord): string | null {
  const rel = (str(o, "mediaRelationship") ?? str(o, "relationship") ?? "").toUpperCase();
  if (rel.includes("EXACT")) return "Exact match";
  if (rel.includes("NEAR")) return "Near match";
  if (rel.includes("VISUAL_LEAD") || rel.includes("LEAD")) return "Visual lead";
  return null;
}

export function contextLabel(o: JsonRecord): string | null {
  const label = (str(o, "contextLabel") ?? str(o, "context") ?? "").toUpperCase();
  if (label.includes("SAME")) return "Same context";
  if (label.includes("DIFFERENT")) return "Different context";
  if (label.includes("HISTORICAL")) return "Historical reference";
  if (label.includes("UNCLEAR") || label.includes("UNCERTAIN")) return "Unclear";
  if (label.includes("SUBMITTED") || label.includes("CLAIM")) return "Submitted claim";
  return null;
}

/** Read the additive case without changing the legacy report selectors. */
export { readCaseFromResult } from "../cases/parse";
