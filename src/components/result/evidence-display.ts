/**
 * Frontend display projection over the backend-owned result contract.
 *
 * Screens 4–6 (F04 / F12 / F13). Reads only fields the backend actually
 * sent and renders them as user-readable copy:
 * - connector states (continuous / divergent / uncertain / unexamined),
 * - comparison coverage and divergence endpoints,
 * - identity basis, date provenance and reporting-origin status,
 * - short attributable excerpt spans (never wire tokens, never the raw
 *   composite classification context as a quotation).
 *
 * Nothing here invents values. Absent detail renders as an explicit
 * unknown, never a guess. Field-shape changes belong to the backend-owned
 * `src/lib` contract; this module is the frontend projection of it.
 */
"use client";

import { num, rec, str, type JsonRecord } from "@/lib/stream/result-view";

/* ---------------- connectors (F04) ---------------- */

export type ConnectorKind =
  | "start"
  | "same"
  | "different"
  | "uncertain"
  | "unexamined"
  | "unknown";

export interface ConnectorInfo {
  kind: ConnectorKind;
  /** Dashed edge for uncertain / unexamined relationships. */
  dashed: boolean;
  /** Required visible text for the edge; null for the timeline start. */
  label: string | null;
  tone: "ok" | "conflict" | "neutral";
  fromId: string | null;
}

/** Backend `incomingConnector.kind` values, tolerated case-insensitively. */
export function connectorInfo(occurrence: JsonRecord): ConnectorInfo {
  const raw = rec(occurrence, "incomingConnector");
  const kind = (str(raw, "kind") ?? "").toLowerCase();
  const fromId = str(raw, "fromOccurrenceId");
  if (kind === "start" || kind === "") {
    return { kind: "start", dashed: false, label: null, tone: "neutral", fromId };
  }
  if (kind.includes("same")) {
    return {
      kind: "same",
      dashed: false,
      label: "Same context · compared",
      tone: "ok",
      fromId,
    };
  }
  if (kind.includes("different")) {
    return {
      kind: "different",
      dashed: false,
      label: "Different context · compared",
      tone: "conflict",
      fromId,
    };
  }
  if (kind.includes("uncertain") || kind.includes("ambiguous") || kind.includes("fail")) {
    return {
      kind: "uncertain",
      dashed: true,
      label: "Context uncertain — not directly compared",
      tone: "neutral",
      fromId,
    };
  }
  if (kind.includes("unexamined") || kind.includes("uncompared") || kind.includes("not_compared") || kind.includes("skip")) {
    return {
      kind: "unexamined",
      dashed: true,
      label: "Not compared in this investigation",
      tone: "neutral",
      fromId,
    };
  }
  return {
    kind: "unknown",
    dashed: true,
    label: "Comparison status unknown",
    tone: "neutral",
    fromId,
  };
}

export function isDivergencePoint(occurrence: JsonRecord): boolean {
  return occurrence["isFirstObservedDivergencePoint"] === true;
}

export interface DivergenceEndpoints {
  fromId: string;
  toId: string;
  earlierUnresolved: boolean;
  observedAt: string | null;
}

export function divergenceEndpoints(result: JsonRecord | null): DivergenceEndpoints | null {
  if (!result) return null;
  const d = rec(result, "divergence") ?? rec(result, "firstObservedContextDivergence");
  if (!d) return null;
  const fromId = str(d, "fromOccurrenceId");
  const toId = str(d, "toOccurrenceId");
  if (!fromId || !toId) return null;
  return {
    fromId,
    toId,
    earlierUnresolved: d["earlierTransitionsUnresolved"] === true,
    observedAt: str(d, "observedAt"),
  };
}

