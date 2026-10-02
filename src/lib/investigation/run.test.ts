import { describe, expect, it, vi } from "vitest";
import { runInvestigation, type RunDeps, type SearchProvider } from "./run";
import type { InvestigationEvent } from "./contracts/events";
import type { InvestigationInput } from "./contracts/investigation";
import type { JevClient } from "../jev/client";
import type { SerpapiParams } from "../serpapi/client";
import type { FetchedPage } from "../pages/fetch";
import {
  getLimitations,
  getMetrics,
  getTakeaways,
  getTimeline,
} from "../stream/result-view";
import type { JsonRecord } from "../stream/result-view";

/* ------------------------------ fixtures ------------------------------ */

const MEDIA = new Uint8Array([1, 2, 3]);

const CHOICE_KEYS = {
  page_role: ["REPORTING", "FACT_CHECK", "SOCIAL_REPOST", "AGGREGATOR", "COMMENTARY", "OTHER"],
  context_relation: ["SAME_CONTEXT", "DIFFERENT_CONTEXT", "HISTORICAL_REFERENCE", "UNCLEAR"],
  claim_relation: ["SUPPORTS", "CONTRADICTS", "NEUTRAL", "INSUFFICIENT"],
  location_relation: ["SAME_LOCATION", "DIFFERENT_LOCATION", "LOCATION_NOT_STATED", "UNCLEAR"],
  pairwise_context: ["SAME_CONTEXT", "DIFFERENT_CONTEXT", "UNCLEAR"],
} as const;

const probs = (keys: readonly string[], winner: string, p = 0.85) =>
  Object.fromEntries(keys.map((k) => [k, k === winner ? p : (1 - p) / (keys.length - 1)]));

const choiceAnswers = (key: keyof typeof CHOICE_KEYS, winner: string) => ({
  type: "choice",
  choice: winner,
  probabilities: probs(CHOICE_KEYS[key], winner),
});

const EVIDENCE_ANSWERS = {
  relevance: { type: "noul", noul: 0.9 },
  page_role: choiceAnswers("page_role", "REPORTING"),
  context_relation: choiceAnswers("context_relation", "DIFFERENT_CONTEXT"),
  claim_relation: choiceAnswers("claim_relation", "NEUTRAL"),
  location_relation: choiceAnswers("location_relation", "LOCATION_NOT_STATED"),
};

const PAIRWISE_ANSWERS = { pairwise_context: choiceAnswers("pairwise_context", "SAME_CONTEXT") };

const lensAllJson = {
  search_metadata: { id: "lens-all-1", status: "Success" },
  visual_matches: [
    {
      position: 1,
      title: "Visual lead page",
      link: "https://a.example.com/story",
      thumbnail: "https://a.example.com/t.png",
      // §6.3 — navigation signal only; must NOT create an exact match.
      exact_matches: true,
      serpapi_exact_matches_link: "https://serpapi.com/search?x",
    },
    { position: 2, title: "Another lead", link: "https://b.example.com/post" },
  ],
  related_content: [{ query: "yamuna flood 2019", link: "https://google.com/q" }],
};

const lensExactJson = {
  search_metadata: { id: "lens-exact-1", status: "Success" },
  exact_matches: [
    { position: 1, title: "Exact copy", link: "https://c.example.com/old-article" },
    { position: 2, title: "Exact copy two", link: "https://d.example.com/page" },
  ],
};

const aboutJson = {
  about_this_image: {
    sections: [
      {
        page_results: [
          {
            position: 1,
            title: "Archived usage",
            link: "https://e.example.com/archived",
            date: "Jan 5, 2020",
          },
        ],
      },
    ],
  },
};

const googleJson = {
  search_metadata: { id: "g-1", status: "Success" },
  organic_results: [
    { position: 1, title: "Claim article", link: "https://f.example.com/news", snippet: "report" },
  ],
};

const newsJson = {
  search_metadata: { id: "n-1", status: "Success" },
  news_results: [
    { position: 1, title: "News hit", link: "https://g.example.com/item", date: "2 days ago" },
  ],
};

