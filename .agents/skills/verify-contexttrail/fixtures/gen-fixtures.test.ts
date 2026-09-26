/**
 * Controlled-boundary fixture generator (verification scaffolding).
 *
 * Runs the REAL runInvestigation orchestrator with controlled SerpApi/Jev/
 * page-fetch providers and writes the NDJSON event streams into this
 * directory for `control-contexttrail drive investigation --case <name>`.
 * These fixtures prove rendering/behavior at the public-contract boundary —
 * they never represent real provenance. Regenerate after contract changes:
 *
 *   CONTEXTTRAIL_GEN_FIXTURES=1 npx vitest run <this file>
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInvestigation, type SearchProvider } from "../../../../src/lib/investigation/run";
import type { SerpapiParams } from "../../../../src/lib/serpapi/client";
import type { JevClient } from "../../../../src/lib/jev/client";
import type { FetchedPage } from "../../../../src/lib/pages/fetch";

const GEN = process.env.CONTEXTTRAIL_GEN_FIXTURES === "1";
const OUT = path.dirname(fileURLToPath(import.meta.url));

const CHOICE = {
  page_role: ["REPORTING", "FACT_CHECK", "SOCIAL_REPOST", "AGGREGATOR", "COMMENTARY", "OTHER"],
  context_relation: ["SAME_CONTEXT", "DIFFERENT_CONTEXT", "HISTORICAL_REFERENCE", "UNCLEAR"],
  claim_relation: ["SUPPORTS", "CONTRADICTS", "NEUTRAL", "INSUFFICIENT"],
  pairwise_context: ["SAME_CONTEXT", "DIFFERENT_CONTEXT", "UNCLEAR"],
} as const;

const answers = (qs: Record<string, unknown>, winners: Record<string, string>) =>
  Object.fromEntries(
    Object.keys(qs).map((k) => [
      k,
      k === "relevance"
        ? { type: "noul", noul: 0.92 }
        : (() => {
            const keys = (CHOICE as Record<string, readonly string[]>)[k] ?? ["UNCLEAR"];
            const winner = winners[k] ?? keys[0];
            return {
              type: "choice",
              choice: winner,
              // Probabilities must sum to 1 — the validated contract
              // rejects unnormalized distributions.
              probabilities: Object.fromEntries(
                keys.map((v: string) => [
                  v,
                  v === winner ? 0.9 : (1 - 0.9) / (keys.length - 1),
                ]),
              ),
            };
          })(),
    ]),
  );

const lensAll = {
  search_metadata: { id: "fixture-lens-all", status: "Success" },
  visual_matches: [
    {
      position: 1,
      title: "CONTROLLED FIXTURE visual lead — 2019 article",
      link: "https://fixture-news-a.example.org/report/lead-2019",
      snippet: "controlled lead snippet",
      thumbnail: "https://example.invalid/lead.png",
      date: "Mar 3, 2019",
    },
    {
      position: 2,
      title: "CONTROLLED FIXTURE visual lead — undated",
      link: "https://fixture-blog-b.example.org/post/undated",
      snippet: "controlled undated lead",
      thumbnail: "https://example.invalid/lead2.png",
    },
  ],
  related_content: [{ query: "controlled grounded query", link: "https://google.com/q" }],
};

const lensExact = {
  search_metadata: { id: "fixture-lens-exact", status: "Success" },
  exact_matches: [
    {
      position: 1,
      title: "CONTROLLED FIXTURE exact copy — 2018 archive",
      link: "https://fixture-archive-c.example.org/item/2018",
      date: "Jun 15, 2018",
      thumbnail: "https://example.invalid/exact1.png",
    },
    {
      position: 2,
      title: "CONTROLLED FIXTURE exact copy — 2020 repost",
      link: "https://fixture-site-d.example.org/page/2020",
      date: "Oct 2, 2020",
      thumbnail: "https://example.invalid/exact2.png",
    },
  ],
};

const aboutImage = { search_metadata: { id: "fixture-about", status: "Success" }, about_this_image: { sections: [] } };

const googleSearch = {
  search_metadata: { id: "fixture-google", status: "Success" },
  organic_results: [
    {
      position: 1,
      title: "CONTROLLED FIXTURE contextual article",
      link: "https://fixture-context-e.example.org/story",
      snippet: "controlled contextual result",
      date: "Aug 8, 2021",
    },
  ],
};

const googleNews = {
  search_metadata: { id: "fixture-news", status: "Success" },
  news_results: [
    {
      position: 1,
      title: "CONTROLLED FIXTURE current news hit",
      link: "https://fixture-news-f.example.org/current",
      date: "2 days ago",
      thumbnail: "https://example.invalid/news.png",
    },
  ],
};

const serpapi: SearchProvider = {
  uploadImage: async () => "fixture-upload-id",
  search: async (p: SerpapiParams) => {
    if (p.engine === "google_lens" && p.type === "exact_matches") return lensExact;
    if (p.engine === "google_lens" && p.type === "about_this_image") return aboutImage;
    if (p.engine === "google_lens") return lensAll;
    if (p.engine === "google_news") return googleNews;
    return googleSearch;
  },
};

const jev = {
  ask: async (_s: unknown, qs: Record<string, unknown>) => ({
    answers: answers(qs, { context_relation: "DIFFERENT_CONTEXT", claim_relation: "NEUTRAL" }),
    model: "jev-1.13.0",
    identity: {
      requested: "jev-1.13.0",
      reported: "jev-1.13.0",
      status: "verified",
      pinned: true,
    },
  }),
} as unknown as JevClient;

/** Entity-bound JSON-LD publication dates per fixture domain — gives the
 *  deep-read phase real dated evidence so core occurrences land in the
 *  timeline and takeaways can cite evidenceIds. */
