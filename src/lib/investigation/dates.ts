/**
 * Date policy (spec §19). Dates belong to deterministic code.
 *
 * Rules implemented:
 * - §19.1 claim date via chrono-node against the investigation start
 *   timestamp + browser timezone; none or materially ambiguous -> null.
 * - §19.2 evidence date precedence: page_json_ld > page_meta > page_time >
 *   serpapi; material disagreement -> null unless the winner is clearly the
 *   page's structured publication field.
 * - §19.3 PREDATES_CLAIM only when publishedAt < claimDate - 24h; coarser
 *   precisions must *entirely* predate the window (conservative).
 * - §11 invariant: a month-only or year-only source date is never turned
 *   into an asserted publication day; unknown/disputed stay that way.
 *
 * Requires the `chrono-node` package — see src/lib/investigation/README.md.
 */

import * as chrono from "chrono-node";
import type {
  DatePrecision,
  DateStatus,
  PublishedAtSource,
} from "./contracts/evidence";
import { TEMPORAL_CONFLICT_BUFFER_MS } from "./limits";

/** ISO calendar value truncated to its precision: "YYYY[-MM[-DD]]". */
export interface ParsedDateValue {
  /** "YYYY-MM-DD" | "YYYY-MM" | "YYYY" */
  value: string;
  precision: Exclude<DatePrecision, "unknown">;
}

export interface ClaimDateResult {
  /** ISO "YYYY-MM-DD" when precision is day; coarser string otherwise. */
  claimDate: string | null;
  precision: DatePrecision;
  /** True when multiple materially different dates were found. */
  ambiguous: boolean;
}

export interface EvidenceDateSources {
  /** JSON-LD datePublished-ish field (highest precedence). */
  pageJsonLd?: string | null;
  /** article:published_time or equivalent metadata. */
  pageMeta?: string | null;
  /** Explicit <time datetime> value. */
  pageTime?: string | null;
  /** Date text reported by SerpApi for the result. */
  serpapi?: string | null;
}

export interface ResolvedEvidenceDate {
  publishedAt: string | null;
  publishedAtSource: PublishedAtSource;
  datePrecision: DatePrecision;
  dateStatus: DateStatus;
}

const DAY_MS = 24 * 60 * 60 * 1_000;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function toParts(y: number, m: number, d: number): ParsedDateValue {
  return { value: `${y}-${pad(m)}-${pad(d)}`, precision: "day" };
}

/**
 * Parse a raw date string into a value + precision. Returns null when the
 * string carries no usable date. `reference` resolves relative expressions
 * like "3 days ago" (SerpApi date text) against the retrieval time.
 */
