/**
 * Investigation orchestrator (spec §9 DAG, §26 pseudocode, §27–29).
 *
 * Drives the bounded retrieval → classify → refine → policy pipeline for one
 * request and emits §24.2 events through `emit`. All provider work shares one
 * AbortSignal: request abort, response cancellation, and the 55s deadline all
 * cancel in-flight calls. Budget rules live in `SearchBudget`; every search
 * consumes its slot before dispatch.
 *
 * Dependency injection (`deps`) keeps the production route thin and lets
 * tests substitute mocked providers — fixture fallback in production is
 * forbidden (§40), this seam exists only for that purpose.
 */

import { CaseValidationError } from "../cases/parse";
import { caseFromImageInvestigation } from "../cases/from-image-investigation";
import { readFailure, type PageReadOutcome } from "./report";
import type { EvidenceCandidate, RetrievalKind } from "./contracts/evidence";
import type {
  InvestigationEvent,
  InvestigationErrorCode,
  Stage,
} from "./contracts/events";
import type {
  ComparisonCoverage,
  InvestigationInput,
  InvestigationResult,
  LimitationCode,
  Takeaway,
} from "./contracts/investigation";
import { modeForInput, toPublicCandidate } from "./contracts/investigation";
import { PUBLIC_IMAGES } from "../media/public-images";
import type { PairwiseContextJudgment } from "./contracts/judgment";
import { SearchBudget, type BaseSearchSlot, type SearchTicket } from "./budget";
import { dedupeByCanonicalUrl, applyRetentionCaps, selectForClassification } from "./candidates";
import { mergeEvidenceDateSources, parseClaimDate, resolveEvidenceDate, type EvidenceDateSources } from "./dates";
import {
  datedCoreOccurrences,
  pairKey,
  selectDatedCoreOccurrences,
  strictlyBefore,
} from "./divergence";
import {
  chooseClaimExpansion,
  chooseTraceExpansion,
  decideClaimExpansion,
  decideTraceExpansion,
  type ClaimExpansionChoice,
} from "./expansion";
import { enforceIdentityInvariants } from "./identity";
import { coreOccurrences, unresolvedOriginCount } from "./reporting-origins";
import { CONCURRENCY, TIMEOUTS, MAX_DEEP_READ_PAGES, MAX_JEV_CANDIDATES, RETENTION_CAPS } from "./limits";
import { refineReportingOrigins } from "./origin-evidence";
import {
  buildClaimResult,
  buildTraceResult,
  deriveTakeaways,
  evaluateClaimPolicy,
  hasStrongSupport,
  isQualifyingConflict,
} from "./policy";
import { buildTimeline } from "./timeline";
import { buildProvenanceGraph } from "./provenance-graph";
import type { JevClient } from "../jev/client";
import {
  judgmentFromAnswers,
  pairwiseFromAnswers,
  verifiedPinnedModel,
} from "../jev/client";
import {
  PAIRWISE_QUESTION,
  candidateState,
  claimLocationEligibility,
  evidenceQuestions,
  pairwiseState,
} from "../jev/questions";
import { createLimiter, ProviderError } from "../providers/http";
import type { FetchedPage } from "../pages/fetch";
import { bindFetchedSource } from "../pages/source-binding";
import { candidateFromSourceLink } from "./linked-history";
import { canonicalizeUrl } from "./url";
import { retainableSourceUrl } from "../pages/source-reference";
import { buildExcerpt, extractPage, selectDisplayQuote } from "../pages/extract";
import {
  normalizeAboutThisImageResponse,
  normalizeExactMatchesResponse,
  normalizeLensAllResponse,
  normalizeSearchResponse,
  recordDateSources,
  type NormalizedBatch,
} from "../serpapi/normalize";
import { serpapiResponseFailed, type SerpapiParams } from "../serpapi/client";
import { EXCERPT_MAX_CHARS } from "./limits";

/** Minimal provider surface the orchestrator needs (§6). */
export interface SearchProvider {
  search(params: SerpapiParams, signal?: AbortSignal): Promise<unknown>;
  uploadImage(media: Uint8Array, signal?: AbortSignal): Promise<string>;
}

export interface RunDeps {
  /** SerpApi provider; null/undefined = unconfigured (honest failure). */
  serpapi: SearchProvider | null;
  /** TypeSafe Jev client; null/undefined = classification unavailable. */
  jev: JevClient | null;
  /** Safe page fetcher for deep reads. */
  fetchPage: (url: string, signal?: AbortSignal) => Promise<FetchedPage>;
  /** Shared cancellation: request abort + stream cancel + deadline. */
  signal?: AbortSignal;
  now?: () => number;
}

type Emit = (event: InvestigationEvent) => void;

interface SearchJobResult {
  slot: BaseSearchSlot | "adaptive";
  engineLabel: string;
  batch: NormalizedBatch | null;
  failed: boolean;
}

const EMPTY_COVERAGE: ComparisonCoverage = {
  eligible: 0,
  selected: 0,
  comparedPairs: 0,
  displayedDatedCore: 0,
  comparedPairIds: [],
};

/**
 * Sanitized server-side diagnostic for provider failures: error category
 * and HTTP status only — never URLs (they may carry credentials), never
 * response bodies, never request parameters (§5.5, §29).
 */
function providerFailureCategory(err: unknown): string {
  if (err instanceof ProviderError) {
    return err.status !== null ? `${err.kind} http=${err.status}` : err.kind;
  }
  return "error";
}

function logProviderFailure(surface: string, err: unknown): void {
  try {
    console.warn(`[investigate] ${surface} failed: ${providerFailureCategory(err)}`);
  } catch {
    // diagnostics must never break the pipeline
  }
}

/**
 * §18 — choose up to 5 pages for deep reading in the frozen order:
 * earliest dated core (or strongest judged undated core if none is dated),
 * strongest conflict from another domain with
 * unresolved origin, strongest same-context/support, strongest fact-check,
 * strongest current-reporting candidate.
 */
