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
  const rawContexts = metrics?.["observedContexts"] ?? result["observedContexts"];
  if (typeof rawContexts === "number" && Number.isFinite(rawContexts)) {
    observedContexts = rawContexts;
  } else if (typeof rawContexts === "string" && /unresolv/i.test(rawContexts)) {
    observedContexts = "unresolved";
  } else if (rawContexts == null) {
    // Absence of a comparison result is itself unresolved, not zero.
    observedContexts = "unresolved";
  }

  const earliest =
    rec(metrics, "earliestObserved") ??
    rec(result, "earliestObserved") ??
    rec(result, "earliest") ??
    null;

  return { sourceDomains, observedContexts, earliest };
}

/* ---------------- takeaways (spec 3.9, at most three) ---------------- */

export interface Takeaway {
  text: string;
  evidenceIds: string[];
}

export function getTakeaways(result: JsonRecord | null): Takeaway[] {
  if (!result) return [];
  const raw = arr(result, "takeaways") ?? arr(rec(result, "summary"), "takeaways") ?? [];
  return raw.slice(0, 3).flatMap((item) => {
    const r = asRecord(item);
    if (!r) return [];
    const text = str(r, "text");
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

export function getLimitations(result: JsonRecord | null): string[] {
  if (!result) return [];
  const raw = arr(result, "limitations") ?? arr(result, "evidenceLimits") ?? arr(rec(result, "summary"), "limitations") ?? [];
  return raw.filter((item): item is string => typeof item === "string" && item.length > 0);
}

/* ---------------- timeline occurrences (spec 3.11) ---------------- */

export function getTimeline(result: JsonRecord | null): { dated: JsonRecord[]; unknownDate: JsonRecord[] } {
  const empty = { dated: [] as JsonRecord[], unknownDate: [] as JsonRecord[] };
  if (!result) return empty;
  const timeline = rec(result, "timeline") ?? rec(result, "provenance");
  const datedRaw = (timeline ? arr(timeline, "dated") ?? arr(timeline, "occurrences") : null) ?? arr(result, "occurrences") ?? [];
  const unknownRaw = (timeline ? arr(timeline, "unknownDate") ?? arr(timeline, "dateUnknown") : null) ?? arr(result, "unknownDateEvidence") ?? [];

  const clean = (items: typeof datedRaw) =>
    items.map((i) => asRecord(i)).filter((i): i is JsonRecord => i !== null);

  return { dated: clean(datedRaw), unknownDate: clean(unknownRaw) };
}

export function occurrenceId(o: JsonRecord, fallback: string): string {
  return str(o, "id") ?? fallback;
}

export function occurrenceDate(o: JsonRecord): string | null {
  return str(o, "date") ?? str(o, "publishedDate") ?? str(o, "observedDate");
}

export function occurrenceDatePrecision(o: JsonRecord): string | null {
  return str(o, "datePrecision") ?? str(o, "precision");
}

export function occurrenceDateSource(o: JsonRecord): string | null {
  return str(o, "dateSource") ?? str(o, "publicationDateSource");
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