export function comparisonCoverageText(result: JsonRecord | null): string | null {
  if (!result) return null;
  const coverage = rec(result, "comparisonCoverage");
  if (!coverage) return null;
  const eligible = num(coverage, "eligible");
  const selected = num(coverage, "selected");
  const compared = num(coverage, "comparedPairs") ?? num(coverage, "compared");
  if (eligible === null && selected === null && compared === null) return null;
  if (eligible === 0 && selected === 0 && (compared === 0 || compared === null)) {
    return "No occurrences were selected for context comparison";
  }
  const parts: string[] = [];
  if (compared !== null && selected !== null) {
    parts.push(`${compared} of ${selected} selected pairs compared`);
  } else if (compared !== null) {
    parts.push(`${compared} ${compared === 1 ? "pair" : "pairs"} compared`);
  } else if (selected !== null) {
    parts.push(`${selected} selected for comparison`);
  }
  if (eligible !== null) parts.push(`${eligible} eligible occurrences`);
  if (parts.length === 0) return null;
  return parts.join(" · ");
}

/* ---------------- identity / role / provenance (F12) ---------------- */

export interface IdentityBasis {
  badge: string;
  /** User-meaning basis; never implementation jargon. */
  basis: string;
}

export function identityBasis(occurrence: JsonRecord): IdentityBasis | null {
  const rel = (str(occurrence, "mediaRelationship") ?? str(occurrence, "relationship") ?? "").toUpperCase();
  if (rel.includes("EXACT")) {
    return { badge: "Exact match", basis: "Reported by Google Lens" };
  }
  if (rel.includes("NEAR")) {
    return { badge: "Near match", basis: "Locally verified near match" };
  }
  if (rel.includes("VISUAL_LEAD") || rel.includes("LEAD")) {
    return { badge: "Visual lead", basis: "Not confirmed as the same image" };
  }
  return null;
}

/** Core occurrences, visual leads and contextual results stay visibly apart. */
export function occurrenceRole(
  occurrence: JsonRecord,
  group: "dated" | "supporting" | "contextual" | "unknown" | null = null,
): string | null {
  const rel = (str(occurrence, "mediaRelationship") ?? str(occurrence, "relationship") ?? "").toUpperCase();
  if (rel.includes("EXACT") || rel.includes("NEAR")) return "Core occurrence";
  if (rel.includes("VISUAL_LEAD") || rel.includes("LEAD")) return "Visual lead";
  if (rel !== "") return "Contextual result";
  // The contract leaves mediaRelationship null for contextual web/news
  // evidence; only that group may claim the contextual label.
  if (group === "contextual") return "Contextual result";
  return null;
}

export function reportingOriginLabel(occurrence: JsonRecord): string {
  const status = (
    str(occurrence, "reportingOriginStatus") ??
    str(occurrence, "reportingOrigin") ??
    ""
  ).toLowerCase();
  if (status.includes("separate") && status.includes("evidenced")) {
    return "Separately evidenced reporting origin.";
  }
  if (status.includes("shared")) {
    return "Shared reporting origin.";
  }
  return "Reporting origin unresolved.";
}

export function dateSourceLabel(source: string | null): string | null {
  if (!source) return null;
  const labels: Record<string, string> = {
    page_json_ld: "Page structured data",
    page_meta: "Page metadata",
    page_time: "Page time element",
    serpapi: "Search result metadata",
    search_metadata: "Search result metadata",
  };
  return labels[source] ?? labels[source.toLowerCase()] ?? null;
}

export function dateStatusNote(occurrence: JsonRecord): string | null {
  const status = (str(occurrence, "dateStatus") ?? "").toLowerCase();
  if (status.includes("dispute")) return "The retrieved dates for this occurrence disagree.";
  if (status.includes("unknown") || status === "") return null;
  return null;
}

/* ---------------- excerpts (F13) ---------------- */

export type ExcerptAttribution = "Search snippet" | "Extracted page excerpt";

export function excerptAttribution(source: string | null): ExcerptAttribution {
  return source === "page_text" ? "Extracted page excerpt" : "Search snippet";
}

export interface CompositeExcerpt {
  title: string | null;
  snippet: string | null;
  /** Genuine page-body span; null when only title/snippet exist. */
  body: string | null;
}