const PAGE: FetchedPage = {
  url: "https://a.example.com/story",
  html: `<html><head><title>Deep read</title>
    <script type="application/ld+json">{"datePublished":"2020-01-05"}</script>
    </head><body><article><p>${"Flood waters rose in the old district. ".repeat(30)}</p></article></body></html>`,
};

function makeSerpapi(calls: SerpapiParams[], overrides: Partial<SearchProvider> = {}): SearchProvider {
  return {
    uploadImage: vi.fn(async () => "img_test_1"),
    search: vi.fn(async (params: SerpapiParams) => {
      calls.push(params);
      if (params.engine === "google_lens" && params.type === "exact_matches") return lensExactJson;
      if (params.engine === "google_lens" && params.type === "about_this_image") return aboutJson;
      if (params.engine === "google_lens") return lensAllJson;
      if (params.engine === "google_news") return newsJson;
      return googleJson;
    }),
    ...overrides,
  };
}

const VERIFIED_IDENTITY = {
  requested: "jev-1.13.0",
  reported: "jev-1.13.0",
  status: "verified",
  pinned: true,
} as const;

function makeJev(askImpl?: (state: unknown, qs: Record<string, unknown>) => Promise<{ answers: Record<string, unknown>; model: string | null; identity: typeof VERIFIED_IDENTITY }>) {
  const ask = vi.fn(
    askImpl ??
      (async (_s, qs) => ({
        answers:
          "pairwise_context" in qs ? PAIRWISE_ANSWERS : { ...EVIDENCE_ANSWERS },
        model: "jev-1.13.0",
        identity: VERIFIED_IDENTITY,
      })),
  );
  return { client: { ask } as unknown as JevClient, ask };
}

function run(input: InvestigationInput, deps: Partial<RunDeps>) {
  const events: InvestigationEvent[] = [];
  const promise = runInvestigation(
    input,
    (e) => events.push(e),
    {
      serpapi: null,
      jev: null,
      fetchPage: async () => PAGE,
      ...deps,
    } as RunDeps,
  );
  return { events, promise };
}

const traceInput: InvestigationInput = { claim: null, timezone: "UTC", locale: "en", media: MEDIA };
const claimInput: InvestigationInput = {
  claim: "This photo shows flooding in Delhi today",
  timezone: "UTC",
  locale: "en",
  media: MEDIA,
};

const last = (events: InvestigationEvent[]) => events[events.length - 1];

/* -------------------------------- tests ------------------------------- */

