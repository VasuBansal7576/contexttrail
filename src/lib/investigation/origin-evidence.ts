/**
 * Deterministic reporting-origin evidence over fetched page text (spec §13).
 *
 * Conservative rules only:
 * - shared_origin requires inspectable evidence: explicit syndication
 *   attribution to another origin, or substantial normalized article-text
 *   duplication (word-shingle overlap >= TEXT_DUPLICATION_THRESHOLD).
 * - separate_origin_evidenced requires explicit original-reporting markers
 *   in retrieved page text (byline/staff/first-publication signals).
 * - Absence of a detected copy is never evidence of independence: anything
 *   not affirmatively evidenced stays unresolved.
 */

import type { EvidenceCandidate } from "./contracts/evidence";
import { registrableDomain } from "./domain";
import { shingleOverlap, textShingles } from "../pages/extract";
import {
  markSeparateOriginEvidenced,
  markSharedOrigin,
} from "./reporting-origins";

/** §13 — pinned conservative text-duplication threshold. */
export const TEXT_DUPLICATION_THRESHOLD = 0.6;

/**
 * Attribution phrases pointing at another outlet/origin. The capture is the
 * raw origin text following the phrase; it is normalized to a domain when
 * possible. Kept narrow on purpose — vague "source: online" style text must
 * not resolve origins.
 */
const ATTRIBUTION_PATTERNS: RegExp[] = [
  /originally (?:published|appeared|reported) (?:on|by|in|at)\s+([^,.;\n]{2,80})/i,
  /first (?:published|reported) (?:on|by|in|at)\s+([^,.;\n]{2,80})/i,
  /republished (?:from|by|on)\s+([^,.;\n]{2,80})/i,
  /syndicated (?:from|by)\s+([^,.;\n]{2,80})/i,
  /courtesy of\s+([^,.;\n]{2,80})/i,
  /reprinted (?:from|with permission of)\s+([^,.;\n]{2,80})/i,
];

/**
 * Explicit original-reporting markers on the page itself. Eligibility
 * requires an inspector-visible *named* attribution — a person byline
 * bound to an outlet, or a named publisher tied to the media itself.
 * Anonymous assertions ("our investigation first published…", "this
 * outlet reported…", "exclusive report") and mere staff/reporter
 * mentions are unattributed claims and never qualify (§13 conservative
 * rule).
 */
const OWN_REPORTING_PATTERNS: RegExp[] = [
  // Named-person byline bound to an outlet: "Reported by Jane Doe for
  // the Daily Examiner", "Written by Sam Roe for the Herald". Verb forms
  // accept sentence-start or mid-sentence case; the name must be a real
  // capitalized proper noun.
  /(?:[Rr]eported|[Ii]nvestigated|[Ww]ritten|[Pp]hotographed|[Dd]ocumented) by\s+[A-Z][a-z]+\s+[A-Z][a-z]+\b[^.]{0,60}\bfor\s+\S/,
  // Named publisher tied to the media: "the photograph was first
  // published by Reuters", "image obtained by the Associated Press".
  /(?:image|photo|photograph|footage|video)\s+(?:was\s+)?(?:first\s+)?(?:published|released|obtained|verified|documented)\s+by\s+[A-Z]/,
];

/**
 * Negation markers that void an otherwise matching sentence — "the
 * reporters were not involved" must never read as original reporting.
 */
const NEGATION_PATTERN =
  /\b(?:not|no|never|neither|nor|without|denied|denies|uninvolved|unrelated|didn'?t|did not|wasn'?t|was not|weren'?t|were not|don'?t|do not|doesn'?t|does not)\b/i;

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim().length > 0);
}

/**
 * Extract an attributed origin domain from page text. Returns a registrable
 * domain string when the attribution names a recognizable outlet/domain,
 * else null. Self-attribution is returned too — callers compare it to the
 * candidate's own domain.
 */
export function attributedOriginDomain(text: string): string | null {
  for (const re of ATTRIBUTION_PATTERNS) {
    const m = re.exec(text);
    if (m === null) continue;
    const raw = m[1].trim();
    // Direct domain match in the attribution text.
    const domainMatch = /([a-z0-9][a-z0-9.-]*\.[a-z]{2,})/i.exec(raw);
    if (domainMatch !== null) {
      const d = registrableDomain(domainMatch[1]);
      if (d !== null) return d;
    }
    // Named outlet: only accept when it resolves nowhere ambiguous —
    // two words or fewer, lowercase-normalized as a synthetic group key.
    const cleaned = raw.replace(/\b(the|a|an)\b/gi, "").trim();
    if (cleaned.length >= 3 && cleaned.split(/\s+/).length <= 3) {
      return `name:${cleaned.toLowerCase()}`;
    }
    return null;
  }
  return null;
}

