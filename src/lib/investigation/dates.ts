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
  /** Additional provider date texts for the same canonical URL from
   *  merged retrievals (§11/§19.2) — preserved for conflict resolution
   *  rather than silently dropped with the discarded candidate id. */
  serpapiAlternates?: string[];
}

export interface ResolvedEvidenceDate {
  publishedAt: string | null;
  publishedAtSource: PublishedAtSource;
  datePrecision: DatePrecision;
  dateStatus: DateStatus;
  /** Source dates rejected during resolution (page-page or merged
   *  provider conflicts) — preserved for inspection, never dropped. */
  rejected: Array<{ value: string; reason: string }>;
}

/**
 * Merge two source sets for one canonical URL (§11 dedupe). The earliest
 * provider date keeps the `serpapi` slot; every other distinct provider
 * text is preserved in `serpapiAlternates` so disagreement stays
 * resolvable instead of disappearing with a merged-away candidate id.
 */
export function mergeEvidenceDateSources(
  a: EvidenceDateSources,
  b: EvidenceDateSources,
): EvidenceDateSources {
  const raws = [
    a.serpapi,
    ...(a.serpapiAlternates ?? []),
    b.serpapi,
    ...(b.serpapiAlternates ?? []),
  ].filter((r): r is string => r != null);
  const distinct = [...new Set(raws)];
  return {
    pageJsonLd: a.pageJsonLd ?? b.pageJsonLd,
    pageMeta: a.pageMeta ?? b.pageMeta,
    pageTime: a.pageTime ?? b.pageTime,
    serpapi: distinct[0] ?? null,
    serpapiAlternates: distinct.slice(1),
  };
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
    if (d != null && m != null) {
      // Calendar validity: impossible dates (Feb 31, month 13) are rejected
      // outright rather than allowed to roll over into a different day.
      const ms = Date.UTC(+y, +m - 1, +d);
      const rt = new Date(ms);
      if (
        rt.getUTCFullYear() !== +y ||
        rt.getUTCMonth() !== +m - 1 ||
        rt.getUTCDate() !== +d
      ) {
        return null;
      }
      return toParts(+y, +m, +d);
    }
    if (m != null) {
      if (+m < 1 || +m > 12) return null;
      return { value: `${y}-${m}`, precision: "month" };
    }
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
  // An explicitly certain weekday resolves to exactly one calendar day
  // (e.g. "last Friday"): chrono already derived y/m/d deterministically
  // from the reference, so the implied components are safe to use.
  const dayCertain = start.isCertain("day") || start.isCertain("weekday");
  if (dayCertain && y !== null && m !== null && d !== null) {
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
 * Shift an instant so chrono's system-local calendar math lands on the
 * wall clock of `timezone` (§19.1). Returns the instant unchanged for a
 * missing or invalid IANA name — never guesses.
 */
function zonedReference(instant: Date, timezone?: string): Date {
  if (timezone === undefined || timezone === "") return instant;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(instant);
    const get = (type: string) =>
      Number(parts.find((p) => p.type === type)?.value ?? 0);
    const userWall = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour"),
      get("minute"),
      get("second"),
    );
    const systemWall = Date.UTC(
      instant.getFullYear(),
      instant.getMonth(),
      instant.getDate(),
      instant.getHours(),
      instant.getMinutes(),
      instant.getSeconds(),
    );
    return new Date(instant.getTime() + (userWall - systemWall));
  } catch {
    return instant;
  }
}

/** Dash-family separators — a "5–8" range means the same in every dash
 *  punctuation (en/em/nb-hyphen/figure/minus), not just ASCII "-". */
const DASH_SEP = "[\\-–—‑‒―−]";

/** §19.1 — a numeric date whose two leading components are both ≤12 is
 *  ambiguous (MM/DD vs DD/MM) with nothing to disambiguate it. Bare
 *  dash pairs ("5-8", "5–8") are day ranges, handled by the range
 *  guards; ISO year-first values can't match (no leading boundary
 *  inside a 4-digit run). */
const NUMERIC_DATE_FORM = new RegExp(
  `\\b(\\d{1,2})\\s*([/.]|${DASH_SEP})\\s*(\\d{1,2})(\\s*(?:[/.]|${DASH_SEP})\\s*\\d{2,4})?\\b`,
  "g",
);

function hasAmbiguousNumericDate(text: string): boolean {
  for (const m of text.matchAll(NUMERIC_DATE_FORM)) {
    // A bare "a<dash>b" without a year is a range, not a numeric date —
    // the range guards cover it when a date is actually asserted.
    if (m[2] !== "/" && m[2] !== "." && m[4] === undefined) continue;
    // Year-first forms ("2026-03-05", "2026.03.05") are unambiguous —
    // the matched pair follows a 4-digit year, not a missing century.
    if (/\d{4}\s*[/.-]\s*$/.test(text.slice(0, m.index))) continue;
    if (Number(m[1]) <= 12 && Number(m[3]) <= 12) return true;
  }
  return false;
}

/** §19.1 — "March 5–8[,] 2026" spells a multi-day range in every dash
 *  family or connector word. The endpoint check only sees ranges chrono
 *  itself parsed; Unicode-dash and "through" forms parse as one date
 *  with the tail silently ignored, so the text is checked directly. */