const PAGE_DATES: Record<string, string> = {
  "fixture-archive-c.example.org": "2018-06-15",
  "fixture-site-d.example.org": "2020-10-02",
  "fixture-news-f.example.org": "2026-09-24",
};

const fetchPage = async (url: string): Promise<FetchedPage> => {
  const host = new URL(url).hostname;
  const date = PAGE_DATES[host];
  const ld = date
    ? `<script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "NewsArticle",
        headline: "CONTROLLED article",
        datePublished: date,
      })}</script>`
    : "";
  return {
    url,
    html: `<html><head><title>CONTROLLED page</title>${ld}</head><body><article><p>${"Controlled extracted text about a fixture photograph and its publication context. ".repeat(12)}</p></article></body></html>`,
  };
};

/** 1×1 PNG as a data URI — a retrieved image that actually loads in the
 *  browser, so viewer `image-load` coverage exercises the real <img> path. */
const DATA_URI_THUMB =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const lensAllViewer = {
  search_metadata: { id: "fixture-lens-viewer", status: "Success" },
  visual_matches: [
    {
      position: 1,
      title: "CONTROLLED FIXTURE lead — loadable thumbnail",
      link: "https://fixture-viewer-a.example.org/report/loadable",
      snippet: "controlled loadable snippet",
      thumbnail: DATA_URI_THUMB,
      date: "Apr 4, 2019",
    },
    {
      position: 2,
      title: "CONTROLLED FIXTURE lead — no snippet",
      link: "https://fixture-viewer-b.example.org/post/nosnippet",
      thumbnail: DATA_URI_THUMB,
      date: "May 5, 2020",
    },
  ],
};

const serpapiViewer: SearchProvider = {
  uploadImage: async () => "fixture-upload-id",
  search: async (p: SerpapiParams) => {
    if (p.engine === "google_lens" && p.type === "exact_matches") return lensExact;
    if (p.engine === "google_lens" && p.type === "about_this_image") return aboutImage;
    if (p.engine === "google_lens") return lensAllViewer;
    if (p.engine === "google_news") return googleNews;
    return googleSearch;
  },
};

