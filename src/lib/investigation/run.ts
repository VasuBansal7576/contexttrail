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

import type { EvidenceCandidate } from "./contracts/evidence";
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
import type { PairwiseContextJudgment } from "./contracts/judgment";
import { SearchBudget, type BaseSearchSlot, type SearchTicket } from "./budget";
import { dedupeByCanonicalUrl, applyRetentionCaps, selectForClassification } from "./candidates";
import { parseClaimDate, resolveEvidenceDate, type EvidenceDateSources } from "./dates";
import {
  buildContextSegments,
  datedCoreOccurrences,
  pairKey,
  selectDatedCoreOccurrences,
} from "./divergence";
import {
  chooseClaimExpansion,
  chooseTraceExpansion,
  decideClaimExpansion,
  decideTraceExpansion,
  type ClaimExpansionChoice,
} from "./expansion";
import { enforceIdentityInvariants } from "./identity";
import { CONCURRENCY, TIMEOUTS, MAX_DEEP_READ_PAGES } from "./limits";
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
import type { JevClient } from "../jev/client";
import { judgmentFromAnswers, pairwiseFromAnswers } from "../jev/client";
import {
  PAIRWISE_QUESTION,
  candidateState,
  claimMayStateLocation,
  evidenceQuestions,
  pairwiseState,
} from "../jev/questions";
import { createLimiter, ProviderError } from "../providers/http";
import type { FetchedPage } from "../pages/fetch";
import { buildExcerpt, extractPage } from "../pages/extract";
import {
  normalizeAboutThisImageResponse,
  normalizeExactMatchesResponse,
  normalizeLensAllResponse,
  normalizeSearchResponse,
  recordDateSources,
  type NormalizedBatch,
} from "../serpapi/normalize";
import { serpapiResponseFailed, type SerpapiParams } from "../serpapi/client";

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
 * earliest dated core, strongest conflict from another domain with
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
  take(datedCore[0]);

  const firstDomain = datedCore[0]?.registrableDomain;
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

  take(
    byRel(
      [...candidates].sort(
        (a, b) =>
          (b.judgment?.pageRole.factCheck ?? 0) - (a.judgment?.pageRole.factCheck ?? 0),
      ),
    )[0],
  );

  take(
    byRel(
      candidates.filter(
        (c) => c.retrievalKind === "google_news" || (c.judgment?.pageRole.reporting ?? 0) >= 0.75,
      ),
    )[0],
  );

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
  const budget = new SearchBudget(mode);
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
  const excerpts = new Map<string, string>();
  const pageTexts = new Map<string, string>();
  const limitations = new Set<LimitationCode>();
  let webContextAvailable = true;
  let hasCurrentNewsResults = false;
  let uploadFailed = false;
  let imageId: string | null = null;
  let claimDate: string | null = null;
  let claimDatePrecision: "day" | "month" | "year" | "unknown" = "unknown";

  const stage = (s: Stage, phase: "started" | "completed", detail?: string) => {
    if (phase === "started") emit({ type: "stage.started", stage: s });
    else emit({ type: "stage.completed", stage: s, ...(detail ? { detail } : {}) });
  };

  const emitDiscovered = (c: EvidenceCandidate) => {
    if (emittedEvidenceIds.has(c.id)) return;
    emittedEvidenceIds.add(c.id);
    emit({ type: "evidence.discovered", evidence: toPublicCandidate(c, excerpts.get(c.id) ?? null) });
  };

  const addCandidates = (batch: NormalizedBatch | null): number => {
    if (batch === null) return 0;
    let added = 0;
    for (const c of batch.candidates) {
      if (!seenIds.has(c.id)) {
        seenIds.add(c.id);
        candidates.push(c);
        added += 1;
      }
    }
    for (const q of batch.relatedQueries) {
      if (!relatedQueries.includes(q)) relatedQueries.push(q);
    }
    recordDateSources(dateSources, batch);
    return added;
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
    try {
      const json = await serpLimiter(() => deps.serpapi!.search(params, shared.signal));
      if (serpapiResponseFailed(json)) {
        try {
          console.warn(`[investigate] serpapi ${slot} reported provider error`);
        } catch { /* diagnostics never break the pipeline */ }
        ticket.fail();
        return { slot, engineLabel, batch: null, failed: true };
      }
      ticket.succeed();
      const batch = normalize(json);
      emit({ type: "search.batch", engine: engineLabel, count: batch.reportedCount });
      return { slot, engineLabel, batch, failed: false };
    } catch (err) {
      logProviderFailure(`serpapi ${slot}`, err);
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
    if (choice.slot === "adaptive_lens_refined" && imageIdForLens !== null) {
      params.image_id = imageIdForLens;
    }
    try {
      const json = await serpLimiter(() => deps.serpapi!.search(params, shared.signal));
      if (serpapiResponseFailed(json)) {
        try {
          console.warn(`[investigate] serpapi ${choice.slot} reported provider error`);
        } catch { /* diagnostics never break the pipeline */ }
        ticket.fail();
        return { slot: "adaptive", engineLabel: "expansion", batch: null, failed: true };
      }
      ticket.succeed();
      const batch =
        choice.slot === "adaptive_lens_refined"
          ? normalizeLensAllResponse(json, { retrievedAt: new Date().toISOString() })
          : normalizeSearchResponse(json, "google_search", { retrievedAt: new Date().toISOString() });
      emit({ type: "search.batch", engine: "expansion", count: batch.reportedCount });
      return { slot: "adaptive", engineLabel: "expansion", batch, failed: false };
    } catch (err) {
      logProviderFailure(`serpapi ${choice.slot}`, err);
      ticket.fail();
      return { slot: "adaptive", engineLabel: "expansion", batch: null, failed: true };
    }
  };

  const jevLimiter = createLimiter(CONCURRENCY.jev);
  const claimHasLocation = claim !== null ? claimMayStateLocation(claim) : false;

  /** §16 — classify one candidate; judgment stays null on failure (§29). */
  const classifyOne = async (c: EvidenceCandidate): Promise<boolean> => {
    if (deps.jev === null || c.judgment !== null) return false;
    try {
      const excerpt = excerpts.get(c.id) ?? c.snippet;
      const { answers } = await jevLimiter(() =>
        deps.jev!.ask(
          candidateState(c, claim, excerpt),
          evidenceQuestions({ claimMode: mode === "claim_check", claimHasLocation }),
          shared.signal,
        ),
      );
      const judgment = judgmentFromAnswers(answers, { claimMode: mode === "claim_check" });
      if (judgment === null) {
        logProviderFailure(`jev answers malformed for ${c.id}`, new ProviderError("malformed", "jev answers failed validation"));
        return false;
      }
      c.judgment = judgment;
      emit({ type: "evidence.classified", id: c.id, publicJudgment: judgment });
      return true;
    } catch (err) {
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
    const jobs: Promise<SearchJobResult | SearchJobResult[]>[] = [];

    if (claim !== null && deps.serpapi !== null) {
      jobs.push(
        runSearch(
          "google_search_claim",
          "google_search",
          { engine: "google", q: claim },
          (j) => normalizeSearchResponse(j, "google_search", { retrievedAt }),
        ),
      );
      jobs.push(
        runSearch(
          "google_news_claim",
          "google_news",
          { engine: "google_news", q: claim },
          (j) => normalizeSearchResponse(j, "google_news", { retrievedAt }),
        ),
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
        ["lens_about_this_image", "google_lens_about_this_image"],
      ];
      return slots.map(([slot, engineLabel]) => {
        budget.reserveBase(slot)?.fail();
        return { slot, engineLabel, batch: null, failed: true };
      });
    };

    const uploadAndLens = async (): Promise<SearchJobResult[]> => {
      if (deps.serpapi === null || !budget.tryReserveUpload()) {
        uploadFailed = deps.serpapi !== null;
        return failedLensJobs();
      }
      try {
        imageId = await deps.serpapi.uploadImage(input.media, shared.signal);
      } catch (err) {
        logProviderFailure("serpapi image upload", err);
        uploadFailed = true;
        return failedLensJobs();
      }
      // The three Lens calls fan out concurrently (§6.3, §9.1).
      return Promise.all([
        runSearch(
          "lens_all",
          "google_lens",
          { engine: "google_lens", type: "all", image_id: imageId },
          (j) => normalizeLensAllResponse(j, { retrievedAt }),
        ),
        runSearch(
          "lens_exact_matches",
          "google_lens_exact_matches",
          { engine: "google_lens", type: "exact_matches", image_id: imageId },
          (j) => normalizeExactMatchesResponse(j, { requestFailed: false, retrievedAt }),
        ),
        runSearch(
          "lens_about_this_image",
          "google_lens_about_this_image",
          { engine: "google_lens", type: "about_this_image", image_id: imageId },
          (j) => normalizeAboutThisImageResponse(j, { retrievedAt }),
        ),
      ]);
    };

    jobs.push(uploadAndLens());

    const settled = await Promise.all(jobs.map(async (j) => await j));
    for (const r of settled) {
      const results = Array.isArray(r) ? r : [r];
      for (const res of results) {
        addCandidates(res.batch);
        if (res.slot === "google_search_claim" && res.failed) webContextAvailable = false;
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
          res.batch !== null &&
          res.batch.surfacePresent === false
        ) {
          limitations.add("about_this_image_unavailable");
        }
        if (res.slot === "google_news_claim" && res.failed) {
          limitations.add("news_unavailable");
        }
      }
    }
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
    let pool = applyRetentionCaps(dedupeByCanonicalUrl(candidates));
    for (const c of pool) {
      const resolved = resolveEvidenceDate(dateSources.get(c.id) ?? {}, new Date(startedAt));
      c.publishedAt = resolved.publishedAt;
      c.publishedAtSource = resolved.publishedAtSource;
      c.datePrecision = resolved.datePrecision;
      c.dateStatus = resolved.dateStatus;
      c.excerptSource = c.snippet !== null ? "serp_snippet" : null;
      if (c.snippet !== null) excerpts.set(c.id, c.snippet);
      emitDiscovered(c);
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
    const toClassify = selectForClassification(pool);
    if (deps.jev === null) {
      limitations.add("semantic_classification_unavailable");
      stage("FAST_CLASSIFY", "completed", "Jev unavailable");
    } else {
      const results = await Promise.all(toClassify.map((c) => classifyOne(c)));
      const failures = results.filter((ok) => !ok).length;
      if (failures > 0) limitations.add("semantic_classification_partial");
      stage("FAST_CLASSIFY", "completed", `${results.length - failures} classified`);
    }

    /* ----------------------------- PRELIMINARY --------------------------- */
    stage("PRELIMINARY", "started");
    if (mode === "claim_check") {
      const preliminary = evaluateClaimPolicy(pool);
      emit({ type: "verdict.preliminary", verdict: preliminary.status });
    }
    const partial = buildTimeline(pool, null, excerpts);
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
            if (added > 0) {
              pool = applyRetentionCaps(dedupeByCanonicalUrl(pool));
              const newOnes = pool.filter((c) => !emittedEvidenceIds.has(c.id));
              for (const c of newOnes) {
                const resolved = resolveEvidenceDate(dateSources.get(c.id) ?? {}, new Date(startedAt));
                c.publishedAt = resolved.publishedAt;
                c.publishedAtSource = resolved.publishedAtSource;
                c.datePrecision = resolved.datePrecision;
                c.dateStatus = resolved.dateStatus;
                c.mediaRelationship = enforceIdentityInvariants(c);
                c.excerptSource = c.snippet !== null ? "serp_snippet" : null;
                if (c.snippet !== null) excerpts.set(c.id, c.snippet);
                emitDiscovered(c);
                if (c.mediaRelationship === "VISUAL_LEAD") {
                  limitations.add("unverified_visual_leads_present");
                  limitations.add("near_match_verifier_disabled");
                }
              }
              const classifyAdded = selectForClassification(pool).filter((c) => c.judgment === null);
              if (deps.jev !== null) {
                const results = await Promise.all(classifyAdded.map((c) => classifyOne(c)));
                if (results.some((ok) => !ok)) limitations.add("semantic_classification_partial");
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
    let pageFailures = 0;
    await Promise.all(
      pages.map(async (c) => {
        try {
          const page = await pageLimiter(() => deps.fetchPage(c.sourceUrl, shared.signal));
          const ex = extractPage(page.html);
          if (ex.text !== null) {
            c.pageText = ex.text;
            pageTexts.set(c.id, ex.text);
          }
          if (ex.title !== null) c.title ??= ex.title;
          const src = dateSources.get(c.id) ?? {};
          src.pageJsonLd = ex.jsonLdDates[0] ?? null;
          src.pageMeta = ex.metaDates[0] ?? null;
          src.pageTime = ex.timeDates[0] ?? null;
          dateSources.set(c.id, src);
          const resolved = resolveEvidenceDate(src, new Date(startedAt));
          c.publishedAt = resolved.publishedAt;
          c.publishedAtSource = resolved.publishedAtSource;
          c.datePrecision = resolved.datePrecision;
          c.dateStatus = resolved.dateStatus;
          const excerpt = buildExcerpt({
            title: c.title,
            snippet: c.snippet,
            paragraphs: ex.paragraphs,
            claim,
          });
          if (excerpt !== null) {
            excerpts.set(c.id, excerpt);
            c.excerptSource = "page_text";
          }
        } catch {
          pageFailures += 1; // §29: page fetch failure is non-fatal
        }
      }),
    );
    if (pageFailures > 0) limitations.add("page_fetch_partial_failure");
    if (callerAborted()) return;
    stage("DEEP_READ", "completed", `${pages.length - pageFailures}/${pages.length} pages read`);

    /* -------------------------- REFINED_CLASSIFY ------------------------- */
    stage("REFINED_CLASSIFY", "started");
    const toReclassify = pool.filter((c) => pageTexts.has(c.id));
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
      if (results.some((ok) => !ok)) limitations.add("semantic_classification_partial");
    }
    stage("REFINED_CLASSIFY", "completed");

    /* ---------------------- REFINE_REPORTING_ORIGINS --------------------- */
    stage("REFINE_REPORTING_ORIGINS", "started");
    refineReportingOrigins(pool, pageTexts);
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
    if (deps.jev !== null && selected.length >= 2 && !deadlineHit()) {
      await Promise.all(
        selected.slice(1).map(async (cur, i) => {
          const prev = selected[i];
          try {
            const { answers } = await jevLimiter(() =>
              deps.jev!.ask(
                pairwiseState(prev, cur, excerpts.get(prev.id) ?? null, excerpts.get(cur.id) ?? null),
                { pairwise_context: PAIRWISE_QUESTION },
                shared.signal,
              ),
            );
            judgments.set(pairKey(prev.id, cur.id), pairwiseFromAnswers(answers));
          } catch (err) {
            logProviderFailure(`jev pairwise ${prev.id}~${cur.id}`, err);
            judgments.set(pairKey(prev.id, cur.id), null);
          }
        }),
      );
    }
    const segments = buildContextSegments(datedCore, selected, judgments);
    if (segments.firstObservedContextDivergence !== null) {
      emit({ type: "divergence.detected", divergence: segments.firstObservedContextDivergence });
    }
    if (segments.coverage.selected < segments.coverage.eligible || segments.coverage.comparedPairs < Math.max(0, selected.length - 1)) {
      limitations.add("comparison_coverage_incomplete");
    }
    stage("DIVERGENCE", "completed");

    /* ----------------------------- FINAL_POLICY -------------------------- */
    stage("FINAL_POLICY", "started");
    const built = buildTimeline(pool, segments, excerpts);
    const coverage = segments.coverage;
    const takeaways: Takeaway[] =
      mode === "claim_check"
        ? deriveTakeaways({
            candidates: pool,
            claimDate,
            claimDatePrecision,
            hasCurrentNewsResults,
          })
        : [];
    const result: InvestigationResult =
      mode === "claim_check"
        ? buildClaimResult({
            candidates: pool,
            timeline: built.timeline,
            undatedEvidence: built.undatedEvidence,
            coverage,
            firstObservedContextDivergence: segments.firstObservedContextDivergence,
            contextSegmentCount: segments.contextSegmentCount,
            limitations: [...limitations],
            claim: claim!,
            claimDate,
            webContextAvailable,
            takeaways,
          })
        : buildTraceResult({
            candidates: pool,
            timeline: built.timeline,
            undatedEvidence: built.undatedEvidence,
            coverage,
            firstObservedContextDivergence: segments.firstObservedContextDivergence,
            contextSegmentCount: segments.contextSegmentCount,
            limitations: [...limitations],
          });
    // Stage completion precedes the terminal event — a client that stops
    // reading at investigation.completed still sees a finished stage list.
    stage("COMPLETE", "completed");
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
