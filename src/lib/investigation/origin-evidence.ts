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
 * Named-entity capture for source-bound attribution. A name is a run of
 * capitalized tokens possibly joined by small connectors ("Daily
 * Examiner", "Associated Press", "Herald & Post") — a lowercase word
 * ends the capture, so "Reuters as a handout" yields "Reuters".
 */
const NAME_TAIL = `(?:\\s+(?:of|the|and)\\s+|\\s*&\\s*|\\s+)[A-Z][A-Za-z0-9.'-]*`;
const ENTITY_NAME = `([A-Z][A-Za-z0-9.'-]*(?:${NAME_TAIL}){0,4})`;

/**
 * Explicit original-reporting markers on the page itself. Eligibility
 * requires an inspector-visible *named* attribution bound to the media:
 * a media-bound publisher credit ("the photograph was released by
 * Reuters") or a named-person byline tied to a *named* outlet
 * ("Reported by Jane Doe for the Daily Examiner").
 *
 * Anonymous assertions ("our investigation first published…", "this
 * outlet reported…", "exclusive report"), unnamed bylines ("for the
 * sports desk"), and mere staff/reporter mentions are unattributed
 * claims and never qualify (§13 conservative rule). A named byline
 * proves authorship at most — it cannot, alone, establish a separate
 * acquisition/reporting origin for the media.
 */
const MEDIA_BOUND_PUBLISHER_PATTERN = new RegExp(
  `(?:image|photo|photograph|footage|video)\\s+(?:was\\s+|were\\s+)?((?:first|originally)\\s+published|(?:first\\s+|originally\\s+)?(?:released|obtained|acquired|distributed|issued|verified|documented)|published)\\s+by\\s+(?:the\\s+)?${ENTITY_NAME}`,
  "g",
);
const NAMED_BYLINE_PATTERN = new RegExp(
  `(?:[Rr]eported|[Ii]nvestigated|[Ww]ritten|[Pp]hotographed|[Dd]ocumented|[Ff]iled) by\\s+[A-Z][a-z]+(?:\\s+[A-Z][a-z]+){1,3}\\s+for\\s+(?:the\\s+)?${ENTITY_NAME}`,
  "g",
);

/**
 * Negation markers that void an otherwise matching sentence — "the
 * reporters were not involved" must never read as original reporting.
 */
const NEGATION_PATTERN =
  /\b(?:not|no|never|neither|nor|without|denied|denies|uninvolved|unrelated|didn'?t|did not|wasn'?t|was not|weren'?t|were not|don'?t|do not|doesn'?t|does not)\b/i;

/**
 * A follow-up disclaimer voids a preceding attribution — "Reported by
 * Jane Doe for the Herald. This attribution is false." is not evidence.
 */
const DISCLAIMER_PATTERN =
  /\b(?:attribution|credit|byline|claim)\s+is\s+(?:false|incorrect|wrong|mistaken)|incorrectly attributed|falsely attributed|misattributed/i;

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim().length > 0);
}

/**
 * Sentences carrying an explicit syndication/origin attribution — the
 * inspectable spans behind `explicit_syndication_attribution`. Negated
 * or disclaimed sentences never qualify, matching the extraction rules.
 */
export function attributionSentences(text: string): string[] {
  const out: string[] = [];
  const sentences = splitSentences(text);
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    if (NEGATION_PATTERN.test(s)) continue;
    if (DISCLAIMER_PATTERN.test(sentences[i + 1] ?? "")) continue;
    if (ATTRIBUTION_PATTERNS.some((re) => re.test(s))) out.push(s.trim());
  }
  return out;
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

/** Normalize an outlet/provider name to a comparison key. */
function nameKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^(?:the|a|an)\s+/, "")
    .replace(/[^a-z0-9]/g, "");
}

/** The candidate's own-outlet key: first registrable-domain label. */
function ownOutletKey(registrableDomain: string): string {
  return nameKey(registrableDomain.split(".")[0] ?? "");
}

/** Named attribution extracted from one candidate's fetched page text. */
interface NamedEvidence {
  /** Media-bound acquisition/reporting credits ("the image was released by
   *  X", "first published by X"). A bare "published by X" names the hosting
   *  act, not acquisition, and is kept separately. */
  mediaPublishers: string[];
  /** Media-bound hosting credits ("the image was published by X") —
   *  evidence of publication only; never an acquisition origin claim. */
  hostingCredits: string[];
  /** Named byline outlets ("Reported by Y for the X"). */
  bylineOutlets: string[];
  /** Sentences carrying the attribution, retained as inspectable support. */
  spans: string[];
}

/**
 * Extract named attribution bound to the media from page text. A
 * sentence qualifies only when it is not negated and is not disclaimed
 * by the sentence that follows it.
 */