/** Every surface returns a provider-validated empty collection — claim mode
 *  resolves to an honest INSUFFICIENT_EVIDENCE result. */
const empty = (id: string) => ({ search_metadata: { id, status: "Success" } });
const serpapiEmpty: SearchProvider = {
  uploadImage: async () => "fixture-upload-id",
  search: async (p: SerpapiParams) => empty(`fixture-empty-${p.engine}`),
};

describe.skipIf(!GEN)("controlled fixture generation", () => {
  it.each([
    ["controlled-trace", null, serpapi],
    ["controlled-claim", "This controlled claim describes a fictional event today.", serpapi],
    ["controlled-viewer", "This controlled claim describes a fictional event today.", serpapiViewer],
    ["controlled-insufficient", "This controlled claim describes a fictional event today.", serpapiEmpty],
  ])("writes %s.ndjson", async (name, claim, provider) => {
    const events: unknown[] = [];
    await runInvestigation(
      { media: new Uint8Array([1, 2, 3]), claim, timezone: "UTC", locale: "en" },
      (e) => events.push(e),
      { serpapi: provider, jev, fetchPage },
    );
    const file = path.join(OUT, `${name}.ndjson`);
    fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const last = events[events.length - 1] as { type: string };
    if (last.type !== "investigation.completed") throw new Error(`${name}: no terminal event`);
  });
});

/* ---------------------------------------------------------------------- *
 * Always-on fixture contract (V4).
 *
 * The generation block above only runs when CONTEXTTRAIL_GEN_FIXTURES=1, so
 * on its own it proves nothing about the fixtures actually committed to the
 * repository. This suite runs on every `vitest run` and asserts the public
 * contract of every checked-in stream: terminal event, mode/status
 * coherence, requestLog.durationMs, policy/support/identity/date/origin
 * fields, normalized probability distributions, pinned model identity,
 * distinguishable images, and the absence of real hosts or credential
 * material.
 * ---------------------------------------------------------------------- */

const CLAIM_STATUSES = [
  "CONTEXT_CONFLICT",
  "POSSIBLE_CONTEXT_CONFLICT",
  "NO_CONFLICT_FOUND",
  "INSUFFICIENT_EVIDENCE",
] as const;

const CLAIM_FIXTURES = new Set(["controlled-claim", "controlled-viewer", "controlled-insufficient"]);
const TRACE_FIXTURES = new Set(["controlled-trace"]);
const DATE_STATUSES = new Set(["usable", "approximate", "unknown", "absent"]);
const DATE_PRECISIONS = new Set(["day", "month", "year", "unknown", "none"]);
const IDENTITY_BASES = new Set([
  "contextual",
  "unverified",
  "lens_exact_collection",
  "hash_verified",
  "verifier",
]);
const VERIFICATION_STATUSES = new Set([
  "provider_reported",
  "unavailable",
  "verified",
  "failed",
  "not_applicable",
]);
const RELATIONSHIPS = new Set([
  "EXACT_MATCH",
  "NEAR_MATCH",
  "VISUAL_LEAD",
  "CONTEXTUAL",
  "UNRELATED",
  null,
]);
const CONNECTORS = new Set([
  "start",
  "same_context",
  "different_context",
  "uncertain",
  "unexamined",
  "unknown",
  null,
]);
const LIMITATION_CODES = new Set([
  "exact_match_retrieval_unavailable",
  "about_this_image_unavailable",
  "insufficient_dated_occurrences",
  "near_match_verifier_disabled",
  "reporting_origins_unresolved",
  "unknown_dates_present",
  "unverified_visual_leads_present",
  "no_current_media_corroboration",
  "location_unresolved",
  "web_context_unavailable",
  "semantic_classification_unavailable",
  "model_identity_unverified",
]);
const TAKEAWAY_CODES = new Set([
  "temporal_conflict",
  "location_conflict",
  "historical_reuse",
  "no_current_media_corroboration",
]);

type Json = Record<string, unknown>;