export function selectDeepReadCandidates(
  candidates: readonly EvidenceCandidate[],
  max = MAX_DEEP_READ_PAGES,
): EvidenceCandidate[] {
  const picked: EvidenceCandidate[] = [];
  const seen = new Set<string>();
  const take = (c: EvidenceCandidate | null | undefined) => {
    if (c && !seen.has(c.id) && picked.length < max) {
      picked.push(c);
      seen.add(c.id);
    }
  };
  const byRel = (list: EvidenceCandidate[]) =>
    list.sort(
      (a, b) =>
        (b.judgment?.relevance ?? 0) - (a.judgment?.relevance ?? 0) ||
        (a.serpPosition ?? 1e9) - (b.serpPosition ?? 1e9) ||
        a.id.localeCompare(b.id),
    );

  const datedCore = datedCoreOccurrences(candidates);
  // Sparse exact-match metadata often has no date. Preserve one opportunity
  // to read that image occurrence before higher-scoring contextual pages
  // consume the five-page cap. Selection acquires evidence; it does not
  // change relevance, identity, dates, origins, or final-policy thresholds.
  const coreAnchor = datedCore[0] ?? byRel(
    coreOccurrences(candidates).filter((c) => c.judgment !== null),
  )[0];
  take(coreAnchor);

  const firstDomain = coreAnchor?.registrableDomain;
  const conflicts = byRel(
    candidates.filter(
      (c) =>
        isQualifyingConflict(c) &&
        c.reportingOrigin.status === "unresolved" &&
        c.registrableDomain !== firstDomain,
    ),
  );
  take(conflicts[0]);

  take(byRel(candidates.filter(hasStrongSupport))[0]);

  // §18 "strongest fact-check": category priority comes BEFORE the
  // relevance tie-break — higher-relevance commentary must not crowd out
  // the strongest fact-check candidate.
  take(
    [...candidates]
      .filter((c) => (c.judgment?.pageRole.factCheck ?? 0) > 0)
      .sort(
        (a, b) =>
          (b.judgment?.pageRole.factCheck ?? 0) - (a.judgment?.pageRole.factCheck ?? 0) ||
          (b.judgment?.relevance ?? 0) - (a.judgment?.relevance ?? 0) ||
          (a.serpPosition ?? 1e9) - (b.serpPosition ?? 1e9) ||
          a.id.localeCompare(b.id),
      )[0],
  );

  take(
    byRel(
      candidates.filter(
        (c) => c.retrievalKind === "google_news" || (c.judgment?.pageRole.reporting ?? 0) >= 0.75,
      ),
    )[0],
  );

  // When dates are missing, use unclaimed slots to inspect additional image
  // occurrences before contextual filler. A failed anchor must not be the
  // only opportunity to acquire source-bound dates. Fixed priorities above
  // and the five-page ceiling stay intact; selection does not promote evidence.
  if (datedCore.length === 0) {
    const unreadCore = byRel(coreOccurrences(candidates).filter((c) => c.judgment !== null && !seen.has(c.id)));
    const domains = new Set(picked.map((c) => c.registrableDomain));
    for (const c of unreadCore) {
      if (!domains.has(c.registrableDomain)) {
        take(c);
        domains.add(c.registrableDomain);
      }
    }
    for (const c of unreadCore) take(c);
  }

  // Fill any remaining budget with the strongest unseen judged candidates —
  // the frozen categories pick one winner each and must not leave slots
  // empty while unexamined relevant evidence exists (§18).
  for (const c of byRel(
    candidates.filter((c) => c.judgment !== null && !seen.has(c.id)),
  )) {
    if (picked.length >= max) break;
    take(c);
  }

  return picked;
}

/**
 * Run one investigation end to end. Emits events in §24.2 order; all
 * failures are explicit — either as an `investigation.error` event or as
 * limitations on the completed result. Resolves when finished; never throws.
 */