const MONTH_DAY_RANGE = new RegExp(
  `\\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|` +
    `jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|` +
    `dec(?:ember)?)\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?` +
    `\\s*(?:${DASH_SEP}|to|through|thru|and)\\s*\\d{1,2}(?:st|nd|rd|th)?\\b`,
  "i",
);

function hasDayRange(text: string): boolean {
  return MONTH_DAY_RANGE.test(text);
}

/** Every 4-digit year the claim states — a parse asserting a different
 *  year has silently lost supplied information (e.g. a range fragment
 *  inferred as "next March"). Refuse rather than assert a year the
 *  claim never gave. */
function statedYears(text: string): Set<string> {
  return new Set(text.match(/\b\d{4}\b/g) ?? []);
}

/**
 * §19.1 — extract at most one usable claim date. Multiple materially
 * different parses, a single parse spanning more than one calendar value
 * (a range like "March 5 to March 8"), or an ambiguous numeric form make
 * the claim date ambiguous -> null (do not guess). Relative dates
 * ("today", "yesterday", "last Friday") resolve on the browser's IANA
 * timezone wall clock, not the server's.
 */
export function parseClaimDate(
  claim: string,
  opts: {
    /**
     * Investigation start instant; `timezone` re-bases chrono's relative
     * math onto that zone's wall clock (§19.1 reference).
     */
    referenceInstant: Date;
    /** IANA browser timezone (§24 request field). */
    timezone?: string;
  },
): ClaimDateResult {
  if (hasAmbiguousNumericDate(claim) || hasDayRange(claim)) {
    return { claimDate: null, precision: "unknown", ambiguous: true };
  }

  const results = chrono.parse(
    claim,
    zonedReference(opts.referenceInstant, opts.timezone),
  );
  if (results.length === 0) {
    return { claimDate: null, precision: "unknown", ambiguous: false };
  }

  const values: ParsedDateValue[] = [];
  for (const r of results) {
    const start = valueFromComponents(r.start);
    if (start !== null) values.push(start);
    if (r.end != null) {
      const end = valueFromComponents(r.end);
      // A range whose endpoint resolves to a different calendar value
      // supplies more than one usable day — ambiguous, never first-day.
      if (end !== null && (start === null || end.value !== start.value)) {
        return { claimDate: null, precision: "unknown", ambiguous: true };
      }
    }
  }

  const distinct = new Set(values.map((v) => v.value));
  if (values.length === 0) {
    return { claimDate: null, precision: "unknown", ambiguous: false };
  }
  if (distinct.size > 1) {
    return { claimDate: null, precision: "unknown", ambiguous: true };
  }
  // A stated 4-digit year the parse contradicts is silently lost
  // information — e.g. "March 5–8, 2026" surviving as a single inferred
  // "next March". Refuse rather than assert a year the claim never gave.
  const years = statedYears(claim);
  if (years.size > 0 && !years.has(values[0].value.slice(0, 4))) {
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
    // §11/§19.2 — date texts merged in from other retrievals of the same
    // canonical URL resolve against the same precedence position.
    ...(sources.serpapiAlternates ?? []).map((raw) => ({
      source: "serpapi" as const,
      raw,
    })),
  ];

  const parsed = ordered
    .filter((e): e is { source: PublishedAtSource; raw: string } => e.raw != null)
    .map((e) => ({
      source: e.source,
      raw: e.raw,
      value: parseDateValue(e.raw, reference),
    }))
    .filter(
      (e): e is { source: PublishedAtSource; raw: string; value: ParsedDateValue } =>
        e.value !== null,
    );

  if (parsed.length === 0) {
    return {
      publishedAt: null,
      publishedAtSource: null,
      datePrecision: "unknown",
      dateStatus: "unknown",
      rejected: [],
    };
  }

  const winner = parsed[0];
  // Every later source that materially disagrees is preserved as a
  // rejection — disagreements are no longer silently dropped.
  const conflicts = parsed
    .slice(1)
    .filter((e) => materiallyDisagree(e.value, winner.value))
    .map((e) => ({
      value: e.raw,
      reason: PAGE_SOURCES.has(e.source)
        ? "conflicting_page_source"
        : "conflicting_provider_source",
    }));

  // Material disagreement with another page source nulls the date; so do
  // multiple disagreeing provider dates for one URL — merged retrievals
  // are one URL's sources, not one authoritative field (I2). A page
  // winner over disagreeing provider texts stays a clean override.
  const pageConflict =
    PAGE_SOURCES.has(winner.source) &&
    conflicts.length > 0 &&
    parsed.slice(1).some(
      (e) =>
        PAGE_SOURCES.has(e.source) &&
        materiallyDisagree(e.value, winner.value),
    );
  const providerConflict =
    winner.source === "serpapi" && conflicts.length > 0;

  if (pageConflict || providerConflict) {
    return {
      publishedAt: null,
      publishedAtSource: null,
      datePrecision: "unknown",
      dateStatus: "disputed",
      rejected: [
        ...conflicts,
        {
          value: winner.raw,
          reason: pageConflict
            ? "conflicting_page_source"
            : "conflicting_provider_source",
        },
      ],
    };
  }

  return {
    publishedAt: winner.value.value,
    publishedAtSource: winner.source,
    datePrecision: winner.value.precision,
    dateStatus: "usable",
    rejected: conflicts,
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