const fixtureNames = () =>
  fs
    .readdirSync(OUT)
    .filter((f) => f.endsWith(".ndjson"))
    .map((f) => f.replace(/\.ndjson$/, ""))
    .sort();

const readEvents = (name: string): Json[] =>
  fs
    .readFileSync(path.join(OUT, `${name}.ndjson`), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Json);

const terminalResult = (events: Json[]): Json => {
  const last = events[events.length - 1] as Json | undefined;
  if (!last || last["type"] !== "investigation.completed") {
    throw new Error("fixture does not end with investigation.completed");
  }
  const result = last["result"];
  if (!result || typeof result !== "object") throw new Error("terminal event has no result");
  return result as Json;
};

const asArray = (v: unknown): Json[] =>
  Array.isArray(v) ? v.filter((x): x is Json => !!x && typeof x === "object") : [];

const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

const str = (o: Json, k: string): string | null =>
  typeof o[k] === "string" ? (o[k] as string) : null;

const walk = (value: unknown, visit: (node: Json) => void) => {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const v of value) walk(v, visit);
    return;
  }
  const record = value as Json;
  visit(record);
  for (const v of Object.values(record)) walk(v, visit);
};

/** Every absolute URL that appears anywhere in the fixture must address a
 *  controlled fixture host — never a real site. */
