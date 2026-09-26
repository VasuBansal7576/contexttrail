/**
 * TypeSafe Jev adapter (spec §15–17, §20.1, §29).
 *
 * POST https://api.typesafe.ai/v1/systemone with a Bearer token, a pinned
 * model, a `state`, and a `questions` map; the response carries one typed
 * `answers` entry per question. Judgments are *validated* before use:
 * malformed or out-of-range answers produce null sub-judgments — never
 * synthetic probabilities, never fabricated semantics (§29).
 *
 * Jev produces probability distributions only. Final statuses come from the
 * deterministic policy, never from this adapter.
 */

import type {
  EvidenceJudgment,
  PairwiseContextJudgment,
} from "../investigation/contracts/judgment";
import { TIMEOUTS } from "../investigation/limits";
import { ProviderError, fetchJsonBounded } from "../providers/http";
import {
  PAIRWISE_QUESTION,
  evidenceQuestions,
  type JevQuestion,
} from "./questions";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
/** §15.1 — pinned production model. Never a moving alias. */
export const JEV_MODEL = "jev-1.13.0";
const JEV_MAX_BYTES = 1 * 1024 * 1024;

/**
 * Absolute tolerance allowed between the sum of a Choice answer's declared
 * option probabilities and 1.
 *
 * Justification: a Choice answer is a probability *distribution*, and the
 * frozen §17 thresholds are compared directly against its components, so an
 * unnormalized map is not a distribution and its components are not
 * comparable. 1e-3 accepts provider output rounded to three decimal places
 * (the coarsest rounding a JSON double-precision distribution is normally
 * emitted with, e.g. 0.333 x 3 = 0.999) and still rejects any map that is
 * materially not a distribution.
 */
export const JEV_PROBABILITY_SUM_TOLERANCE = 1e-3;

export interface JevClientOptions {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

interface JevAnswerNoul {
  type: "noul";
  noul: number;
}

interface JevAnswerChoice {
  type: "choice";
  /** the provider's declared winner, verbatim; null when it declared none */
  choice: string | null;
  probabilities: Record<string, number>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validProb(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
}

function noulAnswer(v: unknown): JevAnswerNoul | null {
  if (!isRecord(v) || v.type !== "noul" || !validProb(v.noul)) return null;
  return { type: "noul", noul: v.noul };
}

/**
 * §16 Choice answer validation at the boundary. Rejects — never repairs —
 * when: the shape is not a Choice; the option map is not an object; a
 * declared option is missing, non-finite, or outside 0..1; the map carries a
 * key that is not a declared option (an undeclared/duplicate option cannot be
 * distinguished from an injected one, so it is refused); the declared winner
 * is a non-string or names an option that was not offered; or the options do
 * not sum to 1 within {@link JEV_PROBABILITY_SUM_TOLERANCE}.
 */
function choiceAnswer(v: unknown, keys: string[]): JevAnswerChoice | null {
  if (!isRecord(v) || v.type !== "choice") return null;
  const probs = v.probabilities;
  if (!isRecord(probs)) return null;
  for (const k of Object.keys(probs)) {
    if (!keys.includes(k)) return null;
  }
  const out: Record<string, number> = {};
  let sum = 0;
  for (const k of keys) {
    const p = probs[k];
    if (!validProb(p)) return null;
    out[k] = p;
    sum += p;
  }
  if (Math.abs(sum - 1) > JEV_PROBABILITY_SUM_TOLERANCE) return null;
  if (v.choice === undefined) {
    return { type: "choice", choice: null, probabilities: out };
  }
  if (typeof v.choice !== "string" || !keys.includes(v.choice)) return null;
  return { type: "choice", choice: v.choice, probabilities: out };
}

/* --------------------------- model provenance --------------------------- */

/**
 * `verified`  — the provider reported exactly the model that was requested.
 * `unexpected`— the provider reported a different, non-empty model identity.
 * `missing`   — the response carried no model identity at all.
 */
export type JevModelStatus = "verified" | "unexpected" | "missing";

/**
 * The truthful, inspectable result of comparing the model the provider said
 * answered against the model actually configured on the wire. `requested` is
 * never rewritten, so an explicit override stays visible.
 */
export interface JevModelIdentity {
  readonly requested: string;
  readonly reported: string | null;
  readonly status: JevModelStatus;
  /** true when `requested` is the §15.1 pinned model */
  readonly pinned: boolean;
}

/** Typed result of one Jev call. `identity` is additive; `model` is retained. */
export interface JevAskResult {
  answers: Record<string, unknown>;
  /** retained for existing callers; mirrors `identity.reported` */
  model: string | null;
  identity: JevModelIdentity;
}

/**
 * Resolve provider model provenance. `reported` must be a non-empty string to
 * count as an identity at all; anything else (absent, null, non-string, blank,
 * or a non-string member of an array) is `missing`, never guessed.
 */
export function resolveModelIdentity(
  requested: string,
  reported: unknown,
): JevModelIdentity {
  const pinned = requested === JEV_MODEL;
  const id =
    typeof reported === "string" && reported.trim().length > 0
      ? reported
      : null;
  const status: JevModelStatus =
    id === null ? "missing" : id === requested ? "verified" : "unexpected";
  return { requested, reported: id, status, pinned };
}

/**
 * The only condition under which an {@link EvidenceJudgment} may carry the
 * pinned model label: the provider verified as the model actually configured,
 * *and* that configured model is the pinned one. An explicit override to any
 * other model is reported as a mismatch rather than relabelled — §46 requires
 * provider model details to change only through an explicit revision of the
 * pinned constant and the §15.5 contract together.
 */
export function verifiedPinnedModel(
  identity: JevModelIdentity | null | undefined,
): typeof JEV_MODEL | null {
  if (identity === null || identity === undefined) return null;
  if (identity.status !== "verified" || !identity.pinned) return null;
  return JEV_MODEL;
}

/**
 * Fail-closed model check for the provider boundary.
 *
 * Provenance policy is a *product* decision, not a claim about the Jev wire
 * format: §15.1 pins the production model, §15.5 fixes `model` to the literal
 * `"jev-1.13.0"`, and §34/§39 require the product to display and log that
 * version. A judgment therefore may only be published when the model that
 * answered is provably the pinned one. An unexpected identity and an absent
 * identity are both refused: relabelling either as `jev-1.13.0` would be
 * fabricating provenance, so the call is rejected and the caller stores
 * `judgment=null` per §29.
 *
 * The message names only the two model identifiers — never the URL, the
 * bearer token, or the raw provider body.
 */
function assertVerifiedModel(identity: JevModelIdentity): void {
  if (identity.status === "verified" && identity.pinned) return;
  const reported = identity.reported === null ? "none" : identity.reported;
  throw new ProviderError(
    "malformed",
    `jev model identity ${identity.status} (requested ${identity.requested}, reported ${reported})`,
  );
}

export class JevClient {
  readonly #apiKey: string;
  readonly #model: string;
  readonly #fetchImpl?: typeof fetch;

