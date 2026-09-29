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
  engineLabel: string;
  attempted: number | null;
  returned: number | null;
  retained: number | null;
  /** §34 — the provider's own id for this attempt; null when none came back. */
  searchId: string | null;
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
    return [
      {
        engine,
        engineLabel: humanizeCode(engine),
        attempted: num(r, "attempted"),
        returned: num(r, "returned"),
        retained: num(r, "retained"),
        searchId: str(r, "searchId"),
      },
    ];
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

/**
 * Neutral group headline (R4 residual): backend reporting groups include
 * every resolved origin — shared and separately evidenced alike — so the
 * view must not hardcode "Shared". The grouping reason and member links
 * carry the specific meaning.
 */
export function reportingGroupHeadline(group: ReportingGroupView): string {
  return `Reporting group of ${group.memberCount} ${group.memberCount === 1 ? "occurrence" : "occurrences"}`;
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

/* ---------------- §34 technical inspection ----------------
 *
 * On-request technical detail over the actual typed fields: provider search
 * ids, retrieval engine, source/canonical URLs, result position, media
 * relationship, publication-date source, classification model version, the real
 * per-question probability distributions, the performed context comparisons,
 * and descriptive page metadata.
 *
 * Two rules are load-bearing here:
 *  - the distributions are the classification model's answers to fixed
 *    questions, never a confidence, accuracy or credibility figure, so they
 *    are shown per question with the question named and never summed, ranked
 *    or turned into a score;
 *  - page metadata is descriptive text copied off a page. It is returned as
 *    inert label/value text with no URL semantics at all, so a hostile
 *    `og:url` can never become navigation or markup. The only navigable source
 *    link in the product stays the separately validated source/canonical URL.
 */

const RETRIEVAL_ENGINE_COPY: Record<string, string> = {
  lens_exact: "Google Lens — exact matches",
  lens_visual: "Google Lens — visual matches",
  lens_about_image: "Google Lens — About This Image",
  google_search: "Google Search",
  google_news: "Google News",
};

const RESULT_TYPE_COPY: Record<string, string> = {
  exact_match: "Exact match collection",
  exact_matches: "Exact match collection",
  visual_match: "Visual match",
  visual_matches: "Visual match",
  about_this_image: "About This Image",
  news: "News result",
  organic: "Web result",
};

/** Readable retrieval engine; null when the payload reports none. */
export function retrievalEngineLabel(occurrence: JsonRecord): string | null {
  const kind = retrievalKindOf(occurrence);
  if (kind === null) return null;
  return RETRIEVAL_ENGINE_COPY[kind.toLowerCase()] ?? humanizeCode(kind);
}

/** Readable provider result type; null when the payload reports none. */
export function resultTypeLabel(occurrence: JsonRecord): string | null {
  const raw = str(occurrence, "resultType");
  if (raw === null) return null;
  return RESULT_TYPE_COPY[raw.toLowerCase()] ?? humanizeCode(raw);
}

/** §34 search ids actually reported for this occurrence, in retrieval order. */
export function searchIdsOf(occurrence: JsonRecord): string[] {
  const raw = arr(occurrence, "searchIds") ?? arr(occurrence, "searchId");
  const values: string[] = [];
  for (const item of raw ?? []) {
    const value = typeof item === "string" ? item : str(asRecord(item), "searchId");
    if (value && !values.includes(value)) values.push(value);
  }
  return values;
}

/** The pinned classification model version; null when never classified. */
export function jevModelOf(occurrence: JsonRecord): string | null {
  return str(occurrence, "jevModel") ?? str(occurrence, "modelVersion");
}

const MEDIA_RELATIONSHIP_COPY: Record<string, string> = {
  EXACT_MATCH: "Exact match — reported by Google Lens",
  NEAR_MATCH: "Near match — locally verified",
  VISUAL_LEAD: "Visual lead — not confirmed as the same image",
};

/** Media relationship in §34 terms; null when none was established. */
export function mediaRelationshipText(occurrence: JsonRecord): string | null {
  const raw = str(occurrence, "mediaRelationship") ?? str(occurrence, "relationship");
  if (raw !== null) {
    const known = MEDIA_RELATIONSHIP_COPY[raw.toUpperCase()];
    if (known) return known;
  }
  const identity = identityBasis(occurrence);
  if (identity) return `${identity.badge} — ${identity.basis}`;
  return raw === null ? null : humanizeCode(raw);
}

export interface DistributionOption {
  /** Option label as the fixed question defines it. */
  label: string;
  /** The model's probability for that option, 0–1, as returned. */
  value: number;
}

export interface DistributionGroup {
  /** Wire key, for tests and stable rendering. */
  id: string;
  /** What the question asks, in user words. */
  label: string;
  /** Options and their probabilities; null when the question was not answered. */
  options: DistributionOption[] | null;
  /** Honest reason the question has no answer here. */
  notAnswered: string | null;
}

const PAGE_ROLE_OPTIONS: Array<[string, string]> = [
  ["reporting", "Reporting"],
  ["factCheck", "Fact check"],
  ["socialRepost", "Social repost"],
  ["aggregator", "Aggregator"],
  ["commentary", "Commentary"],
  ["other", "Other"],
];

const CONTEXT_RELATION_OPTIONS: Array<[string, string]> = [
  ["sameContext", "Same context as the claim"],
  ["differentContext", "Different context from the claim"],
  ["historicalReference", "Historical reference"],
  ["unclear", "Not enough to tell"],
];

const CLAIM_RELATION_OPTIONS: Array<[string, string]> = [
  ["supports", "Supports what the claim says"],
  ["contradicts", "Contradicts what the claim says"],
  ["neutral", "Neither"],
  ["insufficient", "Not enough to say"],
];

const LOCATION_RELATION_OPTIONS: Array<[string, string]> = [
  ["sameLocation", "Same location"],
  ["differentLocation", "Different location"],
  ["locationNotStated", "No location stated"],
  ["unclear", "Not enough to tell"],
];

const PAIRWISE_OPTIONS: Array<[string, string]> = [
  ["sameContext", "Same underlying context"],
  ["differentContext", "Different underlying context"],
  ["unclear", "Not enough to tell"],
];

function readOptions(
  source: JsonRecord | null,
  table: Array<[string, string]>,
): DistributionOption[] | null {
  if (source === null) return null;
  const options: DistributionOption[] = [];
  for (const [key, label] of table) {
    const value = num(source, key);
    if (value === null) continue;
    options.push({ label, value });
  }
  // A present-but-empty distribution block is not an answer.
  return options.length > 0 ? options : null;
}

/** Trim a probability to its meaningful digits without inventing precision. */
function formatProbability(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export interface JevDistributionView {
  model: string | null;
  /** Relevance is a single Noul score, carried as its own group. */
  relevance: DistributionOption[] | null;
  groups: DistributionGroup[];
}

export interface DistributionContext {
  /** Claim-check mode: a claim was submitted with this investigation. */
  claimSubmitted?: boolean;
}

const NO_CLAIM = "Not asked — no claim was submitted with this investigation.";

/**
 * The verified per-question distributions for one occurrence. Absent
 * distributions (never classified, or classification unverified) yield null so
 * the caller can say so instead of showing empty bars.
 */
export function jevDistributionsOf(
  occurrence: JsonRecord,
  ctx: DistributionContext = {},
): JevDistributionView | null {
  const dist = rec(occurrence, "jevDistributions");
  if (!dist) return null;
  const claimSubmitted = ctx.claimSubmitted === true;
  const relevanceValue = num(dist, "relevance");
  const groups: DistributionGroup[] = [
    {
      id: "pageRole",
      label: "Role this page appears to play",
      options: readOptions(rec(dist, "pageRole"), PAGE_ROLE_OPTIONS),
      notAnswered: "No page-role answer was recorded for this occurrence.",
    },
    {
      id: "contextRelation",
      label: "Context relationship to your submitted claim",
      options: readOptions(rec(dist, "contextRelation"), CONTEXT_RELATION_OPTIONS),
      notAnswered: claimSubmitted
        ? "No context answer was recorded for this occurrence."
        : NO_CLAIM,
    },
    {
      id: "claimRelation",
      label: "What this source says about what the claim describes",
      options: readOptions(rec(dist, "claimRelation"), CLAIM_RELATION_OPTIONS),
      notAnswered: claimSubmitted
        ? "No claim-relation answer was recorded for this occurrence."
        : NO_CLAIM,
    },
    {
      id: "locationRelation",
      label: "Location relationship to the location in your claim",
      options: readOptions(rec(dist, "locationRelation"), LOCATION_RELATION_OPTIONS),
      notAnswered: claimSubmitted
        ? "Not asked, or not answered — the claim stated no usable location, or the page stated none."
        : NO_CLAIM,
    },
  ];
  return {
    model: jevModelOf(occurrence),
    relevance:
      relevanceValue === null
        ? null
        : [{ label: "Materially relevant to the image under investigation", value: formatProbability(relevanceValue) }],
    groups,
  };
}

/* ---------------- performed context comparisons (§14, §20, §34) ---------- */

export type ComparisonState = "same" | "different" | "uncertain" | "unexamined" | "unknown";

export interface ComparisonView {
  pairId: string;
  fromId: string;
  toId: string;
  state: ComparisonState;
  /** What the comparison found, or why it was not established. */
  label: string;
  /** The actual pairwise answer; null when the pair was not compared. */
  options: DistributionOption[] | null;
}

const COMPARISON_COPY: Record<ComparisonState, string> = {
  same: "Same context — compared",
  different: "Different context — compared",
  uncertain: "Comparison inconclusive — performed but not established",
  unexamined: "Not compared in this investigation",
  unknown: "Comparison status unknown",
};

function comparisonState(connector: string | null): ComparisonState {
  const kind = (connector ?? "").toLowerCase();
  if (kind.includes("same")) return "same";
  if (kind.includes("different")) return "different";
  if (kind.includes("uncertain") || kind.includes("ambiguous")) return "uncertain";
  if (kind.includes("unexamined") || kind.includes("uncompared") || kind.includes("skip")) {
    return "unexamined";
  }
  return "unknown";
}

/** Every evaluated comparison in the result, in displayed order. */
export function comparisonsOf(result: JsonRecord | null): ComparisonView[] {
  if (!result) return [];
  const raw = arr(result, "comparisons") ?? [];
  return raw.flatMap((item) => {
    const r = asRecord(item);
    if (!r) return [];
    const fromId = str(r, "fromOccurrenceId");
    const toId = str(r, "toOccurrenceId");
    if (!fromId || !toId) return [];
    const state = comparisonState(str(r, "connector"));
    return [
      {
        pairId: str(r, "pairId") ?? `${fromId}|${toId}`,
        fromId,
        toId,
        state,
        label: COMPARISON_COPY[state],
        options: readOptions(rec(r, "distribution"), PAIRWISE_OPTIONS),
      },
    ];
  });
}

/**
 * The comparison this occurrence actually took part in. An occurrence appears
 * in at most two pairs, so both are returned; these are comparisons between
 * retrieved occurrences, never between an occurrence and the submitted claim.
 */
export function comparisonsForOccurrence(
  result: JsonRecord | null,
  occurrenceId: string,
): ComparisonView[] {
  return comparisonsOf(result).filter(
    (c) => c.fromId === occurrenceId || c.toId === occurrenceId,
  );
}

/* ---------------- descriptive page metadata (§18.2) ----------------------
 *
 * Inert by construction: every value is a plain string carried beside its
 * property name, and nothing in this projection produces a URL, a link, or
 * markup. A `javascript:` (or any other scheme) og value is therefore shown as
 * the text it is, and can never be activated.
 */

const BINDING_COPY: Record<string, string> = {
  page_url: "bound to the fetched page URL",
  main_entity: "bound to the page's main article",
  root_entity: "bound to the page root entity",
};

export interface PageMetadataEntity {
  binding: string;
  types: string[];
  fields: Array<{ label: string; value: string }>;
}

export interface PageMetadataView {
  entities: PageMetadataEntity[];
  openGraph: Array<{ property: string; value: string }>;
}

export function pageMetadataOf(occurrence: JsonRecord): PageMetadataView | null {
  const meta = rec(occurrence, "pageMetadata");
  if (!meta) return null;
  const entities = (arr(meta, "jsonLd") ?? []).flatMap((item): PageMetadataEntity[] => {
    const e = asRecord(item);
    if (!e) return [];
    const binding = str(e, "binding");
    const types = (arr(e, "types") ?? []).filter((t): t is string => typeof t === "string");
    const authors = (arr(e, "author") ?? []).filter((a): a is string => typeof a === "string");
    const fields: Array<{ label: string; value: string }> = [];
    const push = (label: string, value: string | null) => {
      if (value !== null && value.trim().length > 0) fields.push({ label, value });
    };
    push("Type", types.length > 0 ? types.join(", ") : null);
    push("Headline", str(e, "headline"));
    push("Byline", authors.length > 0 ? authors.join(", ") : null);
    push("Publisher", str(e, "publisher"));
    push("Description", str(e, "description"));
    const hasContent = types.length > 0 || fields.length > 0;
    if (!hasContent) return [];
    return [
      {
        binding: binding ? (BINDING_COPY[binding] ?? humanizeCode(binding)) : "binding not reported",
        types,
        fields,
      },
    ];
  });
  const openGraphRaw = rec(meta, "openGraph") ?? {};
  const openGraph: Array<{ property: string; value: string }> = Object.entries(openGraphRaw)
    .filter(([property, value]) => property.length > 0 && typeof value === "string" && value.length > 0)
    .map(([property, value]) => ({ property, value: value as string }));
  if (entities.length === 0 && openGraph.length === 0) return null;
  return { entities, openGraph };
}

/* ---------------- focus restoration (F14) ----------------
 *
 * Deciding whether focus can actually go back to a recorded opener. Kept as a
 * pure predicate over the element's observable state so every rejection reason
 * is testable without a browser, and so the component never calls focus() on a
 * target that would silently swallow it.
 */

export interface FocusTargetState {
  tagName: string;
  tabIndex: number;
  isConnected: boolean;
  disabled?: boolean | null;
  /**
   * False when the element is not rendered — `display: none`, `visibility:
   * hidden`, or detached by a containing block. A hidden opener stays
   * connected and keeps its tab index, so connection and tab-index checks
   * alone accept it, and focus() on it is silently dropped, which is what
   * strands a keyboard user on <body> after closing the viewer.
   */
  rendered?: boolean;
}

export function isRestorableFocusTarget(el: FocusTargetState | null | undefined): boolean {
  if (!el) return false;
  // <body> is what focus falls back to when a node is removed. Calling
  // focus() on it is a no-op, so treating it as an opener would strand the
  // user exactly where the teardown left them.
  if (el.tagName === "BODY") return false;
  // A re-render, a tab switch or a restored result can remove the opener
  // between opening and closing the viewer.
  if (!el.isConnected) return false;
  // An opener hidden by CSS is not a place focus can return to.
  if (el.rendered === false) return false;
  // A disabled control cannot receive focus; browsers ignore the call.
  if (el.disabled === true) return false;
  // Programmatically excluded from the tab order.
  return el.tabIndex >= 0;
}

/** DOM snapshot of the restore decision, taken by the component that owns it. */
export function focusTargetState(el: HTMLElement | null): FocusTargetState | null {
  if (!el) return null;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  return {
    tagName: el.tagName,
    tabIndex: el.tabIndex,
    isConnected: el.isConnected,
    disabled: (el as HTMLButtonElement).disabled ?? null,
    rendered: el.getClientRects().length > 0 && style?.visibility !== "hidden",
  };
}

/* ---------------- provenance relationships (§23) -------------------------
 *
 * The typed graph is shown as inspectable relationships — which source domain
 * an occurrence came from, which context segment it belongs to, where a
 * segment diverges — never as a generic force-directed graph (§23).
 */

export interface ProvenanceDomain {
  domain: string;
  occurrenceIds: string[];
}

export interface ProvenanceSegment {
  index: number;
  occurrenceIds: string[];
}

export interface ProvenanceDivergence {
  pairId: string | null;
  fromId: string;
  toId: string;
  observedAt: string | null;
  firstObserved: boolean;
  earlierUnresolved: boolean;
  /** Null when that side's continuity was unresolved (never invented). */
  fromSegmentKnown: boolean;
  toSegmentKnown: boolean;
}

/**
 * One real claim/context question the verified model answered about a single
 * occurrence (§16.2, §16.4). This is a candidate-to-claim judgment and is never
 * an occurrence-to-occurrence comparison.
 */
export interface ClaimComparisonView {
  occurrenceId: string;
  question: "context_relation" | "claim_relation" | null;
  questionLabel: string;
  /** Actual per-option probabilities; empty when the question had no answer. */
  options: DistributionOption[];
  segmentKnown: boolean;
}

export interface ProvenanceClaimContext {
  claim: string;
  claimDate: string | null;
  claimDatePrecision: string | null;
  comparisons: ClaimComparisonView[];
  comparedSegmentIds: string[];
}

export interface ProvenanceView {
  domains: ProvenanceDomain[];
  segments: ProvenanceSegment[];
  divergences: ProvenanceDivergence[];
  claimContext: ProvenanceClaimContext | null;
}

const CLAIM_QUESTION_COPY: Record<string, string> = {
  context_relation: "Context of this occurrence vs. your claim",
  claim_relation: "What this occurrence says about your claim",
};

const CLAIM_QUESTION_TABLES: Record<string, Array<[string, string]>> = {
  context_relation: CONTEXT_RELATION_OPTIONS,
  claim_relation: CLAIM_RELATION_OPTIONS,
};

function claimComparisonsOf(claimContext: JsonRecord): ClaimComparisonView[] {
  return (arr(claimContext, "comparisons") ?? []).flatMap((item): ClaimComparisonView[] => {
    const r = asRecord(item);
    if (!r) return [];
    const occurrenceId = str(r, "occurrenceId");
    if (!occurrenceId) return [];
    const question = str(r, "question");
    const table = question ? CLAIM_QUESTION_TABLES[question] : undefined;
    // An absent-question record is reported as asked-but-empty rather than
    // dropped, so "no answer" is visible instead of silently missing.
    const options = table ? (readOptions(rec(r, "distribution"), table) ?? []) : [];
    return [
      {
        occurrenceId,
        question: question === "context_relation" || question === "claim_relation" ? question : null,
        questionLabel: question
          ? (CLAIM_QUESTION_COPY[question] ?? humanizeCode(question))
          : "Claim comparison question not identified",
        options,
        segmentKnown: str(r, "segmentId") !== null,
      },
    ];
  });
}

export function provenanceOf(result: JsonRecord | null): ProvenanceView | null {
  if (!result) return null;
  const graph = rec(result, "provenance");
  if (!graph) return null;
  const domains = (arr(graph, "sourceDomains") ?? []).flatMap((item): ProvenanceDomain[] => {
    const d = asRecord(item);
    const domain = d ? str(d, "domain") : null;
    if (!d || !domain) return [];
    return [
      {
        domain,
        occurrenceIds: (arr(d, "occurrenceIds") ?? []).filter(
          (x): x is string => typeof x === "string",
        ),
      },
    ];
  });
  const segments = (arr(graph, "contextSegments") ?? []).flatMap((item): ProvenanceSegment[] => {
    const s = asRecord(item);
    if (!s) return [];
    const index = num(s, "index");
    return [
      {
        index: index ?? 0,
        occurrenceIds: (arr(s, "occurrenceIds") ?? []).filter(
          (x): x is string => typeof x === "string",
        ),
      },
    ];
  });
  const divergences = (arr(graph, "divergenceEdges") ?? []).flatMap(
    (item): ProvenanceDivergence[] => {
      const e = asRecord(item);
      if (!e) return [];
      const fromId = str(e, "fromOccurrenceId");
      const toId = str(e, "toOccurrenceId");
      if (!fromId || !toId) return [];
      return [
        {
          pairId: str(e, "pairId"),
          fromId,
          toId,
          observedAt: str(e, "observedAt"),
          firstObserved: e["firstObserved"] === true,
          earlierUnresolved: e["earlierTransitionsUnresolved"] === true,
          fromSegmentKnown: str(e, "fromSegmentId") !== null,
          toSegmentKnown: str(e, "toSegmentId") !== null,
        },
      ];
    },
  );
  const cc = rec(graph, "claimContext");
  const claim = cc ? str(cc, "claim") : null;
  const claimContext: ProvenanceClaimContext | null =
    cc && claim
      ? {
          claim,
          claimDate: str(cc, "claimDate"),
          claimDatePrecision: str(cc, "claimDatePrecision"),
          comparisons: claimComparisonsOf(cc),
          comparedSegmentIds: (arr(cc, "comparedSegmentIds") ?? []).filter(
            (x): x is string => typeof x === "string",
          ),
        }
      : null;
  return { domains, segments, divergences, claimContext };
}

/**
 * The real claim/context questions answered about one occurrence. A single
 * dated candidate can have a claim comparison and no adjacent pair at all, so
 * this is reported independently of {@link comparisonsForOccurrence}.
 */
export function claimComparisonsFor(
  result: JsonRecord | null,
  occurrenceId: string,
): ClaimComparisonView[] {
  const graph = provenanceOf(result);
  if (!graph?.claimContext) return [];
  return graph.claimContext.comparisons.filter((c) => c.occurrenceId === occurrenceId);
}