export function parseDateValue(
  raw: string,
  reference: Date,
): ParsedDateValue | null {
  const s = raw.trim();
  if (s === "") return null;

  // ISO / ISO-like: 2019, 2019-03, 2019-03-12, 2019-03-12T...
  const iso = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:[T ].*)?$/.exec(s);
  if (iso) {
    const [, y, m, d] = iso;
    if (d != null && m != null) return toParts(+y, +m, +d);
    if (m != null) return { value: `${y}-${m}`, precision: "month" };
    return { value: y, precision: "year" };
  }

  // "3 days ago"-style relative text (common SerpApi surface).
  const rel =
    /^(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago$/i.exec(s);
  if (rel) {
    const n = +rel[1];
    const unit = rel[2].toLowerCase();
    const ref = reference.getTime();
    const ms =
      unit === "minute"
        ? n * 60_000
        : unit === "hour"
          ? n * 3_600_000
          : unit === "day"
            ? n * DAY_MS
            : unit === "week"
              ? n * 7 * DAY_MS
              : null;
    if (ms !== null) {
      const d = new Date(ref - ms);
      return toParts(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
    // Month/year granularity relatives only warrant month/year precision.
    if (unit === "month") {
      const d = new Date(ref);
      d.setUTCMonth(d.getUTCMonth() - n);
      return {
        value: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`,
        precision: "month",
      };
    }
    const d = new Date(ref);
    return { value: String(d.getUTCFullYear() - n), precision: "year" };
  }

  // Everything else: defer to chrono-node and derive precision from which
  // components were explicitly present in the text. Component values (not
  // start.date()) are used so the calendar day never shifts across the
  // server's local timezone.
  const results = chrono.parse(s, reference);
  if (results.length === 0) return null;
  return valueFromComponents(results[0].start);
}

function valueFromComponents(
  start: chrono.ParsedComponents,
): ParsedDateValue | null {
  const y = start.get("year");
  const m = start.get("month");
  const d = start.get("day");
  if (start.isCertain("day") && y !== null && m !== null && d !== null) {
    return toParts(y, m, d);
  }
  if (start.isCertain("month") && y !== null && m !== null) {
    return { value: `${y}-${pad(m)}`, precision: "month" };
  }
  if (start.isCertain("year") && y !== null) {
    return { value: String(y), precision: "year" };
  }
  return null;
}

/**
 * §19.1 — extract at most one usable claim date. Multiple materially
 * different parses make the claim date ambiguous -> null (do not guess).
 */
export function parseClaimDate(
  claim: string,
  opts: {
    /**
     * Investigation start instant. Callers should construct it so chrono's
     * relative-date math lands on the browser's wall clock (§19.1 reference:
     * start timestamp + browser timezone).
     */
    referenceInstant: Date;
    /** IANA browser timezone (§24 request field). */
    timezone?: string;
  },
): ClaimDateResult {
  const results = chrono.parse(claim, opts.referenceInstant);
  if (results.length === 0) {
    return { claimDate: null, precision: "unknown", ambiguous: false };
  }

  const values = results
    .map((r) => valueFromComponents(r.start))
    .filter((v): v is ParsedDateValue => v !== null);

  const distinct = new Set(values.map((v) => v.value));
  if (values.length === 0) {
    return { claimDate: null, precision: "unknown", ambiguous: false };
  }
  if (distinct.size > 1) {
    return { claimDate: null, precision: "unknown", ambiguous: true };
  }
  return {
    claimDate: values[0].value,
    precision: values[0].precision,
    ambiguous: false,
  };
}

function truncate(value: string, precision: DatePrecision): string {
  if (precision === "year") return value.slice(0, 4);
  if (precision === "month") return value.slice(0, 7);
  return value;
}

/** Latest instant a precision-limited value could denote (UTC). */
function endOfWindowMs(v: ParsedDateValue): number {
  const [y, m, d] = v.value.split("-").map(Number);
  if (v.precision === "year") return Date.UTC(y + 1, 0, 1);
  if (v.precision === "month") return Date.UTC(y, m, 1);
  return Date.UTC(y, m - 1, d) + DAY_MS;
}

/** Earliest instant a precision-limited value could denote (UTC). */
function startOfWindowMs(v: ParsedDateValue): number {
  const [y, m, d] = v.value.split("-").map(Number);
  if (v.precision === "year") return Date.UTC(y, 0, 1);
  if (v.precision === "month") return Date.UTC(y, (m ?? 1) - 1, 1);
  return Date.UTC(y, (m ?? 1) - 1, d ?? 1);
}

/** Material disagreement = values differ at the coarser shared precision. */
function materiallyDisagree(a: ParsedDateValue, b: ParsedDateValue): boolean {
  const coarser: DatePrecision =
    a.precision === "year" || b.precision === "year"
      ? "year"
      : a.precision === "month" || b.precision === "month"
        ? "month"
        : "day";
  if (coarser !== "day") {
    return truncate(a.value, coarser) !== truncate(b.value, coarser);
  }
  return Math.abs(startOfWindowMs(a) - startOfWindowMs(b)) > DAY_MS;
}

const PAGE_SOURCES = new Set<PublishedAtSource>([
  "page_json_ld",
  "page_meta",
  "page_time",
]);

/**
 * §19.2 — resolve one published date by precedence. Material disagreement
 * with another *page* source nulls the date (disputed); disagreement only
 * with the SerpApi field keeps the page's structured publication value.
 */
export function resolveEvidenceDate(
  sources: EvidenceDateSources,
  reference: Date,
): ResolvedEvidenceDate {
  const ordered: Array<{ source: PublishedAtSource; raw: string | null | undefined }> = [
    { source: "page_json_ld", raw: sources.pageJsonLd },
    { source: "page_meta", raw: sources.pageMeta },
    { source: "page_time", raw: sources.pageTime },
    { source: "serpapi", raw: sources.serpapi },
  ];

  const parsed = ordered
    .filter((e): e is { source: PublishedAtSource; raw: string } => e.raw != null)
    .map((e) => ({ source: e.source, value: parseDateValue(e.raw, reference) }))
    .filter(
      (e): e is { source: PublishedAtSource; value: ParsedDateValue } =>
        e.value !== null,
    );

  if (parsed.length === 0) {
    return {
      publishedAt: null,
      publishedAtSource: null,
      datePrecision: "unknown",
      dateStatus: "unknown",
    };
  }

  const winner = parsed[0];
  const pageConflict = parsed
    .slice(1)
    .some(
      (e) =>
        PAGE_SOURCES.has(e.source) &&
        materiallyDisagree(e.value, winner.value),
    );

  if (pageConflict) {
    return {
      publishedAt: null,
      publishedAtSource: null,
      datePrecision: "unknown",
      dateStatus: "disputed",
    };
  }

  return {
    publishedAt: winner.value.value,
    publishedAtSource: winner.source,
    datePrecision: winner.value.precision,
    dateStatus: "usable",
  };
}

/**
 * §19.3 — a candidate is PREDATES_CLAIM only when both dates exist and the
 * candidate's instant is more than 24 hours before the claim's earliest
 * possible instant. Day-precision values compare at their canonical
 * start-of-day instant (the §19.3 formula); month/year values, whose true
 * day is unknown, must fall entirely before the buffered window. Unknown or
 * disputed dates never establish a temporal conflict.
 */
export function predatesClaim(
  publishedAt: string | null,
  datePrecision: DatePrecision,
  dateStatus: DateStatus,
  claimDate: string | null,
  claimPrecision: DatePrecision = "day",
): boolean {
  if (claimDate === null || publishedAt === null) return false;
  if (dateStatus !== "usable" || datePrecision === "unknown") return false;
  if (claimPrecision === "unknown") return false;

  const pub: ParsedDateValue = { value: publishedAt, precision: datePrecision };
  const pubBound =
    datePrecision === "day" ? startOfWindowMs(pub) : endOfWindowMs(pub);
  const claimStart = startOfWindowMs({
    value: claimDate,
    precision: claimPrecision,
  });
  return pubBound < claimStart - TEMPORAL_CONFLICT_BUFFER_MS;
}