  constructor(opts: JevClientOptions) {
    this.#apiKey = opts.apiKey;
    this.#model = opts.model ?? JEV_MODEL;
    this.#fetchImpl = opts.fetchImpl;
  }

  get model(): string {
    return this.#model;
  }

  /**
   * One Jev call: state + questions map (§15.3).
   *
   * The response's model identity is validated against the model actually
   * configured on the wire before any answer is handed back. An unexpected or
   * absent identity throws a sanitized `ProviderError("malformed")`, so no
   * caller can turn an unverified answer set into a model-labelled judgment.
   * An explicit `model` override is never silently rewritten: it is compared
   * as configured and surfaced through `identity`.
   */
  async ask(
    state: unknown,
    questions: Record<string, JevQuestion>,
    signal?: AbortSignal,
  ): Promise<JevAskResult> {
    const json = await fetchJsonBounded({
      url: JEV_ENDPOINT,
      label: "jev",
      timeoutMs: TIMEOUTS.jevMs,
      maxBytes: JEV_MAX_BYTES,
      externalSignal: signal,
      fetchImpl: this.#fetchImpl,
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.#apiKey}`,
        },
        body: JSON.stringify({ model: this.#model, state, questions }),
      },
    });
    if (!isRecord(json)) {
      throw new ProviderError("malformed", "jev response was not a JSON object");
    }
    const identity = resolveModelIdentity(this.#model, json.model);
    assertVerifiedModel(identity);
    if (!isRecord(json.answers)) {
      return { answers: {}, model: identity.reported, identity };
    }
    return {
      answers: json.answers as Record<string, unknown>,
      model: identity.reported,
      identity,
    };
  }
}

/**
 * Validate raw Jev answers into an EvidenceJudgment. Required surfaces
 * (relevance, page role) missing or malformed => null (the caller stores
 * judgment=null per §29). Claim-check surfaces degrade to null when absent.
 *
 * `opts.provenance` is additive and optional. Supply it to make model
 * provenance part of the validation boundary: a non-verified identity makes
 * the whole judgment null, so an answer set that reached this function from
 * anywhere other than {@link JevClient.ask} still cannot be published under
 * the pinned model label. Omitting it keeps the pre-existing two-field call
 * shape working; `JevClient.ask` has already refused an unverified identity in
 * that path.
 */
export function judgmentFromAnswers(
  answers: Record<string, unknown>,
  opts: { claimMode: boolean; provenance?: JevModelIdentity | null },
): EvidenceJudgment | null {
  const model =
    opts.provenance === undefined
      ? JEV_MODEL
      : verifiedPinnedModel(opts.provenance);
  if (model === null) return null;

  const relevance = noulAnswer(answers.relevance);
  const pageRole = choiceAnswer(answers.page_role, [
    "REPORTING",
    "FACT_CHECK",
    "SOCIAL_REPOST",
    "AGGREGATOR",
    "COMMENTARY",
    "OTHER",
  ]);
  if (relevance === null || pageRole === null) return null;

  let contextRelation: EvidenceJudgment["contextRelation"] = null;
  let claimRelation: EvidenceJudgment["claimRelation"] = null;
  let locationRelation: EvidenceJudgment["locationRelation"] = null;

  if (opts.claimMode) {
    const ctx = choiceAnswer(answers.context_relation, [
      "SAME_CONTEXT",
      "DIFFERENT_CONTEXT",
      "HISTORICAL_REFERENCE",
      "UNCLEAR",
    ]);
    if (ctx !== null) {
      contextRelation = {
        sameContext: ctx.probabilities.SAME_CONTEXT,
        differentContext: ctx.probabilities.DIFFERENT_CONTEXT,
        historicalReference: ctx.probabilities.HISTORICAL_REFERENCE,
        unclear: ctx.probabilities.UNCLEAR,
      };
    }
    const cl = choiceAnswer(answers.claim_relation, [
      "SUPPORTS",
      "CONTRADICTS",
      "NEUTRAL",
      "INSUFFICIENT",
    ]);
    if (cl !== null) {
      claimRelation = {
        supports: cl.probabilities.SUPPORTS,
        contradicts: cl.probabilities.CONTRADICTS,
        neutral: cl.probabilities.NEUTRAL,
        insufficient: cl.probabilities.INSUFFICIENT,
      };
    }
    const loc = choiceAnswer(answers.location_relation, [
      "SAME_LOCATION",
      "DIFFERENT_LOCATION",
      "LOCATION_NOT_STATED",
      "UNCLEAR",
    ]);
    if (loc !== null) {
      locationRelation = {
        sameLocation: loc.probabilities.SAME_LOCATION,
        differentLocation: loc.probabilities.DIFFERENT_LOCATION,
        locationNotStated: loc.probabilities.LOCATION_NOT_STATED,
        unclear: loc.probabilities.UNCLEAR,
      };
    }
  }

  return {
    relevance: relevance.noul,
    contextRelation,
    pageRole: {
      reporting: pageRole.probabilities.REPORTING,
      factCheck: pageRole.probabilities.FACT_CHECK,
      socialRepost: pageRole.probabilities.SOCIAL_REPOST,
      aggregator: pageRole.probabilities.AGGREGATOR,
      commentary: pageRole.probabilities.COMMENTARY,
      other: pageRole.probabilities.OTHER,
    },
    claimRelation,
    locationRelation,
    model,
    schemaVersion: "contexttrail-evidence-v1",
  };
}

/**
 * Validate raw Jev answers into a §20.1 pairwise judgment, else null.
 * `provenance` is additive and optional, with the same semantics as in
 * {@link judgmentFromAnswers}.
 */
export function pairwiseFromAnswers(
  answers: Record<string, unknown>,
  provenance?: JevModelIdentity | null,
): PairwiseContextJudgment | null {
  if (provenance !== undefined && verifiedPinnedModel(provenance) === null) {
    return null;
  }
  const p = choiceAnswer(answers.pairwise_context, [
    "SAME_CONTEXT",
    "DIFFERENT_CONTEXT",
    "UNCLEAR",
  ]);
  if (p === null) return null;
  return {
    sameContext: p.probabilities.SAME_CONTEXT,
    differentContext: p.probabilities.DIFFERENT_CONTEXT,
    unclear: p.probabilities.UNCLEAR,
  };
}

export { evidenceQuestions, PAIRWISE_QUESTION };