/**
 * Split the backend's composite page excerpt into its attributed parts. The
 * composite packs "Title:", "Snippet:" and body paragraphs in varying
 * combinations, all labeled `page_text` upstream; only genuine body text
 * earns extracted-page attribution, and the title wrapper is never quoted
 * (the title already heads the card).
 */
export function splitCompositeExcerpt(raw: string | null): CompositeExcerpt {
  const empty = { title: null, snippet: null, body: null };
  if (!raw) return empty;
  let rest = raw;
  let title: string | null = null;
  let snippet: string | null = null;
  const titleMatch = rest.match(/^Title:([^\n]*)\r?\n\r?\n([\s\S]*)$/);
  if (titleMatch) {
    title = titleMatch[1].trim() || null;
    rest = titleMatch[2];
  }
  const snippetMatch = rest.match(/^Snippet:([\s\S]*?)\r?\n\r?\n([\s\S]*)$/);
  if (snippetMatch) {
    snippet = snippetMatch[1].trim() || null;
    rest = snippetMatch[2];
  } else {
    const bareSnippet = rest.match(/^Snippet:([\s\S]*)$/);
    if (bareSnippet) {
      snippet = bareSnippet[1].trim() || null;
      rest = "";
    }
  }
  const body = rest.trim() || null;
  if (title === null && snippet === null) return { title: null, snippet: null, body: raw };
  return { title, snippet, body };
}

export interface AttributableSpan {
  /** One genuine quoted span — never the composite wrapper, never wire tokens. */
  text: string;
  attribution: ExcerptAttribution;
  /** True when the span was shortened and the viewer carries the full text. */
  truncated: boolean;
}

function truncateWords(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const cut = text.lastIndexOf(" ", maxChars);
  const end = cut > maxChars * 0.5 ? cut : maxChars;
  return { text: `${text.slice(0, end).trimEnd()}…`, truncated: true };
}

/**
 * The single quotable span for an occurrence: the first genuine page-body
 * paragraph for extracted page text, otherwise the search snippet text.
 * A page with no extracted body never inherits page-text attribution: a
 * bare "Title:" wrapper is not an excerpt (the title already heads the
 * card), while an embedded snippet is quoted as what it is — a snippet.
 */
export function attributableSpan(occurrence: JsonRecord, maxChars = 280): AttributableSpan | null {
  const raw = str(occurrence, "excerpt") ?? str(occurrence, "snippet");
  const source = str(occurrence, "excerptSource") ?? str(occurrence, "excerptAttribution");
  if (!raw) return null;
  if (source === "page_text") {
    const { body, snippet } = splitCompositeExcerpt(raw);
    if (body) {
      const firstParagraph = body.split(/\r?\n\r?\n/)[0].trim() || body;
      const { text, truncated } = truncateWords(firstParagraph, maxChars);
      return {
        text,
        attribution: "Extracted page excerpt",
        truncated: truncated || body.length > firstParagraph.length,
      };
    }
    if (snippet) {
      const { text, truncated } = truncateWords(snippet, maxChars);
      if (!text) return null;
      return { text, attribution: "Search snippet", truncated };
    }
    return null;
  }
  const { text, truncated } = truncateWords(raw.trim(), maxChars);
  if (!text) return null;
  return { text, attribution: excerptAttribution(source), truncated };
}

/** Full retrievable text behind the span, for viewer expansion. */
export function fullExcerptText(occurrence: JsonRecord): string | null {
  const raw = str(occurrence, "excerpt") ?? str(occurrence, "snippet");
  if (!raw) return null;
  const source = str(occurrence, "excerptSource") ?? str(occurrence, "excerptAttribution");
  if (source === "page_text") {
    const { body, snippet } = splitCompositeExcerpt(raw);
    return body ?? snippet;
  }
  return raw.trim() || null;
}

/* ---------------- analysis support (F12) ---------------- */

export function reportingCounts(result: JsonRecord | null): {
  groups: number | null;
  unresolved: number | null;
} {
  if (!result) return { groups: null, unresolved: null };
  return {
    groups: num(result, "reportingGroupCount"),
    unresolved: num(result, "unresolvedOriginCount"),
  };
}