function extractNamedEvidence(text: string): NamedEvidence {
  const out: NamedEvidence = { mediaPublishers: [], hostingCredits: [], bylineOutlets: [], spans: [] };
  const sentences = splitSentences(text);
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    if (NEGATION_PATTERN.test(s)) continue;
    const next = sentences[i + 1] ?? "";
    if (DISCLAIMER_PATTERN.test(next)) continue;
    let m: RegExpExecArray | null;
    let found = false;
    MEDIA_BOUND_PUBLISHER_PATTERN.lastIndex = 0;
    while ((m = MEDIA_BOUND_PUBLISHER_PATTERN.exec(s)) !== null) {
      if (m[1] && m[2]) {
        // The first alternation keeps "first/originally published" an
        // acquisition claim; a bare "published by X" is hosting only.
        (m[1].trim() === "published" ? out.hostingCredits : out.mediaPublishers).push(m[2].trim());
        found = true;
      }
    }
    NAMED_BYLINE_PATTERN.lastIndex = 0;
    while ((m = NAMED_BYLINE_PATTERN.exec(s)) !== null) {
      if (m[1]) { out.bylineOutlets.push(m[1].trim()); found = true; }
    }
    if (found) out.spans.push(s.trim());
  }
  return out;
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
    // A named attribution matching the page's own outlet is self-
    // attribution — it is evaluated as separate-origin evidence in the
    // source-bound pass below, never as syndication to another origin.
    if (
      origin.startsWith("name:") &&
      nameKey(origin.slice(5)) === ownOutletKey(c.registrableDomain)
    ) {
      continue;
    }
    const groupId = origin.startsWith("name:") ? origin : `origin:${origin}`;
    const list = attrGroups.get(groupId) ?? [];
    list.push(c);
    attrGroups.set(groupId, list);
    if (c.reportingOrigin.status === "unresolved") {
      markSharedOrigin(
        [c],
        groupId,
        ["explicit_syndication_attribution"],
        [c.id],
        attributionSentences(text).map((s) => ({
          text: s,
          relation: "explicit_syndication_attribution",
        })),
      );
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
      for (const m of members) {
        if (m.reportingOrigin.status === "separate_origin_evidenced") continue;
        markSharedOrigin(
          [m],
          groupId,
          ["common_originating_report"],
          members.map((x) => x.id),
          attributionSentences(pageTexts.get(m.id) ?? "").map((s) => ({
            text: s,
            relation: "explicit_syndication_attribution",
          })),
        );
      }
      for (const m of members) changed.add(m.id);
    }
  }

  // 3) Source-bound named attribution. A name bound to the media must be
  //    tied to the specific page:
  //    - a named publisher credit for the media that names the page's OWN
  //      outlet evidences a separate origin for that page;
  //    - a named provider/outlet that is NOT the page's own is external
  //      source material — candidates crediting the same named provider
  //      share ONE group, they never become N separate origins;
  //    - bylines without a media-bound publisher credit prove authorship
  //      at most and leave the origin unresolved.
  const providerGroups = new Map<
    string,
    Array<{ c: EvidenceCandidate; spans: string[] }>
  >();
  const separate: Array<{ c: EvidenceCandidate; spans: string[] }> = [];
  for (const c of fetched) {
    if (c.reportingOrigin.status === "separate_origin_evidenced") continue;
    const text = pageTexts.get(c.id) ?? "";
    const ev = extractNamedEvidence(text);
    if (
      ev.mediaPublishers.length === 0 &&
      ev.hostingCredits.length === 0 &&
      ev.bylineOutlets.length === 0
    ) continue;
    const own = ownOutletKey(c.registrableDomain);
    // External named providers/outlets constrain promotion: a page that
    // credits a source it does not own shared that source — it cannot
    // claim a separate acquisition origin on the same evidence.
    const external = new Set<string>();
    for (const p of [...ev.mediaPublishers, ...ev.hostingCredits, ...ev.bylineOutlets]) {
      const k = nameKey(p);
      if (k !== "" && k !== own) external.add(k);
    }
    if (external.size > 0) {
      for (const k of external) {
        const list = providerGroups.get(k) ?? [];
        list.push({ c, spans: ev.spans });
        providerGroups.set(k, list);
      }
      continue;
    }
    const selfBound =
      own !== "" &&
      ev.mediaPublishers.some((p) => nameKey(p) === own);
    if (selfBound) {
      separate.push({ c, spans: ev.spans });
      continue;
    }
  }

  for (const { c, spans } of separate) {
    if (c.reportingOrigin.status !== "unresolved") continue;
    markSeparateOriginEvidenced(
      c,
      `origin:${c.registrableDomain}`,
      [c.id],
      spans.map((s) => ({ text: s, relation: "media_bound_publisher_credit" })),
    );
    changed.add(c.id);
  }
  for (const [k, members] of providerGroups) {
    if (members.length < 2) continue;
    const targets = members.filter(
      (m) => m.c.reportingOrigin.status !== "separate_origin_evidenced",
    );
    if (targets.length === 0) continue;
    for (const { c: m, spans } of targets) {
      markSharedOrigin(
        [m],
        `provider:${k}`,
        ["shared_named_provider"],
        targets.map((t) => t.c.id),
        spans.map((s) => ({ text: s, relation: "shared_named_provider" })),
      );
      changed.add(m.id);
    }
  }

  return [...changed];
}