export async function runInvestigation(
  input: InvestigationInput,
  emit: Emit,
  deps: RunDeps,
): Promise<void> {
  const now = deps.now ?? (() => Date.now());
  const mode = modeForInput(input);
  const claim = mode === "claim_check" ? input.claim!.trim() : null;
  const budget = new SearchBudget(mode, false);
  const startedAt = now();
  const deadlineAt = startedAt + TIMEOUTS.investigationDeadlineMs;
  const retrievedAt = new Date(startedAt).toISOString();
  const investigationId = crypto.randomUUID();

  // One signal to rule them all: caller abort OR 55s deadline.
  const shared = new AbortController();
  const deadlineTimer = setTimeout(() => shared.abort(new Error("deadline")), Math.max(1, deadlineAt - now()));
  const onExternalAbort = () => shared.abort(deps.signal?.reason);
  if (deps.signal?.aborted) onExternalAbort();
  else deps.signal?.addEventListener("abort", onExternalAbort, { once: true });
  const deadlineHit = () => now() >= deadlineAt || shared.signal.aborted;
  const callerAborted = () => deps.signal?.aborted === true;

  const candidates: EvidenceCandidate[] = [];
  const seenIds = new Set<string>();
  /** Ids already emitted via evidence.discovered — each evidence id is
   *  emitted at most once per investigation (a re-emit produces duplicate
   *  client keys). */
  const emittedEvidenceIds = new Set<string>();
  const dateSources = new Map<string, EvidenceDateSources>();
  const relatedQueries: string[] = [];
  /** Model input — the bounded excerpt Jev actually judged (composite). */
  const excerpts = new Map<string, string>();
  /** Displayed quote — verbatim page text when available (§18.3). What
   *  the model judged and what the UI quotes are tracked separately. */
  const displayExcerpts = new Map<string, string>();
  const pageTexts = new Map<string, string>();
  const limitations = new Set<LimitationCode>();
  let webContextAvailable = true;
  let hasCurrentNewsResults = false;
  let uploadFailed = false;
  let imageId: string | null = null;
  let claimDate: string | null = null;
  let claimDatePrecision: "day" | "month" | "year" | "unknown" = "unknown";

  /**
   * Sanitized structured telemetry (§29): counts, durations, and bounded
   * identifiers only — never URLs, request parameters, response bodies,
   * or secrets. One record per completed stage plus a final summary.
   */
  const telemetry = {
    jevAttempted: 0,
    jevSucceeded: 0,
    pairwiseAttempted: 0,
    /** Per-search attempt records — the batch is retained for request
     *  attribution only and is stripped before any record is logged. */
    searches: [] as Array<{
      slot: string;
      engine: string;
      ok: boolean;
      count: number;
      ms: number;
      batch: NormalizedBatch | null;
    }>,
    /** Per-Jev call records — duration plus the *status* of the returned
     *  identity; the model label is emitted only when verified/pinned and
     *  is never the raw provider string. */
    jevCalls: [] as Array<{
      kind: "classify" | "pairwise";
      ms: number;
      identityStatus: string;
      model: string | null;
    }>,
    pagesAttempted: 0,
    pagesSucceeded: 0,
  };
  const logTelemetry = (record: Record<string, unknown>) => {
    try {
      console.info(`[investigate] telemetry ${JSON.stringify(record)}`);
    } catch {
      // diagnostics must never break the pipeline
    }
  };

  const stageStartedAt = new Map<Stage, number>();
  const stage = (s: Stage, phase: "started" | "completed", detail?: string) => {
    if (phase === "started") {
      stageStartedAt.set(s, now());
      emit({ type: "stage.started", stage: s });
    } else {
      const t0 = stageStartedAt.get(s);
      emit({ type: "stage.completed", stage: s, ...(detail ? { detail } : {}) });
      logTelemetry({
        kind: "stage",
        investigationId,
        stage: s,
        ms: t0 === undefined ? null : Math.max(0, now() - t0),
      });
    }
  };

  const emitDiscovered = (c: EvidenceCandidate) => {
    if (emittedEvidenceIds.has(c.id)) return;
    emittedEvidenceIds.add(c.id);
    emit({
      type: "evidence.discovered",
      evidence: toPublicCandidate(
        c,
        displayExcerpts.get(c.id) ?? excerpts.get(c.id) ?? null,
      ),
    });
  };

  const addCandidates = (batch: NormalizedBatch | null): EvidenceCandidate[] => {
    if (batch === null) return [];
    const added: EvidenceCandidate[] = [];
    for (const c of batch.candidates) {
      if (!seenIds.has(c.id)) {
        seenIds.add(c.id);
        candidates.push(c);
        added.push(c);
      }
    }
    for (const q of batch.relatedQueries) {
      if (!relatedQueries.includes(q)) relatedQueries.push(q);
    }
    recordDateSources(dateSources, batch);
    return added;
  };

  /** Re-resolve a candidate's date fields from its current source map
   *  and append any newly rejected date candidates (deduped). */
  const applyResolvedDate = (c: EvidenceCandidate): void => {
    const resolved = resolveEvidenceDate(
      dateSources.get(c.id) ?? {},
      new Date(startedAt),
    );
    c.publishedAt = resolved.publishedAt;
    c.publishedAtSource = resolved.publishedAtSource;
    c.datePrecision = resolved.datePrecision;
    c.dateStatus = resolved.dateStatus;
    if (resolved.rejected.length > 0) {
      const existing = c.rejectedDateCandidates ?? [];
      const seen = new Set(existing.map((r) => `${r.value}|${r.reason}`));
      for (const r of resolved.rejected) {
        const key = `${r.value}|${r.reason}`;
        if (!seen.has(key)) {
          existing.push(r);
          seen.add(key);
        }
      }
      c.rejectedDateCandidates = existing;
    }
  };

  /** §11/§19.2 — URL dedupe keeps one candidate per canonical URL, but
   *  provider date texts were recorded per retrieved id. Consolidate
   *  every retired id's date sources onto the surviving pool member so
   *  later page precedence resolves against the URL's full source set
   *  instead of losing merged-away dates (I2). */
  const consolidateDateSources = (
    retained: readonly EvidenceCandidate[],
  ): void => {
    const byUrl = new Map<string, EvidenceDateSources>();
    for (const c of candidates) {
      const src = dateSources.get(c.id);
      if (src === undefined) continue;
      byUrl.set(
        c.canonicalUrl,
        mergeEvidenceDateSources(byUrl.get(c.canonicalUrl) ?? {}, src),
      );
    }
    for (const c of retained) {
      const merged = byUrl.get(c.canonicalUrl);
      if (merged !== undefined) dateSources.set(c.id, merged);
    }
  };

  /** Resolve a candidate's evidence date + excerpt provenance, then emit
   *  evidence.discovered (once per id — see emitDiscovered). */
  const prepareAndDiscover = (c: EvidenceCandidate): void => {
    applyResolvedDate(c);
    c.excerptSource = c.snippet !== null ? "serp_snippet" : null;
    if (c.snippet !== null) excerpts.set(c.id, c.snippet);
    emitDiscovered(c);
  };

  const serpLimiter = createLimiter(CONCURRENCY.serpapiSearch);

  const runSearch = async (
    slot: BaseSearchSlot,
    engineLabel: string,
    params: SerpapiParams,
    normalize: (json: unknown) => NormalizedBatch,
  ): Promise<SearchJobResult> => {
    const ticket = budget.reserveBase(slot);
    if (ticket === null) return { slot, engineLabel, batch: null, failed: true };
    const t0 = now();
    try {
      const json = await serpLimiter(() => deps.serpapi!.search(params, shared.signal));
      const ms = Math.max(0, now() - t0);
      if (serpapiResponseFailed(json)) {
        try {
          console.warn(`[investigate] serpapi ${slot} reported provider error`);
        } catch { /* diagnostics never break the pipeline */ }
        telemetry.searches.push({ slot, engine: engineLabel, ok: false, count: 0, ms, batch: null });
        ticket.fail();
        return { slot, engineLabel, batch: null, failed: true };
      }
      ticket.succeed();
      const batch = normalize(json);
      telemetry.searches.push({ slot, engine: engineLabel, ok: true, count: batch.reportedCount, ms, batch });
      emit({ type: "search.batch", engine: engineLabel, count: batch.reportedCount });
      return { slot, engineLabel, batch, failed: false };
    } catch (err) {
      logProviderFailure(`serpapi ${slot}`, err);
      telemetry.searches.push({ slot, engine: engineLabel, ok: false, count: 0, ms: Math.max(0, now() - t0), batch: null });
      ticket.fail();
      return { slot, engineLabel, batch: null, failed: true };
    }
  };

  const runAdaptiveSearch = async (
    ticket: SearchTicket,
    choice: ClaimExpansionChoice,
    imageIdForLens: string | null,
  ): Promise<SearchJobResult> => {
    const params: SerpapiParams = { ...choice.params };
    if (choice.slot === "adaptive_lens_refined") {
      if (input.publicImageUrl) params.url = input.publicImageUrl;
      else if (input.publicImageId) params.url = PUBLIC_IMAGES[input.publicImageId].url;
      else if (imageIdForLens !== null) params.image_id = imageIdForLens;
    }
    const t0 = now();
    try {
      const json = await serpLimiter(() => deps.serpapi!.search(params, shared.signal));
      const ms = Math.max(0, now() - t0);
      if (serpapiResponseFailed(json)) {
        try {
          console.warn(`[investigate] serpapi ${choice.slot} reported provider error`);
        } catch { /* diagnostics never break the pipeline */ }
        telemetry.searches.push({ slot: choice.slot, engine: "expansion", ok: false, count: 0, ms, batch: null });
        ticket.fail();
        return { slot: "adaptive", engineLabel: "expansion", batch: null, failed: true };
      }
      ticket.succeed();
      const batch =
        choice.slot === "adaptive_lens_refined"
          ? normalizeLensAllResponse(json, { retrievedAt: new Date().toISOString() })
          : normalizeSearchResponse(json, "google_search", { retrievedAt: new Date().toISOString() });
      telemetry.searches.push({ slot: choice.slot, engine: "expansion", ok: true, count: batch.reportedCount, ms, batch });
      emit({ type: "search.batch", engine: "expansion", count: batch.reportedCount });
      return { slot: "adaptive", engineLabel: "expansion", batch, failed: false };
    } catch (err) {
      logProviderFailure(`serpapi ${choice.slot}`, err);
      telemetry.searches.push({ slot: choice.slot, engine: "expansion", ok: false, count: 0, ms: Math.max(0, now() - t0), batch: null });
      ticket.fail();
      return { slot: "adaptive", engineLabel: "expansion", batch: null, failed: true };
    }
  };

  const jevLimiter = createLimiter(CONCURRENCY.jev);
  // §16.5 — the typed eligibility record is retained so the rationale
  // (bounded reason codes, matched spans) is inspectable, not just the
  // boolean.
  const locationEligibility =
    claim !== null ? claimLocationEligibility(claim) : null;
  const claimHasLocation = locationEligibility?.eligible === true;
  /** Successful Jev classifications this run — distinguishes "all calls
   *  failed" (unavailable) from an ordinary partial batch. */
  let jevSuccesses = 0;
  /** §14 — ids admitted to the distinct-candidate classification
   *  allowance. An attempt consumes the slot even on failure; re-asks
   *  (deep-read refinement) and retries of an admitted id are free, but
   *  a *new* candidate id is never admitted once the allowance is
   *  exhausted — adaptive expansion cannot reopen it (I1). */
  const classifiedIds = new Set<string>();
  /** Plan a classify batch: already-admitted ids keep their slots;
   *  fresh ids are admitted in the caller's preference order only while
   *  allowance remains. */
  const planClassifications = (
    list: readonly EvidenceCandidate[],
  ): EvidenceCandidate[] => {
    const planned: EvidenceCandidate[] = [];
    for (const c of list) {
      if (classifiedIds.has(c.id)) {
        planned.push(c);
        continue;
      }
      if (classifiedIds.size >= MAX_JEV_CANDIDATES) continue;
      classifiedIds.add(c.id);
      planned.push(c);
    }
    return planned;
  };
  /** Record the honest classification limitation for a batch result. */
  const noteClassifyOutcome = (attempted: number, succeeded: number) => {
    if (attempted === 0) return;
    if (succeeded === 0 && jevSuccesses === 0) {
      limitations.add("semantic_classification_unavailable");
    } else if (succeeded < attempted) {
      limitations.add("semantic_classification_partial");
    }
  };

  /** §16 — classify one candidate; judgment stays null on failure (§29).
   *  Past the deadline no new semantic work dispatches — the run finalizes
   *  with the evidence already in hand (§26/§28). */
  const classifyOne = async (c: EvidenceCandidate): Promise<boolean> => {
    if (
      deps.jev === null ||
      c.judgment !== null ||
      !classifiedIds.has(c.id) ||
      deadlineHit()
    ) {
      return false;
    }
    telemetry.jevAttempted += 1;
    const t0 = now();
    try {
      const excerpt = excerpts.get(c.id) ?? c.snippet;
      const res = await jevLimiter(() =>
        deps.jev!.ask(
          candidateState(c, claim, excerpt),
          evidenceQuestions({ claimMode: mode === "claim_check", claimHasLocation }),
          shared.signal,
        ),
      );
      telemetry.jevCalls.push({
        kind: "classify",
        ms: Math.max(0, now() - t0),
        identityStatus: res.identity.status,
        model: verifiedPinnedModel(res.identity),
      });
      const judgment = judgmentFromAnswers(res.answers, {
        claimMode: mode === "claim_check",
        provenance: res.identity,
      });
      if (judgment === null) {
        logProviderFailure(`jev answers malformed for ${c.id}`, new ProviderError("malformed", "jev answers failed validation"));
        return false;
      }
      c.judgment = judgment;
      jevSuccesses += 1;
      telemetry.jevSucceeded += 1;
      emit({ type: "evidence.classified", id: c.id, publicJudgment: judgment });
      return true;
    } catch (err) {
      telemetry.jevCalls.push({
        kind: "classify",
        ms: Math.max(0, now() - t0),
        identityStatus: "call_failed",
        model: null,
      });
      logProviderFailure(`jev classify for ${c.id}`, err);
      return false;
    }
  };

  try {
    emit({ type: "investigation.started", investigationId });
    if (claim !== null) {
      const parsed = parseClaimDate(claim, {
        referenceInstant: new Date(startedAt),
        timezone: input.timezone,
      });
      claimDate = parsed.claimDate;
      claimDatePrecision = parsed.precision;
      if (claimDate === null) limitations.add("claim_date_unresolved");
    }

    /* ------------------------- INITIAL_RETRIEVAL ------------------------- */
    stage("INITIAL_RETRIEVAL", "started");
    // Google discontinued this surface; never spend credit on its unsupported type.
    limitations.add("about_this_image_unavailable");
    const jobs: Promise<void>[] = [];

    /**
     * Per-job settle processing (§10): each batch's new candidates are
     * discovered as soon as their job resolves — not gated on the slowest
     * job — and per-slot failures become honest limitations immediately.
     */
    const processResult = (res: SearchJobResult): void => {
      for (const c of addCandidates(res.batch)) prepareAndDiscover(c);
      if (res.slot === "google_search_claim" && res.failed) {
        webContextAvailable = false;
        limitations.add("web_context_unavailable");
      }
      if (res.slot === "google_news_claim" && res.batch !== null && res.batch.reportedCount > 0) {
        hasCurrentNewsResults = true;
      }
      if (res.slot === "lens_exact_matches" && res.batch !== null) {
        const exactState = (res.batch as { exactState?: string }).exactState;
        if (exactState === "empty") limitations.add("no_exact_occurrences_returned");
        if (exactState === "malformed" || exactState === "unavailable") {
          limitations.add("exact_match_retrieval_unavailable");
        }
      }
      if (
        res.slot === "lens_about_this_image" &&
        (res.failed ||
          (res.batch !== null && res.batch.surfacePresent === false))
      ) {
        limitations.add("about_this_image_unavailable");
      }
      if (res.slot === "google_news_claim" && res.failed) {
        limitations.add("news_unavailable");
      }
    };

    if (claim !== null && deps.serpapi !== null) {
      jobs.push(
        runSearch(
          "google_search_claim",
          "google_search",
          { engine: "google", q: claim },
          (j) => normalizeSearchResponse(j, "google_search", { retrievedAt }),
        ).then(processResult),
      );
      jobs.push(
        runSearch(
          "google_news_claim",
          "google_news",
          { engine: "google_news", q: claim },
          (j) => normalizeSearchResponse(j, "google_news", { retrievedAt }),
        ).then(processResult),
      );
    } else if (claim !== null) {
      // Unconfigured provider: consume base slots as failed, honestly.
      for (const slot of ["google_search_claim", "google_news_claim"] as const) {
        budget.reserveBase(slot)?.fail();
      }
    }

    const failedLensJobs = (): SearchJobResult[] => {
      const slots: Array<[BaseSearchSlot, string]> = [
        ["lens_all", "google_lens"],
        ["lens_exact_matches", "google_lens_exact_matches"],
      ];
      return slots.map(([slot, engineLabel]) => {
        budget.reserveBase(slot)?.fail();
        return { slot, engineLabel, batch: null, failed: true };
      });
    };

    const uploadAndLens = async (): Promise<void> => {
      if (deps.serpapi === null || (!input.publicImageId && !input.publicImageUrl && !budget.tryReserveUpload())) {
        uploadFailed = deps.serpapi !== null;
        for (const res of failedLensJobs()) processResult(res);
        return;
      }
      try {
        if (!input.publicImageId && !input.publicImageUrl) imageId = await deps.serpapi.uploadImage(input.media, shared.signal);
      } catch (err) {
        logProviderFailure("serpapi image upload", err);
        uploadFailed = true;
        for (const res of failedLensJobs()) processResult(res);
        return;
      }
      // Supported Lens calls settle independently. A reviewed public URL avoids
      // Image API upload entirely; private uploads retain their original path.
      const imageParams: SerpapiParams = input.publicImageUrl ? { url: input.publicImageUrl } : input.publicImageId
        ? { url: PUBLIC_IMAGES[input.publicImageId].url }
        : { image_id: imageId! };
      await Promise.all([
        runSearch(
          "lens_all",
          "google_lens",
          { engine: "google_lens", type: "all", ...imageParams },
          (j) => normalizeLensAllResponse(j, { retrievedAt }),
        ).then(processResult),
        runSearch(
          "lens_exact_matches",
          "google_lens_exact_matches",
          { engine: "google_lens", type: "exact_matches", ...imageParams },
          (j) => normalizeExactMatchesResponse(j, { requestFailed: false, retrievedAt }),
        ).then(processResult),
      ]);
    };

    jobs.push(uploadAndLens());

    await Promise.all(jobs);
    // A failed dedicated exact request is a limitation, not a silent pass.
    const exactTicket = budget.attemptFor("lens_exact_matches");
    if (exactTicket?.outcome === "failed") {
      limitations.add("exact_match_retrieval_unavailable");
    }
    if (deps.serpapi === null) {
      limitations.add("web_context_unavailable");
      webContextAvailable = false;
    }

    if (callerAborted()) return;
    if (budget.visualSearchFatallyFailed()) {
      stage("INITIAL_RETRIEVAL", "completed", "visual search failed");
      const code: InvestigationErrorCode =
        deadlineHit() && shared.signal.aborted
          ? "DEADLINE_EXCEEDED"
          : uploadFailed
            ? "IMAGE_UPLOAD_FAILED"
            : "VISUAL_SEARCH_FAILED";
      emit({
        type: "investigation.error",
        code,
        message:
          deps.serpapi === null
            ? "Visual search could not be completed: SERPAPI_API_KEY is not configured."
            : "Visual search could not be completed.",
      });
      return;
    }
    stage("INITIAL_RETRIEVAL", "completed", `${candidates.length} candidates`);

    /* ------------------------------ NORMALIZE ---------------------------- */
    stage("NORMALIZE", "started");
    // Deterministic pool order regardless of settle order: discovery may
    // have emitted progressively, but dedupe/retention/downstream selection
    // must not depend on which job finished first.
    const KIND_ORDER: Record<EvidenceCandidate["retrievalKind"], number> = {
      lens_exact: 0,
      lens_visual: 1,
      lens_about_image: 2,
      google_search: 3,
      source_link: 3,
      google_news: 4,
    };
    const sortForPool = (list: readonly EvidenceCandidate[]) =>
      [...list].sort(
        (a, b) =>
          KIND_ORDER[a.retrievalKind] - KIND_ORDER[b.retrievalKind] ||
          (a.serpPosition ?? 1e9) - (b.serpPosition ?? 1e9) ||
          a.id.localeCompare(b.id),
      );
    let pool = applyRetentionCaps(dedupeByCanonicalUrl(sortForPool(candidates)));
    consolidateDateSources(pool);
    for (const c of pool) {
      // Candidates discovered progressively already carry resolved dates;
      // retained-but-unemitted ids (dedupe survivors) resolve + emit here.
      if (!emittedEvidenceIds.has(c.id)) prepareAndDiscover(c);
    }
    stage("NORMALIZE", "completed", `${pool.length} candidates retained`);

    /* ---------------------------- VERIFY_MEDIA --------------------------- */
    stage("VERIFY_MEDIA", "started");
    for (const c of pool) {
      // Defensive re-check after merge/dedupe (§11 invariants).
      c.mediaRelationship = enforceIdentityInvariants(c);
    }
    const hasVisualLeads = pool.some((c) => c.mediaRelationship === "VISUAL_LEAD");
    if (hasVisualLeads) limitations.add("unverified_visual_leads_present");
    // §10.3: the pinned spatial verifier has no acceptance evidence yet, so
    // near-match promotion stays disabled — hash-only never promotes.
    if (hasVisualLeads) limitations.add("near_match_verifier_disabled");
    stage("VERIFY_MEDIA", "completed", "near-match verifier disabled");

    /* ---------------------- SCREEN_REPORTING_ORIGINS --------------------- */
    stage("SCREEN_REPORTING_ORIGINS", "started");
    // Metadata-only pass: no inspectable material yet — origins stay
    // unresolved until deep-read evidence exists (§13).
    stage("SCREEN_REPORTING_ORIGINS", "completed", `${pool.length} unresolved pending deep read`);

    /* ---------------------------- FAST_CLASSIFY -------------------------- */
    stage("FAST_CLASSIFY", "started");
    const toClassify = planClassifications(selectForClassification(pool));
    if (deps.jev === null) {
      limitations.add("semantic_classification_unavailable");
      stage("FAST_CLASSIFY", "completed", "Jev unavailable");
    } else if (deadlineHit()) {
      // §26/§28 — past the deadline, stop starting new semantic work and
      // finalize available evidence; unclassified stays honestly limited.
      if (toClassify.length > 0 && jevSuccesses === 0) {
        limitations.add("semantic_classification_unavailable");
      }
      stage("FAST_CLASSIFY", "completed", "deadline — classification skipped");
    } else {
      const results = await Promise.all(toClassify.map((c) => classifyOne(c)));
      const succeeded = results.filter(Boolean).length;
      noteClassifyOutcome(results.length, succeeded);
      stage("FAST_CLASSIFY", "completed", `${succeeded} classified`);
    }

    /* ----------------------------- PRELIMINARY --------------------------- */
    stage("PRELIMINARY", "started");
    if (mode === "claim_check") {
      const preliminary = evaluateClaimPolicy(pool);
      emit({ type: "verdict.preliminary", verdict: preliminary.status });
    }
    // Partial-stream projection: the divergence stage has not run, so a
    // null-judgments graph asserts no segment/relation state — the
    // timeline still projects the graph's canonical partition alone.
    const partial = buildTimeline(
      pool,
      buildProvenanceGraph({
        candidates: pool,
        pairwiseJudgments: null,
        claim,
        claimDate,
        claimDatePrecision,
      }),
      displayExcerpts,
    );
    emit({ type: "provenance.partial", timeline: partial.timeline });
    stage("PRELIMINARY", "completed");

    /* --------------------------- EXPAND_IF_NEEDED ------------------------ */
    stage("EXPAND_IF_NEEDED", "started");
    const expansion =
      mode === "claim_check"
        ? decideClaimExpansion(pool)
        : decideTraceExpansion(pool, relatedQueries.length > 0);

    let expanded = false;
    if (expansion.expand && deps.serpapi !== null && !deadlineHit()) {
      const choice =
        mode === "claim_check"
          ? chooseClaimExpansion({
              claim: claim ?? "",
              relatedContentQueries: relatedQueries,
              strongestHistoricalAnchor: datedCoreOccurrences(pool)[0]
                ? {
                    title: datedCoreOccurrences(pool)[0].title ?? "",
                    domain: datedCoreOccurrences(pool)[0].registrableDomain,
                  }
                : null,
            })
          : chooseTraceExpansion(relatedQueries);
      if (choice !== null) {
        const ticket = budget.reserveAdaptive(choice.slot);
        if (ticket !== null) {
          const res = await runAdaptiveSearch(ticket, choice, imageId);
          if (res.batch !== null) {
            const added = addCandidates(res.batch);
            if (added.length > 0) {
              // Rebuild from the merged candidate list so adaptive results
              // join the investigated pool (previously dropped).
              pool = applyRetentionCaps(dedupeByCanonicalUrl(sortForPool(candidates)));
              consolidateDateSources(pool);
              for (const c of added) {
                c.mediaRelationship = enforceIdentityInvariants(c);
                prepareAndDiscover(c);
                if (c.mediaRelationship === "VISUAL_LEAD") {
                  limitations.add("unverified_visual_leads_present");
                  limitations.add("near_match_verifier_disabled");
                }
              }
              const classifyAdded = planClassifications(
                selectForClassification(pool).filter((c) => c.judgment === null),
              );
              if (deps.jev !== null) {
                const results = await Promise.all(classifyAdded.map((c) => classifyOne(c)));
                noteClassifyOutcome(results.length, results.filter(Boolean).length);
              }
            }
            expanded = true;
          }
        }
      }
    }
    stage(
      "EXPAND_IF_NEEDED",
      "completed",
      expanded ? `expanded (${expansion.reason})` : `skipped (${expansion.reason})`,
    );

    /* ------------------------------- DEEP_READ --------------------------- */
    stage("DEEP_READ", "started");
    const pageLimiter = createLimiter(CONCURRENCY.pageFetch);
    const pages = deadlineHit() ? [] : selectDeepReadCandidates(pool);
    // Read the first four frozen priorities, then let one inspected historical
    // reference compete with the fifth page. No recursive crawl or extra page.
    const initialPages = pages.slice(0, MAX_DEEP_READ_PAGES - 1);
    const selectedPageIds = new Set(initialPages.map(c => c.id));
    const pageReads: PageReadOutcome[] = pool.map(c => ({ evidenceId: c.id,
      requestedUrl: retainableSourceUrl(c.sourceUrl), finalUrl: null, sourceBinding: 'not_established',
      selection: selectedPageIds.has(c.id) ? 'selected' : 'not_selected',
      fetch: 'not_attempted', extraction: 'not_attempted', failureCode: null, httpStatus: null }));
    let pageFailures = 0;
    const readCandidate = async (c: EvidenceCandidate): Promise<void> => {
        const read = pageReads.find(r => r.evidenceId === c.id);
        if (!read || deadlineHit()) return;
        read.selection = "selected";
        telemetry.pagesAttempted += 1;
        try {
          const page = await pageLimiter(() => deps.fetchPage(c.sourceUrl, shared.signal));
          read.fetch = "succeeded";
          read.finalUrl = retainableSourceUrl(page.url);
          telemetry.pagesSucceeded += 1;
          read.sourceBinding = bindFetchedSource(c.sourceUrl, page.url);
          if (read.sourceBinding !== 'same_resource' && read.sourceBinding !== 'normalized_resource') {
            read.failureCode = 'source_binding_rejected';
            pageFailures += 1;
            return;
          }
          const ex = extractPage(page.html, page.url);
          read.sourceLinks = ex.sourceLinks.map(link => ({ ...link, followup: link.historicalLead ? "pending" : "not_historical", evidenceId: null }));
          read.extraction = ex.text ? "usable_text" : "empty_text";
          if (ex.text !== null) {
            c.pageText = ex.text;
            pageTexts.set(c.id, ex.text);
          }
          if (ex.title !== null) c.title ??= ex.title;
          c.dateEntityBinding = ex.jsonLdDateBinding;
          c.rejectedDateCandidates = ex.rejectedJsonLdDates;
          // §18.2 — retain source-bound JSON-LD/OpenGraph metadata for
          // inspection; null when the page yielded none.
          c.pageMetadata =
            ex.jsonLdMetadata.length > 0 ||
            Object.keys(ex.openGraph).length > 0
              ? { jsonLd: ex.jsonLdMetadata, openGraph: ex.openGraph }
              : null;
          const src = dateSources.get(c.id) ?? {};
          src.pageJsonLd = ex.jsonLdDates[0] ?? null;
          src.pageMeta = ex.metaDates[0] ?? null;
          src.pageTime = ex.timeDates[0] ?? null;
          dateSources.set(c.id, src);
          applyResolvedDate(c);
          const excerpt = buildExcerpt({
            title: c.title,
            snippet: c.snippet,
            paragraphs: ex.paragraphs,
            claim,
          });
          if (excerpt !== null) {
            excerpts.set(c.id, excerpt);
            // The composite (Title:/Snippet:/paragraphs) is model input —
            // the displayed quote must be verbatim page text. Only when a
            // real paragraph exists may the excerpt be labeled page_text.
            const quote = selectDisplayQuote({ title: c.title, claim, paragraphs: ex.paragraphs });
            if (quote !== null) {
              displayExcerpts.set(c.id, quote.slice(0, EXCERPT_MAX_CHARS));
              c.excerptSource = "page_text";
            } else {
              c.excerptSource = "page_composite";
            }
          }
        } catch (err) {
          if (read.fetch === 'succeeded') { read.extraction = 'failed'; read.failureCode = 'extraction_failed'; }
          else { read.fetch = 'failed'; Object.assign(read, readFailure(err)); }
          pageFailures += 1; // §29: page fetch failure is non-fatal
        }
    };
    await Promise.all(initialPages.map(readCandidate));
    // Parent relevance, canonical URL and document order are stable tie-breaks;
    // network completion order and an outlet's name never select the winner.
    const leads = pageReads.flatMap(read => (read.sourceLinks ?? []).map(link => ({ read, link })))
      .filter(({ link }) => link.followup === 'pending')
      .sort((a, b) => {
        const parentA = pool.find(c => c.id === a.read.evidenceId);
        const parentB = pool.find(c => c.id === b.read.evidenceId);
        return (parentB?.judgment?.relevance ?? 0) - (parentA?.judgment?.relevance ?? 0)
          || (parentA?.canonicalUrl ?? '').localeCompare(parentB?.canonicalUrl ?? '')
          || a.link.location.index - b.link.location.index;
      });
    let followup: EvidenceCandidate | null = null;
    for (const { link } of leads) {
      if (deadlineHit()) { link.followup = 'deadline'; continue; }
      const canonical = canonicalizeUrl(link.url)?.canonicalUrl;
      const existing = pool.find(c => c.canonicalUrl === canonical);
      if (existing && pageReads.some(read => read.evidenceId === existing.id && read.selection === 'selected')) {
        link.followup = 'already_read'; link.evidenceId = existing.id; continue;
      }
      if (followup) { link.followup = 'page_limit'; continue; }
      if (!existing && pool.filter(c => c.retrievalKind === 'google_search' || c.retrievalKind === 'source_link').length >= RETENTION_CAPS.google_search) {
        link.followup = 'retention_limit'; continue;
      }
      const candidate = existing ?? candidateFromSourceLink(link, retrievedAt);
      if (!candidate) { link.followup = 'retention_limit'; continue; }
      link.followup = 'selected'; link.evidenceId = candidate.id;
      followup = candidate;
      if (!existing) {
        candidates.push(candidate); pool.push(candidate); seenIds.add(candidate.id);
        prepareAndDiscover(candidate);
        pageReads.push({ evidenceId: candidate.id, requestedUrl: retainableSourceUrl(candidate.sourceUrl), finalUrl: null,
          sourceBinding: 'not_established', selection: 'selected', fetch: 'not_attempted', extraction: 'not_attempted', failureCode: null, httpStatus: null });
      }
    }
    const finalPage = followup ?? pages[MAX_DEEP_READ_PAGES - 1];
    if (finalPage && !deadlineHit()) await readCandidate(finalPage);
    // References on the final page are retained, but never followed recursively.
    for (const read of pageReads) for (const link of read.sourceLinks ?? []) {
      if (link.followup === 'pending') link.followup = deadlineHit() ? 'deadline' : 'page_limit';
    }
    if (pageFailures > 0) limitations.add("page_fetch_partial_failure");
    if (callerAborted()) return;
    stage("DEEP_READ", "completed", `${telemetry.pagesAttempted - pageFailures}/${telemetry.pagesAttempted} pages read`);

    /* -------------------------- REFINED_CLASSIFY ------------------------- */
    stage("REFINED_CLASSIFY", "started");
    const toReclassify = planClassifications(pool.filter((c) => pageTexts.has(c.id)));
    if (deps.jev !== null && toReclassify.length > 0 && !deadlineHit()) {
      // Reclassify with the page-text excerpt; keep old judgment on failure.
      const results = await Promise.all(
        toReclassify.map(async (c) => {
          const prev = c.judgment;
          c.judgment = null;
          const ok = await classifyOne(c);
          if (!ok) c.judgment = prev;
          return ok;
        }),
      );
      // A failed re-ask keeps the prior validated judgment — only a
      // never-classified candidate contributes to "unavailable".
      noteClassifyOutcome(results.length, results.filter(Boolean).length);
    }
    stage("REFINED_CLASSIFY", "completed");

    /* ---------------------- REFINE_REPORTING_ORIGINS --------------------- */
    stage("REFINE_REPORTING_ORIGINS", "started");
    refineReportingOrigins(pool, pageTexts);
    // Unresolved origins among core occurrences are a limitation in BOTH
    // modes — Trace results must not silently hide them (§13, §29).
    if (unresolvedOriginCount(coreOccurrences(pool)) > 0) {
      limitations.add("reporting_origins_unresolved");
    }
    stage("REFINE_REPORTING_ORIGINS", "completed");

    /* ------------------------------ CHRONOLOGY --------------------------- */
    stage("CHRONOLOGY", "started");
    const datedCore = datedCoreOccurrences(pool);
    const selected = selectDatedCoreOccurrences(datedCore);
    if (pool.some((c) => c.dateStatus === "unknown")) limitations.add("unknown_dates_present");
    if (pool.some((c) => c.dateStatus === "disputed")) limitations.add("disputed_dates_present");
    if (datedCore.length < 2) limitations.add("insufficient_dated_occurrences");
    stage("CHRONOLOGY", "completed", `${datedCore.length} dated core occurrences`);

    /* ------------------------------ DIVERGENCE --------------------------- */
    stage("DIVERGENCE", "started");
    const judgments = new Map<string, PairwiseContextJudgment | null>();
    // Only strictly-ordered adjacent pairs are compared — an overlapping
    // or equal-date pair cannot assert an ordered transition, so no
    // pairwise call is made for it (§20.2).
    const orderablePairs: Array<[EvidenceCandidate, EvidenceCandidate]> = [];
    for (let i = 1; i < selected.length; i++) {
      const prev = selected[i - 1];
      const cur = selected[i];
      if (strictlyBefore(prev, cur)) orderablePairs.push([prev, cur]);
    }
    if (deps.jev !== null && orderablePairs.length > 0 && !deadlineHit()) {
      telemetry.pairwiseAttempted = orderablePairs.length;
      await Promise.all(
        orderablePairs.map(async ([prev, cur]) => {
          const t0 = now();
          try {
            const res = await jevLimiter(() =>
              deps.jev!.ask(
                pairwiseState(prev, cur, excerpts.get(prev.id) ?? null, excerpts.get(cur.id) ?? null),
                { pairwise_context: PAIRWISE_QUESTION },
                shared.signal,
              ),
            );
            telemetry.jevCalls.push({
              kind: "pairwise",
              ms: Math.max(0, now() - t0),
              identityStatus: res.identity.status,
              model: verifiedPinnedModel(res.identity),
            });
            judgments.set(pairKey(prev.id, cur.id), pairwiseFromAnswers(res.answers, res.identity));
          } catch (err) {
            telemetry.jevCalls.push({
              kind: "pairwise",
              ms: Math.max(0, now() - t0),
              identityStatus: "call_failed",
              model: null,
            });
            logProviderFailure(`jev pairwise ${prev.id}~${cur.id}`, err);
            judgments.set(pairKey(prev.id, cur.id), null);
          }
        }),
      );
    }
    // §23 — the provenance graph is the authoritative relation
    // structure: it owns the canonical partition, the deterministic
    // selection, segment membership, connectors, coverage and every
    // evaluated comparison, derived from the investigated candidates and
    // the pairwise judgments above. The divergence event, the coverage
    // limitation, and both downstream projections consume it.
    const graph = buildProvenanceGraph({
      candidates: pool,
      pairwiseJudgments: judgments,
      claim,
      claimDate,
      claimDatePrecision,
    });
    if (graph.firstObservedDivergence !== null) {
      emit({ type: "divergence.detected", divergence: graph.firstObservedDivergence });
    }
    if (
      graph.coverage.selected < graph.coverage.eligible ||
      graph.coverage.comparedPairs < orderablePairs.length
    ) {
      limitations.add("comparison_coverage_incomplete");
    }
    stage("DIVERGENCE", "completed");

    /* ----------------------------- FINAL_POLICY -------------------------- */
    stage("FINAL_POLICY", "started");
    const built = buildTimeline(pool, graph, displayExcerpts, excerpts);
    // §34 request/operation log — one row per actual attempt. `retained`
    // counts the candidates from *that* attempt whose canonical URL
    // survived deduplication into the investigated pool, not every pool
    // member sharing the retrieval kind. Counts only; no params or
    // provider payloads.
    const poolCanonicals = new Set(pool.map((c) => c.canonicalUrl));
    const requestLog = telemetry.searches.map((s) => ({
      engine: s.slot,
      attempted: 1,
      returned: s.ok ? s.count : 0,
      retained:
        s.batch === null
          ? 0
          : s.batch.candidates.filter((c) => poolCanonicals.has(c.canonicalUrl)).length,
      durationMs: s.ms,
      // §34 — this attempt's actual provider search id; null on failure
      // or when the provider returned none. Identifier only.
      searchId: s.batch?.searchId ?? null,
    }));
    const takeaways: Takeaway[] =
      mode === "claim_check"
        ? deriveTakeaways({
            candidates: pool,
            claimDate,
            claimDatePrecision,
            hasCurrentNewsResults,
          })
        : [];
    // §28 — when the investigation's own shared deadline fired during this
    // run, work was stopped and this result is finalized from retained
    // evidence. Say so distinctly from ordinary per-page fetch failures;
    // a caller abort is not the app's cutoff, and a fast finish never
    // reaches the deadline.
    if (deadlineHit() && !callerAborted()) {
      limitations.add("analysis_time_limit_reached");
    }
    const result: InvestigationResult =
      mode === "claim_check"
        ? buildClaimResult({
            candidates: pool,
            timeline: built.timeline,
            supportingEvidence: built.supportingEvidence,
            contextualEvidence: built.contextualEvidence,
            undatedEvidence: built.undatedEvidence,
            limitations: [...limitations],
            claim: claim!,
            claimDate,
            webContextAvailable,
            takeaways,
            requestLog,
            pageReads,
            graph,
          })
        : buildTraceResult({
            candidates: pool,
            timeline: built.timeline,
            supportingEvidence: built.supportingEvidence,
            contextualEvidence: built.contextualEvidence,
            undatedEvidence: built.undatedEvidence,
            limitations: [...limitations],
            requestLog,
            pageReads,
            graph,
          });
    try {
      result.caseRecord = caseFromImageInvestigation({
        result, id: investigationId, createdAt: new Date(startedAt).toISOString(),
      });
    } catch (error) {
      if (!(error instanceof CaseValidationError)) throw error;
      // The case has stricter import bounds than legacy provider metadata.
      // Keep the completed image report and expose the projection failure.
      result.caseProjectionError = "invalid_source_result";
    }
    // Stage completion precedes the terminal event — a client that stops
    // reading at investigation.completed still sees a finished stage list.
    stage("FINAL_POLICY", "completed");
    stage("COMPLETE", "completed");
    logTelemetry({
      kind: "investigation",
      investigationId,
      mode,
      durationMs: Math.max(0, now() - startedAt),
      status: result.mode === "claim_check" ? result.status : result.headline,
      candidates: pool.length,
      searches: telemetry.searches.map(({ batch: _batch, ...s }) => s),
      jev: {
        attempted: telemetry.jevAttempted,
        succeeded: telemetry.jevSucceeded,
        pairwiseAttempted: telemetry.pairwiseAttempted,
        calls: telemetry.jevCalls,
      },
      budget: { used: budget.used, remaining: budget.remaining, max: budget.maxSearches },
      pages: { attempted: telemetry.pagesAttempted, succeeded: telemetry.pagesSucceeded },
      // §16.5 eligibility rationale — bounded codes only, never raw
      // provider strings or the claim text.
      locationEligibility:
        locationEligibility === null
          ? null
          : {
              eligible: locationEligibility.eligible,
              reasons: locationEligibility.reasons,
              rejectedBy: locationEligibility.rejectedBy,
            },
      limitations: [...limitations],
    });
    emit({ type: "investigation.completed", result });
  } catch {
    // Defensive: orchestration must never throw past the stream. Provider
    // failures are handled per-stage; anything reaching here is internal.
    if (!callerAborted()) {
      emit({
        type: "investigation.error",
        code: "INTERNAL_ERROR",
        message: "The investigation failed unexpectedly. No evidence was fabricated to fill the gap.",
      });
    }
  } finally {
    clearTimeout(deadlineTimer);
    deps.signal?.removeEventListener("abort", onExternalAbort);
  }
}