/**
 * True when the page carries an explicit original-reporting marker in a
 * non-negated sentence. Negated or merely-mentioning text is not evidence.
 */
export function hasOwnReportingSignal(text: string): boolean {
  return splitSentences(text).some(
    (s) =>
      !NEGATION_PATTERN.test(s) &&
      OWN_REPORTING_PATTERNS.some((re) => re.test(s)),
  );
}

/**
 * Refine reporting origins across candidates with fetched page text.
 * Candidates without fetched text keep their existing (unresolved) origin.
 * Returns ids whose origin record changed.
 */
export function refineReportingOrigins(
  candidates: readonly EvidenceCandidate[],
  pageTexts: ReadonlyMap<string, string>,
): string[] {
  const changed = new Set<string>();

  // 1) Union-find for article-text duplication among fetched pages.
  const fetched = candidates.filter((c) => {
    const t = pageTexts.get(c.id);
    return typeof t === "string" && t.length >= 400;
  });
  const shingles = new Map<string, Set<string>>();
  for (const c of fetched) shingles.set(c.id, textShingles(pageTexts.get(c.id) ?? ""));

  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let p = parent.get(x) ?? x;
    if (p !== x) {
      p = find(p);
      parent.set(x, p);
    }
    return p;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (let i = 0; i < fetched.length; i++) {
    for (let j = i + 1; j < fetched.length; j++) {
      const a = fetched[i];
      const b = fetched[j];
      const overlap = shingleOverlap(
        shingles.get(a.id) ?? new Set(),
        shingles.get(b.id) ?? new Set(),
      );
      if (overlap >= TEXT_DUPLICATION_THRESHOLD) union(a.id, b.id);
    }
  }

  const dupGroups = new Map<string, EvidenceCandidate[]>();
  for (const c of fetched) {
    const root = find(c.id);
    const list = dupGroups.get(root) ?? [];
    list.push(c);
    dupGroups.set(root, list);
  }
  for (const members of dupGroups.values()) {
    if (members.length < 2) continue;
    const groupId = `dup:${members[0].id}`;
    markSharedOrigin(members, groupId, ["article_text_duplication"], members.map((m) => m.id));
    for (const m of members) changed.add(m.id);
  }

  // 2) Explicit syndication/origin attribution in fetched page text.
  const attrGroups = new Map<string, EvidenceCandidate[]>();
  for (const c of fetched) {
    const text = pageTexts.get(c.id) ?? "";
    const origin = attributedOriginDomain(text);
    if (origin === null) continue;
    if (origin === c.registrableDomain) continue; // self-attribution
    const groupId = origin.startsWith("name:") ? origin : `origin:${origin}`;
    const list = attrGroups.get(groupId) ?? [];
    list.push(c);
    attrGroups.set(groupId, list);
    if (c.reportingOrigin.status === "unresolved") {
      markSharedOrigin([c], groupId, ["explicit_syndication_attribution"], [c.id]);
      changed.add(c.id);
    }
  }
  // Candidates not yet resolved but attributing to the same origin group
  // share it (common originating report).
  for (const [groupId, members] of attrGroups) {
    const unresolvedMembers = members.filter(
      (m) => m.reportingOrigin.status === "unresolved",
    );
    if (members.length >= 2 && unresolvedMembers.length > 0) {
      markSharedOrigin(
        members.filter((m) => m.reportingOrigin.status !== "separate_origin_evidenced"),
        groupId,
        ["common_originating_report"],
        members.map((m) => m.id),
      );
      for (const m of members) changed.add(m.id);
    }
  }

  // 3) Separate reporting evidence: explicit original-reporting markers in
  // inspectable fetched text — never inferred from absence of a copy.
  for (const c of fetched) {
    if (c.reportingOrigin.status !== "unresolved") continue;
    const text = pageTexts.get(c.id) ?? "";
    if (!hasOwnReportingSignal(text)) continue;
    markSeparateOriginEvidenced(c, `origin:${c.registrableDomain}`, [c.id]);
    changed.add(c.id);
  }

  return [...changed];
}