const collectUrls = (events: Json[]): string[] => {
  const out: string[] = [];
  const re = /https?:\/\/[^\s"\\]+/g;
  for (const e of events) {
    for (const m of JSON.stringify(e).matchAll(re)) out.push(m[0]);
  }
  return out;
};

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

const EXPECTED_LABELS: Record<string, readonly string[]> = {
  contextRelation: ["sameContext", "differentContext", "historicalReference", "unclear"],
  pageRole: ["reporting", "factCheck", "socialRepost", "aggregator", "commentary", "other"],
  claimRelation: ["supports", "contradicts", "neutral", "insufficient"],
  locationRelation: ["sameLocation", "differentLocation", "unclear"],
};

/** The controlled fixtures are authored to classify every candidate as a
 *  different-context, neutral, reporting-page hit — the exact shape that
 *  drives the conflict statuses the drives assert. */
const EXPECTED_ARGMAX: Record<string, string | undefined> = {
  contextRelation: "differentContext",
  pageRole: "reporting",
  claimRelation: "neutral",
};

const FIXTURE_FILES = fixtureNames();

describe("controlled fixture contract", () => {
  it("fixture set covers every mapped case", () => {
    expect(FIXTURE_FILES.length).toBeGreaterThanOrEqual(4);
    for (const name of [...CLAIM_FIXTURES, ...TRACE_FIXTURES]) {
      expect(FIXTURE_FILES).toContain(name);
    }
  });

  it.each(FIXTURE_FILES)("%s: terminal event and mode/status coherence", (name) => {
    const events = readEvents(name);
    expect(events.length).toBeGreaterThan(5);
    const result = terminalResult(events);
    const mode = str(result, "mode");
    const status = str(result, "status");
    if (TRACE_FIXTURES.has(name)) {
      expect(mode).toBe("trace");
      expect(status).toBeNull();
      expect(result["claim"]).toBeFalsy();
    } else {
      expect(CLAIM_FIXTURES.has(name)).toBe(true);
      expect(mode).toBe("claim_check");
      expect(status).not.toBeNull();
      expect(CLAIM_STATUSES).toContain(status as (typeof CLAIM_STATUSES)[number]);
      expect(str(result, "claim")).toBeTruthy();
      // Every claim status other than NO_CONFLICT_FOUND must not be dressed
      // up as proof; NO_CONFLICT_FOUND carries the explicit caveat flag.
      if (status === "NO_CONFLICT_FOUND") {
        expect(result["doesNotProveClaimTrue"]).toBe(true);
      }
      expect(strs(result["statusBasis"]).length).toBeGreaterThan(0);
    }
  });

  it.each(FIXTURE_FILES)("%s: requestLog carries engine counters and durationMs", (name) => {
    const result = terminalResult(readEvents(name));
    const log = asArray(result["requestLog"]);
    expect(log.length).toBeGreaterThan(0);
    const engines = new Set<string>();
    for (const entry of log) {
      const engine = str(entry, "engine");
      expect(engine).toBeTruthy();
      engines.add(engine as string);
      for (const key of ["attempted", "returned", "retained", "durationMs"]) {
        const v = entry[key];
        expect(typeof v, `${name}/${engine}/${key} must be a number`).toBe("number");
        expect(Number.isFinite(v as number), `${name}/${engine}/${key} finite`).toBe(true);
        expect(v as number).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(v as number), `${name}/${engine}/${key} integer`).toBe(true);
      }
      expect(entry["retained"] as number).toBeLessThanOrEqual(entry["returned"] as number);
    }
    expect(engines.size).toBe(log.length);
  });

  it.each(FIXTURE_FILES)("%s: policy, support, identity, date and origin fields", (name) => {
    const result = terminalResult(readEvents(name));
    const timeline = asArray(result["timeline"]);
    const supporting = asArray(result["supportingEvidence"]);
    const contextual = asArray(result["contextualEvidence"]);
    const undated = asArray(result["undatedEvidence"]);

    // support: every cross-reference resolves to an evidence id we actually
    // shipped, so the UI can never cite a phantom id.
    const knownIds = new Set<string>();
    for (const item of [...timeline, ...supporting, ...contextual, ...undated]) {
      const id = str(item, "evidenceId") ?? str(item, "occurrenceId");
      expect(id, `${name}: timeline item without an id`).toBeTruthy();
      expect(knownIds.has(id as string), `${name}: duplicate evidence id ${id}`).toBe(false);
      knownIds.add(id as string);
    }
    expect(knownIds.size).toBe(timeline.length + supporting.length + contextual.length + undated.length);

    for (const takeaway of asArray(result["takeaways"])) {
      const code = str(takeaway, "code");
      expect(TAKEAWAY_CODES.has(code as string), `${name}: unknown takeaway code ${code}`).toBe(true);
      for (const id of strs(takeaway["evidenceIds"])) {
        expect(knownIds.has(id), `${name}: takeaway cites unknown id ${id}`).toBe(true);
      }
    }

    for (const limitation of strs(result["limitations"])) {
      expect(LIMITATION_CODES.has(limitation), `${name}: unknown limitation ${limitation}`).toBe(true);
    }

    // policy: gates are enumerable, boolean, and cite real evidence ids.
    for (const gate of asArray(result["policyReasons"])) {
      expect(typeof gate["gate"]).toBe("string");
      expect(typeof gate["passed"]).toBe("boolean");
      expect(typeof gate["detail"]).toBe("string");
      for (const id of strs(gate["supportIds"])) {
        expect(knownIds.has(id), `${name}: policy gate cites unknown id ${id}`).toBe(true);
      }
    }

    // identity: every candidate's identity evidence is internally truthful.
    walk(readEvents(name), (node) => {
      const ie = node["identityEvidence"];
      if (!ie || typeof ie !== "object") return;
      const rec = ie as Json;
      const basis = str(rec, "basis");
      const status = str(rec, "verificationStatus");
      expect(IDENTITY_BASES.has(basis as string), `${name}: unknown identity basis ${basis}`).toBe(true);
      expect(
        VERIFICATION_STATUSES.has(status as string),
        `${name}: unknown verification status ${status}`,
      ).toBe(true);
      if (status === "verified") {
        expect(rec["verifierVersion"], `${name}: verified identity without a verifier version`).toBeTruthy();
        expect(rec["verifierConfigId"], `${name}: verified identity without a config id`).toBeTruthy();
        expect(typeof rec["hashDistance"], `${name}: verified identity without a hash distance`).toBe("number");
      } else {
        // An unverified identity must not pretend to carry verifier detail.
        expect(rec["verifierVersion"]).toBeNull();
        expect(rec["verifierConfigId"]).toBeNull();
      }
    });

    // date: usable dates are real ISO days; unknown dates are explicit.
    for (const item of timeline) {
      const status = str(item, "dateStatus");
      expect(DATE_STATUSES.has(status as string), `${name}: unknown dateStatus ${status}`).toBe(true);
      expect(DATE_PRECISIONS.has(String(item["datePrecision"])), `${name}: unknown datePrecision`).toBe(true);
      if (status === "usable") {
        expect(str(item, "observedAt")).toMatch(/^\d{4}-\d{2}-\d{2}/);
      } else {
        expect(item["observedAt"] ?? null).toBeNull();
      }
      expect(RELATIONSHIPS.has((str(item, "mediaRelationship") ?? null) as never), `${name}: unknown mediaRelationship`).toBe(true);
      const connector = (item["incomingConnector"] ?? null) as Json | null;
      const kind = connector ? str(connector, "kind") : null;
      expect(CONNECTORS.has(kind as never), `${name}: unknown connector ${kind}`).toBe(true);
      expect(str(item, "registrableDomain"), `${name}: timeline item missing origin domain`).toBeTruthy();
    }

    // origin: summary counters must agree with the arrays they summarize.
    expect(result["reportingGroupCount"]).toBe(asArray(result["reportingGroups"]).length);
    expect(result["unresolvedOriginCount"]).toBe(strs(result["unresolvedCandidateIds"]).length);
    expect(typeof result["sourceDomainCount"], `${name}: sourceDomainCount`).toBe("number");
    expect(result["sourceDomainCount"] as number).toBeGreaterThanOrEqual(0);
    // contextSegmentCount is null until segmentation actually ran.
    if (result["contextSegmentCount"] !== null) {
      expect(typeof result["contextSegmentCount"], `${name}: contextSegmentCount`).toBe("number");
      expect(result["contextSegmentCount"] as number).toBeGreaterThanOrEqual(0);
    }
    for (const group of asArray(result["reportingGroups"])) {
      expect(str(group, "groupId")).toBeTruthy();
      expect(strs(group["memberIds"]).length).toBeGreaterThan(0);
      for (const id of strs(group["memberIds"])) {
        expect(knownIds.has(id), `${name}: reporting group cites unknown id ${id}`).toBe(true);
      }
    }

    const coverage = (result["comparisonCoverage"] ?? null) as Json | null;
    if (coverage) {
      for (const key of ["eligible", "selected", "comparedPairs", "displayedDatedCore"]) {
        expect(typeof coverage[key], `${name}: comparisonCoverage.${key}`).toBe("number");
        expect(coverage[key] as number).toBeGreaterThanOrEqual(0);
      }
      for (const pair of strs(coverage["comparedPairIds"])) {
        for (const id of pair.split("|")) expect(knownIds.has(id)).toBe(true);
      }
    }

    if (timeline.length > 0) {
      const dated = timeline
        .map((t) => str(t, "observedAt"))
        .filter((d): d is string => !!d)
        .sort();
      expect(dated.length).toBeGreaterThan(0);
      expect(str(result, "earliestObservedOccurrence")).toBe(dated[0]);
      expect(result["sourceDomainCount"]).toBeGreaterThanOrEqual(1);
    }
  });

  it.each(FIXTURE_FILES)("%s: probability distributions are normalized", (name) => {
    const events = readEvents(name);
    let checked = 0;
    const verdict = terminalResult(readEvents(name));
    const hasCandidates = asArray(verdict["timeline"]).length > 0;
    walk(events, (node) => {
      const judgment = node["publicJudgment"];
      if (!judgment || typeof judgment !== "object") return;
      const j = judgment as Json;
      checked++;
      const relevance = j["relevance"];
      expect(typeof relevance, `${name}: judgment.relevance must be a number`).toBe("number");
      expect(relevance as number).toBeGreaterThanOrEqual(0);
      expect(relevance as number).toBeLessThanOrEqual(1);
      let published = 0;
      for (const [key, labels] of Object.entries(EXPECTED_LABELS)) {
        const dist = j[key];
        // Trace mode never asks the context/claim questions — an explicit
        // null is the truthful answer, not a missing distribution.
        if (dist === null || dist === undefined) continue;
        published++;
        const record = dist as Record<string, number>;
        expect(Object.keys(record).sort(), `${name}: ${key} labels`).toEqual([...labels].sort());
        for (const v of Object.values(record)) {
          expect(typeof v, `${name}: ${key} value type`).toBe("number");
          expect(v as number).toBeGreaterThan(0);
          expect(v as number).toBeLessThanOrEqual(1);
        }
        const sum = Object.values(record).reduce((a, b) => a + b, 0);
        expect(Math.abs(sum - 1), `${name}: ${key} sums to ${sum}`).toBeLessThan(1e-6);
        const winner = EXPECTED_ARGMAX[key];
        if (winner) {
          const argmax = Object.entries(record).sort((a, b) => b[1] - a[1])[0][0];
          expect(argmax, `${name}: ${key} mode must be ${winner}`).toBe(winner);
        }
      }
      expect(published, `${name}: judgment published no distribution`).toBeGreaterThan(0);
      expect(typeof j["model"], `${name}: judgment.model`).toBe("string");
      expect(j["schemaVersion"]).toBe("contexttrail-evidence-v1");
    });
    // Every classified candidate publishes its judgment distribution; a
    // fixture with no candidates is allowed to publish none.
    if (hasCandidates) expect(checked).toBeGreaterThan(0);
    else expect(checked).toBe(0);
  });

  it.each(FIXTURE_FILES)("%s: model identity is pinned and consistent", (name) => {
    const events = readEvents(name);
    const models = new Set<string>();
    const schemas = new Set<string>();
    let judgments = 0;
    walk(events, (node) => {
      if (node["relevance"] === undefined || node["model"] === undefined) return;
      judgments++;
      models.add(String(node["model"]));
      if (node["schemaVersion"] !== undefined) schemas.add(String(node["schemaVersion"]));
      expect(typeof node["relevance"]).toBe("number");
      expect(node["relevance"] as number).toBeGreaterThanOrEqual(0);
      expect(node["relevance"] as number).toBeLessThanOrEqual(1);
      for (const rel of ["contextRelation", "claimRelation", "pageRole", "locationRelation"]) {
        const dist = node[rel];
        if (dist === null || dist === undefined) continue;
        const values = Object.values(dist as Record<string, number>);
        const sum = values.reduce((a, b) => a + b, 0);
        expect(Math.abs(sum - 1), `${name}: ${rel} sums to ${sum}`).toBeLessThan(1e-6);
      }
    });
    if (judgments === 0) return;
    expect(models.size, `${name}: models observed: ${[...models].join(", ")}`).toBe(1);
    const model = [...models][0];
    expect(model).toMatch(/^jev-/);
    expect(schemas.size).toBeLessThanOrEqual(1);
  });

  it.each(FIXTURE_FILES)("%s: no real hosts and no credential material", (name) => {
    const events = readEvents(name);
    const raw = fs.readFileSync(path.join(OUT, `${name}.ndjson`), "utf8");
    expect(raw).not.toMatch(/api[_-]?key\s*[:=]/i);
    expect(raw).not.toMatch(/\b(sk|pk|key)[-_][A-Za-z0-9]{16,}/);
    expect(raw).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{16,}/);
    expect(raw).not.toMatch(/serpapi\.com\/search/i);
    for (const url of collectUrls(events)) {
      const host = hostOf(url);
      expect(host, `${name}: unparsable url ${url}`).toBeTruthy();
      expect(
        /^(fixture-[a-z0-9-]+\.example\.org|example\.(org|com|net|invalid))$/.test(host as string),
        `${name}: real host in fixture: ${host}`,
      ).toBe(true);
    }
  });

  it.each(FIXTURE_FILES)("%s: retrieved images are distinguishable", (name) => {
    const result = terminalResult(readEvents(name));
    const items = [
      ...asArray(result["timeline"]),
      ...asArray(result["supportingEvidence"]),
      ...asArray(result["contextualEvidence"]),
      ...asArray(result["undatedEvidence"]),
    ];
    const images = items
      .map((i) => str(i, "imageUrl") ?? str(i, "thumbnailUrl"))
      .filter((u): u is string => !!u && !u.startsWith("data:"));
    if (asArray(result["timeline"]).length > 0) expect(images.length).toBeGreaterThan(0);
    expect(new Set(images).size, `${name}: duplicate retrieved image urls`).toBe(images.length);
  });

  it("the empty-collection fixture is genuinely empty", () => {
    const result = terminalResult(readEvents("controlled-insufficient"));
    expect(str(result, "status")).toBe("INSUFFICIENT_EVIDENCE");
    for (const key of ["timeline", "supportingEvidence", "contextualEvidence", "undatedEvidence"]) {
      expect(asArray(result[key]), `controlled-insufficient must not contain ${key}`).toHaveLength(0);
    }
    expect(result["earliestObservedOccurrence"] ?? null).toBeNull();
    expect(result["sourceDomainCount"]).toBe(0);
    expect(result["reportingGroupCount"]).toBe(0);
    const log = asArray(result["requestLog"]);
    expect(log.length).toBeGreaterThan(0);
    for (const entry of log) expect(entry["retained"]).toBe(0);
  });
});

