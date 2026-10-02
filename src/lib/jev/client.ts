import { JEV_MODEL, jevProbabilitySumTolerance, JEV_WINNER_TIE_TOLERANCE, resolveModelIdentity, verifiedPinnedModel, type JevModelIdentity } from './model';
export { JEV_MODEL, JEV_PROBABILITY_RETAINED_DECIMALS, jevProbabilitySumTolerance, JEV_WINNER_TIE_TOLERANCE, resolveModelIdentity, verifiedPinnedModel, type JevModelIdentity, type JevModelStatus } from './model';

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
export const JEV_MAX_BYTES = 1 * 1024 * 1024;

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
  /** the provider's declared winner, verbatim; always a declared option */
  choice: string;
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
 * §16 Choice answer validation at the boundary. Rejects — never repairs — when:
 * the shape is not a Choice; the option map is not an object; a declared option
 * is missing, non-finite, or outside 0..1; the map carries a key that is not a
 * declared option; the options do not sum to 1 within
 * {@link jevProbabilitySumTolerance} for the option count; or the declared winner
 * is absent, not a string, names an option that was not offered, or is not among
 * the tied maxima of the distribution it came with.
 *
 * On the undeclared-key rule: a repeated JSON key collapses during parsing and
 * is undetectable here, so this is *not* duplicate-key detection. What it does
 * refuse is an option the question never offered, which cannot be told apart
 * from an injected one.
 *
 * On the winner: the documented Choice contract specifies a required
 * highest-probability winner together with a distribution over the options. A
 * winner is therefore mandatory, and it is checked against the distribution so a
 * mismatched pair is refused rather than silently trusted. Ties are accepted —
 * the contract's "highest-probability" is satisfied by any tied maximum.
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
  if (Math.abs(sum - 1) > jevProbabilitySumTolerance(keys.length)) return null;
  if (typeof v.choice !== "string" || !keys.includes(v.choice)) return null;
  const max = Math.max(...keys.map((k) => out[k]));
  if (out[v.choice] < max - JEV_WINNER_TIE_TOLERANCE) return null;
  return { type: "choice", choice: v.choice, probabilities: out };
}

/** Typed result of one Jev call. `identity` is additive; `model` is retained. */
export interface JevAskResult {
  answers: Record<string, unknown>;
  /** retained for existing callers; mirrors `identity.reported` */
  model: string | null;
  identity: JevModelIdentity;
}

/**
 * Fail-closed model check for the provider boundary.
 *
 * Provenance policy, from the official contract and the PRD: the documented
 * TypeSafe response envelope carries a `model` field identifying the evaluator
 * that answered, the Models documentation states that responses identify the
 * version that answered and that aliases resolve to versions, and §15.1 pins
 * `jev-1.13.0` while §15.5 fixes `model` to that same literal. A response whose
 * model is absent or different therefore does not identify the pinned model, and
 * publishing a judgment labelled `jev-1.13.0` from it would fabricate the
 * provenance §34 (technical details) and §39 (logs) require. Such a response is
 * refused here and the caller stores `judgment=null` per §29.
 *
 * The message is a **static** string chosen from a fixed set. Nothing derived
 * from the response body or from a configured override is interpolated: a
 * `model` field is untrusted response content and could otherwise echo sensitive
 * data or inject log lines. The allowlist of version identifiers that may be
 * recorded anywhere is therefore exactly the verified pinned model, which is
 * only ever attached to a successful result.
 */
function assertVerifiedModel(identity: JevModelIdentity): void {
  if (verifiedPinnedModel(identity) !== null) return;
  let reason: string;
  if (identity.reported === null) {
    reason = "jev model identity missing";
  } else if (identity.reported !== identity.requested) {
    reason = "jev model identity unexpected";
  } else {
    reason = "jev model is not the pinned model";
  }
  throw new ProviderError("malformed", reason);
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
 * `provenance` is **required**. There is deliberately no default: a judgment
 * carries the literal `model: "jev-1.13.0"`, so constructing one without the
 * provider identity that produced it would be exactly the relabelling this
 * module exists to prevent. Pass the `identity` returned by
 * {@link JevClient.ask}; a null, absent, or non-verified identity yields null.
 */
export function judgmentFromAnswers(
  answers: Record<string, unknown>,
  opts: { claimMode: boolean; provenance: JevModelIdentity | null },
): EvidenceJudgment | null {
  const model = verifiedPinnedModel(opts.provenance);
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
 * `provenance` is **required**, with the same semantics and the same refusal of
 * a default as in {@link judgmentFromAnswers}.
 */
export function pairwiseFromAnswers(
  answers: Record<string, unknown>,
  provenance: JevModelIdentity | null,
): PairwiseContextJudgment | null {
  if (verifiedPinnedModel(provenance) === null) return null;
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
