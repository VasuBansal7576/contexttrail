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

import { arr, asRecord, num, rec, str, type JsonRecord } from "@/lib/stream/result-view";

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
      label: "Same context as previous · compared",
      tone: "ok",
      fromId,
    };
  }
  if (kind.includes("different")) {
    return {
      kind: "different",
      dashed: false,
      label: "Different context from previous · compared",
      tone: "conflict",
      fromId,
    };
  }
  if (kind.includes("uncertain") || kind.includes("ambiguous") || kind.includes("fail")) {
    return {
      kind: "uncertain",
      dashed: true,
      label: "Comparison inconclusive — performed but not established",
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

export interface ViewerEntry {
  note: string | null;
  pairId: string | null;
}

/**
 * Derive the viewer's pair state from the CURRENT occurrence ID (U3): the
 * note and paired endpoint follow every navigation and clear outside the
 * divergence endpoints, so ordinary Previous/Next never shows stale pair
 * attribution.
 */
export function viewerEntryFor(id: string, endpoints: DivergenceEndpoints | null): ViewerEntry {
  if (!endpoints) return { note: null, pairId: null };
  if (id === endpoints.toId) {
    return {
      note: "Observed divergence pair — later occurrence (first observed divergence).",
      pairId: endpoints.fromId,
    };
  }
  if (id === endpoints.fromId) {
    return {
      note: "Observed divergence pair — earlier occurrence.",
      pairId: endpoints.toId,
    };
  }
  return { note: null, pairId: null };
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
  // Occurrence counts are not pair counts: "3 pairs compared across 4
  // selected of 5 eligible occurrences", never "3 of 4 pairs".
  if (compared !== null && selected !== null) {
    const pairs = `${compared} ${compared === 1 ? "pair" : "pairs"} compared`;
    if (eligible !== null) {
      return `${pairs} across ${selected} selected of ${eligible} eligible occurrences`;
    }
    return `${pairs} across ${selected} selected occurrences`;
  }
  const parts: string[] = [];
  if (compared !== null) {
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

/**
 * Retrieval kinds that never carry visual identity. Read from the actual
 * contract: streamed candidates expose `retrievalKind`, final timeline rows
 * expose `engine` holding the same kind values. About This Image retrieval
 * is explicitly contextual per backend normalization.
 */
const CONTEXTUAL_KINDS = new Set(["google_search", "google_news", "lens_about_image"]);

export function retrievalKindOf(occurrence: JsonRecord): string | null {
  return str(occurrence, "retrievalKind") ?? str(occurrence, "engine");
}

export function isContextualKind(kind: string | null): boolean {
  return kind !== null && CONTEXTUAL_KINDS.has(kind.toLowerCase());
}

/**
 * Inspector identity basis: streamed candidates nest it under
 * `identityEvidence`, final rows flatten it as `identityBasis` (additive
 * contract). `contextual` means never claimed as a media sighting.
 */
export function identityBasisOf(occurrence: JsonRecord): string | null {
  return str(rec(occurrence, "identityEvidence"), "basis") ?? str(occurrence, "identityBasis");
}

/**
 * Arriving-evidence label for the investigation progress view (U6/R2):
 * contextual identity basis or a contextual retrieval kind is a contextual
 * result, never a visual lead. Real streamed candidates carry
 * `retrievalKind` and no `engine` — engine sniffing would miss them.
 * Lens candidates without identity yet stay conservative leads.
 */
export function progressRelationshipNote(evidence: JsonRecord): {
  label: string;
  tone: "info" | "neutral";
} {
  const rel = (str(evidence, "mediaRelationship") ?? str(evidence, "relationship") ?? "").toUpperCase();
  if (rel.includes("EXACT")) return { label: "Exact match · reported by Google Lens", tone: "info" };
  if (rel.includes("NEAR")) return { label: "Near match · locally verified", tone: "info" };
  if (
    !rel &&
    (identityBasisOf(evidence) === "contextual" || isContextualKind(retrievalKindOf(evidence)))
  ) {
    return { label: "Contextual result · not same-media evidence", tone: "neutral" };
  }
  return { label: "Visual lead · not verified", tone: "neutral" };
}

/**
 * Core occurrences, visual leads and contextual results stay visibly apart,
 * independent of chronological grouping: the backend's explicit group wins,
 * otherwise a null identity on a search/news engine is contextual, and any
 * other unverified candidate stays a visual lead.
 */
/**
 * Core occurrences, visual leads and contextual results stay visibly apart,
 * independent of chronological grouping (U6/R2). Identity basis wins, then
 * the actual retrieval kind (`retrievalKind` on streamed shapes, `engine`
 * on final timeline rows — same kind values), then the backend's explicit
 * group. Any other unverified candidate stays a lead.
 */
export function occurrenceRole(
  occurrence: JsonRecord,
  group: "dated" | "supporting" | "contextual" | "unknown" | null = null,
): string | null {
  const rel = (str(occurrence, "mediaRelationship") ?? str(occurrence, "relationship") ?? "").toUpperCase();
  if (rel.includes("EXACT") || rel.includes("NEAR")) return "Core occurrence";
  if (rel.includes("VISUAL_LEAD") || rel.includes("LEAD")) return "Visual lead";
  if (rel !== "") return "Contextual result";
  if (
    identityBasisOf(occurrence) === "contextual" ||
    isContextualKind(retrievalKindOf(occurrence)) ||
    group === "contextual"
  ) {
    return "Contextual result";
  }
  return "Visual lead";
}

export function reportingOriginLabel(occurrence: JsonRecord): string {
  const status = (
    str(occurrence, "reportingOriginStatus") ??
    str(occurrence, "reportingOrigin") ??
    ""
  ).toLowerCase();
  return originStatusLabel(status);
}

/** Readable origin status from a raw status value (flat or additive). */
export function originStatusLabel(status: string | null): string {
  const s = (status ?? "").toLowerCase();
  if (s.includes("separate") && s.includes("evidenced")) {
    return "Separately evidenced reporting origin.";
  }
  if (s.includes("shared")) {
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
  if (title === null && snippet === null) {
    // A bare "Title:" line with nothing extracted behind it is not an
    // excerpt — the title already heads the card.
    const bareTitle = raw.match(/^Title:([^\n]*)$/);
    if (bareTitle) return { title: bareTitle[1].trim() || null, snippet: null, body: null };
    return { title: null, snippet: null, body: raw };
  }
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

/* ---------------- typed inspection contract (R4) ----------------
 *
 * Reads the additive backend payload (requestLog, policyReasons,
 * identity/date/origin provenance, display attribution, comparison
 * selection) with honest absence: a missing block yields null and the
 * views render their existing fallbacks, never guesses.
 */

/** Deterministic codes shown transparently, never as wire tokens. */
export function humanizeCode(code: string): string {
  const words = code.replace(/[_-]+/g, " ").trim();
  return words.length > 0 ? words.charAt(0).toUpperCase() + words.slice(1) : code;
}

export interface RequestLogEntry {
  engine: string;
  attempted: number | null;
  returned: number | null;
  retained: number | null;
}

export function getRequestLog(result: JsonRecord | null): RequestLogEntry[] | null {
  if (!result) return null;
  const raw = arr(result, "requestLog");
  if (!raw) return null;
  return raw.flatMap((item) => {
    const r = asRecord(item);
    if (!r) return [];
    const engine = str(r, "engine");
    if (!engine) return [];
    return [{ engine, attempted: num(r, "attempted"), returned: num(r, "returned"), retained: num(r, "retained") }];
  });
}

export interface PolicyReasonView {
  gate: string;
  gateLabel: string;
  passed: boolean;
  detail: string | null;
  supportIds: string[];
}

export function getPolicyReasons(result: JsonRecord | null): PolicyReasonView[] {
  if (!result) return [];
  const raw = arr(result, "policyReasons") ?? [];
  return raw.flatMap((item) => {
    const r = asRecord(item);
    if (!r) return [];
    const gate = str(r, "gate");
    if (!gate) return [];
    const ids = arr(r, "supportIds") ?? [];
    return [
      {
        gate,
        gateLabel: humanizeCode(gate),
        passed: r["passed"] === true,
        detail: str(r, "detail"),
        supportIds: ids.filter((id): id is string => typeof id === "string"),
      },
    ];
  });
}

export function getStatusBasis(result: JsonRecord | null): string[] {
  if (!result) return [];
  const raw = arr(result, "statusBasis") ?? [];
  return raw.filter((b): b is string => typeof b === "string" && b.length > 0).map(humanizeCode);
}

export interface ReportingGroupView {
  groupId: string;
  memberCount: number;
  memberIds: string[];
  reasons: string[];
}

export function getReportingGroups(result: JsonRecord | null): ReportingGroupView[] {
  if (!result) return [];
  const raw = arr(result, "reportingGroups") ?? [];
  return raw.flatMap((item) => {
    const r = asRecord(item);
    if (!r) return [];
    const groupId = str(r, "groupId");
    if (!groupId) return [];
    const memberIds = (arr(r, "memberIds") ?? []).filter(
      (id): id is string => typeof id === "string",
    );
    const reasons = (arr(r, "reason") ?? [])
      .filter((x): x is string => typeof x === "string")
      .map(humanizeCode);
    return [{ groupId, memberCount: memberIds.length, memberIds, reasons }];
  });
}

export function getUnresolvedCandidateIds(result: JsonRecord | null): string[] {
  if (!result) return [];
  const raw = arr(result, "unresolvedCandidateIds") ?? [];
  return raw.filter((id): id is string => typeof id === "string");
}

const IDENTITY_METHOD_COPY: Record<string, string> = {
  lens_exact_collection: "Reported by Google Lens",
  local_spatial_verification: "Locally verified",
  unverified: "Not confirmed",
  contextual: "Contextual evidence",
};

export function identityMethodLabel(method: string | null): string | null {
  if (!method) return null;
  return IDENTITY_METHOD_COPY[method] ?? humanizeCode(method);
}

export interface IdentityDetail {
  methodLabel: string | null;
  supportId: string | null;
}

export function identityBasisDetailOf(occurrence: JsonRecord): IdentityDetail | null {
  const detail = rec(occurrence, "identityBasisDetail");
  if (!detail) return null;
  const method = str(detail, "method") ?? identityBasisOf(occurrence);
  if (method === null && str(detail, "supportId") === null) return null;
  return { methodLabel: identityMethodLabel(method), supportId: str(detail, "supportId") };
}

const ENTITY_BINDING_COPY: Record<string, string> = {
  main_entity: "Bound to the page's main article",
  page_url: "Bound to the fetched page URL",
  root_entity: "Bound to the page root entity",
};

export interface DateProvenance {
  value: string | null;
  precision: string | null;
  sourceLabel: string | null;
  entityBinding: string | null;
  rejected: Array<{ value: string; reason: string }>;
}

export function dateProvenanceOf(occurrence: JsonRecord): DateProvenance | null {
  const d = rec(occurrence, "dateProvenance");
  if (!d) return null;
  const rejected =
    arr(d, "rejectedCandidates")
      ?.flatMap((item) => {
        const r = asRecord(item);
        if (!r) return [];
        const value = str(r, "value");
        if (!value) return [];
        return [{ value, reason: str(r, "reason") ?? "no reason reported" }];
      }) ?? [];
  const binding = str(d, "entityBinding");
  return {
    value: str(d, "value"),
    precision: str(d, "precision"),
    sourceLabel: dateSourceLabel(str(d, "source")),
    entityBinding: binding ? (ENTITY_BINDING_COPY[binding] ?? humanizeCode(binding)) : null,
    rejected,
  };
}

export interface OriginSupport {
  status: string | null;
  groupId: string | null;
  spans: Array<{ text: string; relation: string }>;
  reasons: string[];
}

export function originSupportOf(occurrence: JsonRecord): OriginSupport | null {
  const o = rec(occurrence, "originSupport");
  if (!o) return null;
  const spans =
    arr(o, "attributionSpans")
      ?.flatMap((item) => {
        const r = asRecord(item);
        if (!r) return [];
        const text = str(r, "text");
        if (!text) return [];
        return [{ text, relation: str(r, "relation") ?? "supporting" }];
      }) ?? [];
  const reasons = (arr(o, "groupingReason") ?? [])
    .filter((x): x is string => typeof x === "string")
    .map(humanizeCode);
  const status = str(o, "status");
  if (status === null && spans.length === 0 && reasons.length === 0 && str(o, "groupId") === null) {
    return null;
  }
  return { status, groupId: str(o, "groupId"), spans, reasons };
}

/** Backend-supplied readable excerpt attribution; null falls back to mapping. */
export function displayAttributionOf(occurrence: JsonRecord): string | null {
  return str(occurrence, "displayAttribution");
}

/** Whether the item entered the compared run; null when unreported. */
export function comparisonSelected(occurrence: JsonRecord): boolean | null {
  const c = rec(occurrence, "comparisonSelection");
  if (!c) return null;
  if (typeof c["selected"] !== "boolean") return null;
  return c["selected"];
}