/* ---------------------------------------------------------------------- *
 * Generator contract — runs on every `vitest run`, no GEN gate needed.
 * ---------------------------------------------------------------------- */

type JevResponse = {
  answers: Record<string, unknown>;
  model: string;
  identity: { requested: string; reported: string; status: string; pinned: boolean };
};

const jevAsk = (
  jev as unknown as { ask: (claim: unknown, qs: Record<string, unknown>) => Promise<JevResponse> }
).ask;

describe("generator contract", () => {
  it("the Jev client reports a truthful, pinned model identity", async () => {
    const res = await jevAsk("controlled claim", {
      relevance: {},
      context_relation: {},
      claim_relation: {},
      page_role: {},
    });
    expect(res.identity.requested).toBe(res.identity.reported);
    expect(res.identity.status).toBe("verified");
    expect(res.identity.pinned).toBe(true);
    expect(res.model).toBe(res.identity.reported);
    expect(res.model).toMatch(/^jev-/);
  });

  it("every published judgment distribution is normalized", () => {
    for (const winners of [
      { context_relation: "DIFFERENT_CONTEXT", claim_relation: "NEUTRAL", page_role: "REPORTING" },
      { context_relation: "SAME_CONTEXT", claim_relation: "SUPPORTS", page_role: "FACT_CHECK" },
    ]) {
      const qs = {
        relevance: {},
        context_relation: {},
        claim_relation: {},
        page_role: {},
        pairwise_context: {},
      } as unknown as Record<string, unknown>;
      const out = answers(qs, winners) as Record<
        string,
        { type: string; noul?: number; choice?: string; probabilities?: Record<string, number> }
      >;
      for (const [key, value] of Object.entries(out)) {
        if (value.type === "noul") {
          expect(typeof value.noul).toBe("number");
          expect(value.noul as number).toBeGreaterThan(0);
          expect(value.noul as number).toBeLessThanOrEqual(1);
          continue;
        }
        const probs = value.probabilities as Record<string, number>;
        const sum = Object.values(probs).reduce((a, b) => a + b, 0);
        expect(Math.abs(sum - 1), `${key} sums to ${sum}`).toBeLessThan(1e-6);
        const top = Math.max(...Object.values(probs));
        expect(probs[value.choice as string], `${key} choice must be the mode`).toBeCloseTo(top, 10);
        expect(Object.keys(probs).sort()).toEqual([...(CHOICE as Record<string, string[]>)[key]].sort());
      }
    }
  });
});