describe("runInvestigation — happy path", () => {
  it("searches reviewed public media without any image upload, including adaptive Lens", async () => {
    const calls: SerpapiParams[] = [];
    const serpapi = makeSerpapi(calls);
    const { client } = makeJev();
    const { events, promise } = run({ ...traceInput, media: new Uint8Array(), publicImageId: "nasa-earthrise" }, { serpapi, jev: client, fetchPage: async () => PAGE });
    await promise;
    expect(serpapi.uploadImage).not.toHaveBeenCalled();
    const lens = calls.filter(c => c.engine === "google_lens");
    expect(lens.length).toBeGreaterThanOrEqual(2);
    for (const params of lens) {
      expect(params.url).toBe("https://www.nasa.gov/wp-content/uploads/2024/06/as08-14-2383orig.jpg");
      expect(params.image_id).toBeUndefined();
      expect(params.type).not.toBe("about_this_image");
    }
    expect(last(events).type).toBe("investigation.completed");
  });
  it("trace mode runs the DAG and completes with a trace result", async () => {
    const calls: SerpapiParams[] = [];
    const { client } = makeJev();
    const { events, promise } = run(traceInput, {
      serpapi: makeSerpapi(calls),
      jev: client,
      fetchPage: async () => PAGE,
    });
    await promise;

    expect(events[0].type).toBe("investigation.started");
    // Terminal event is last; the COMPLETE stage is finished beforehand so a
    // client that stops reading at investigation.completed loses nothing.
    expect(last(events).type).toBe("investigation.completed");
    const completeIdx = events.findIndex(
      (e) => e.type === "stage.completed" && (e as { stage: string }).stage === "COMPLETE",
    );
    const doneIdx = events.findIndex((e) => e.type === "investigation.completed");
    expect(completeIdx).toBeGreaterThanOrEqual(0);
    expect(completeIdx).toBeLessThan(doneIdx);
    const done = events.find((e) => e.type === "investigation.completed");
    expect(done).toBeDefined();
    const result = (done as unknown as { result: JsonRecord }).result;
    expect(result.mode).toBe("trace");
    expect(result.status).toBeUndefined(); // trace never emits claim status
    expect(Array.isArray(result.timeline)).toBe(true);
    expect(Array.isArray(result.undatedEvidence)).toBe(true);
    expect(Array.isArray(result.limitations)).toBe(true);

    // Budget: trace = 3 base lens calls (+ ≤1 adaptive) — assert bound.
    expect(calls.length).toBeLessThanOrEqual(4);
    expect(calls.filter((c) => c.type === "exact_matches")).toHaveLength(1);
    expect(calls.filter((c) => c.type === "about_this_image")).toHaveLength(0);
    expect(result.limitations).toContain("about_this_image_unavailable");
    // exact_matches/about_this_image must not carry `q` (§6.4).
    for (const c of calls) {
      if (c.type === "exact_matches" || c.type === "about_this_image") {
        expect(c.q).toBeUndefined();
      }
    }
  });

  it("claim-check mode issues 5 base searches max 6 total and emits a status", async () => {
    const calls: SerpapiParams[] = [];
    const { client } = makeJev();
    const { events, promise } = run(claimInput, {
      serpapi: makeSerpapi(calls),
      jev: client,
      fetchPage: async () => PAGE,
    });
    await promise;

    expect(calls.length).toBeLessThanOrEqual(6);
    expect(calls.filter((c) => c.engine === "google")).toHaveLength(1);
    expect(calls.filter((c) => c.engine === "google_news")).toHaveLength(1);

    const done = events.find((e) => e.type === "investigation.completed") as unknown as
      | { result: JsonRecord }
      | undefined;
    expect(done).toBeDefined();
    const result = done!.result;
    expect(result.mode).toBe("claim_check");
    expect(typeof result.status).toBe("string");
    expect((result.takeaways as unknown[]).length).toBeLessThanOrEqual(3);
    expect(events.some((e) => e.type === "verdict.preliminary")).toBe(true);
    expect(events.some((e) => e.type === "provenance.partial")).toBe(true);

    // UI selectors render the real result without fixtures.
    expect(getTimeline(result).dated.length + getTimeline(result).unknownDate.length).toBeGreaterThan(0);
    expect(getMetrics(result).sourceDomains).not.toBeNull();
    getTakeaways(result);
    getLimitations(result).forEach((l) => expect(typeof l).toBe("string"));
  });
  it("emits each evidence.discovered id at most once across adaptive expansion", async () => {
    // Regression: candidates without a snippet were re-emitted after the
    // adaptive search because "already emitted" was proxied by the excerpts
    // map (only populated when snippet !== null) → duplicate client keys.
    const calls: SerpapiParams[] = [];
    const { events, promise } = run(traceInput, {
      serpapi: makeSerpapi(calls),
      jev: makeJev().client,
      fetchPage: async () => PAGE,
    });
    await promise;

    // The trace adaptive slot actually fired on the related_content query.
    expect(calls.some((c) => c.engine === "google" && c.q === "yamuna flood 2019")).toBe(true);

    const ids = events
      .filter((e) => e.type === "evidence.discovered")
      .map((e) => (e as unknown as { evidence: { id: string } }).evidence.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("identity invariants (§10–11)", () => {
  it("visual exact-match flags never promote a lead to EXACT_MATCH", async () => {
    const { events, promise } = run(traceInput, {
      serpapi: makeSerpapi([]),
      jev: makeJev().client,
      fetchPage: async () => PAGE,
    });
    await promise;
    const discovered = events.filter((e) => e.type === "evidence.discovered") as Array<{
      evidence: {
        canonicalUrl: string;
        mediaRelationship: string | null;
        retrievalKind: string;
      };
    }>;
    for (const d of discovered) {
      if (d.evidence.retrievalKind === "lens_visual") {
        expect(d.evidence.mediaRelationship).toBe("VISUAL_LEAD");
      }
      if (d.evidence.retrievalKind === "lens_exact") {
        expect(d.evidence.mediaRelationship).toBe("EXACT_MATCH");
      }
    }
    // The entry carrying the provider navigation flag stays a lead.
    const flagged = discovered.find(
      (d) => d.evidence.canonicalUrl === "https://a.example.com/story",
    );
    expect(flagged?.evidence.mediaRelationship).toBe("VISUAL_LEAD");
  });
});

describe("honest failures (§29)", () => {
  it("unconfigured provider => VISUAL_SEARCH_FAILED naming only the env key", async () => {
    const { events, promise } = run(traceInput, { serpapi: null });
    await promise;
    const err = last(events) as { type: string; code: string; message: string };
    expect(err.type).toBe("investigation.error");
    expect(err.code).toBe("VISUAL_SEARCH_FAILED");
    expect(err.message).toContain("SERPAPI_API_KEY");
  });

  it("upload failure fails all lens slots and reports IMAGE_UPLOAD_FAILED", async () => {
    const serpapi = makeSerpapi([], { uploadImage: vi.fn(async () => Promise.reject(new Error("boom"))) });
    const { events, promise } = run(traceInput, { serpapi });
    await promise;
    const err = last(events) as { type: string; code: string };
    expect(err.type).toBe("investigation.error");
    expect(err.code).toBe("IMAGE_UPLOAD_FAILED");
  });

  it("all lens calls failing => VISUAL_SEARCH_FAILED, never a fabricated result", async () => {
    const serpapi = makeSerpapi([], { search: vi.fn(async () => ({ error: "provider said no" })) });
    const { events, promise } = run(traceInput, { serpapi });
    await promise;
    const err = last(events) as { type: string; code: string };
    expect(err.type).toBe("investigation.error");
    expect(err.code).toBe("VISUAL_SEARCH_FAILED");
    expect(events.some((e) => e.type === "investigation.completed")).toBe(false);
  });

  it("jev unavailable still completes with a classification limitation", async () => {
    const { events, promise } = run(traceInput, { serpapi: makeSerpapi([]), jev: null });
    await promise;
    const done = events.find((e) => e.type === "investigation.completed") as unknown as { result: JsonRecord };
    expect(done).toBeDefined();
    expect(done.result.limitations as unknown[]).toContain("semantic_classification_unavailable");
  });
});

describe("cancellation & deadline (§27–28)", () => {
  it("aborted caller signal stops the run without an error event", async () => {
    const aborted = AbortSignal.abort(new Error("client gone"));
    const serpapi = makeSerpapi([], {
      search: vi.fn((_p: SerpapiParams, signal?: AbortSignal) =>
        signal?.aborted
          ? Promise.reject(new Error("aborted"))
          : new Promise((_, rej) =>
              signal?.addEventListener("abort", () => rej(new Error("aborted")), { once: true }),
            ),
      ),
      uploadImage: vi.fn((_m: Uint8Array, signal?: AbortSignal) =>
        signal?.aborted ? Promise.reject(new Error("aborted")) : Promise.resolve("x"),
      ),
    });
    const { events, promise } = run(traceInput, { serpapi, signal: aborted });
    await promise;
    expect(events.every((e) => e.type !== "investigation.completed")).toBe(true);
    expect(events.every((e) => e.type !== "investigation.error")).toBe(true);
  });

  it("the 55s deadline aborts in-flight calls and reports DEADLINE_EXCEEDED", async () => {
    // Fake clock advancing 60s per call: the real deadline timer fires in ~1ms
    // and every deadlineHit() check reads a time far past the deadline.
    let t = 0;
    const now = () => (t += 60_000);
    const hang = (_p: unknown, signal?: AbortSignal) =>
      signal?.aborted
        ? Promise.reject(new Error("aborted"))
        : new Promise<never>((_, rej) =>
            signal?.addEventListener("abort", () => rej(new Error("aborted")), { once: true }),
          );
    const serpapi: SearchProvider = {
      uploadImage: vi.fn((_m: Uint8Array, s?: AbortSignal) => hang(_m, s)),
      search: vi.fn(hang),
    };
    const { events, promise } = run(traceInput, { serpapi, now });
    await promise;
    const err = last(events) as { type: string; code: string };
    expect(err.type).toBe("investigation.error");
    expect(err.code).toBe("DEADLINE_EXCEEDED");
  });
});
