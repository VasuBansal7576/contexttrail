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
import { fetchJsonBounded } from "../providers/http";
import {
  PAIRWISE_QUESTION,
  evidenceQuestions,
  type JevQuestion,
} from "./questions";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-1.13.0";
const JEV_MAX_BYTES = 1 * 1024 * 1024;

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
  choice: string;
  confidence?: number;
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

function choiceAnswer(v: unknown, keys: string[]): JevAnswerChoice | null {
  if (!isRecord(v) || v.type !== "choice") return null;
  const probs = v.probabilities;
  if (!isRecord(probs)) return null;
  const out: Record<string, number> = {};
  for (const k of keys) {
    const p = probs[k];
    if (!validProb(p)) return null;
    out[k] = p;
  }
  return {
    type: "choice",
    choice: typeof v.choice === "string" ? v.choice : keys[0],
    probabilities: out,
  };
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

  /** One Jev call: state + questions map (§15.3). */
  async ask(
    state: unknown,
    questions: Record<string, JevQuestion>,
    signal?: AbortSignal,
  ): Promise<{ answers: Record<string, unknown>; model: string | null }> {
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
    if (!isRecord(json) || !isRecord(json.answers)) {
      return { answers: {}, model: null };
    }
    return {
      answers: json.answers as Record<string, unknown>,
      model: typeof json.model === "string" ? json.model : null,
    };
  }
}

/**
 * Validate raw Jev answers into an EvidenceJudgment. Required surfaces
 * (relevance, page role) missing or malformed => null (the caller stores
 * judgment=null per §29). Claim-check surfaces degrade to null when absent.
 */
export function judgmentFromAnswers(
  answers: Record<string, unknown>,
  opts: { claimMode: boolean },
): EvidenceJudgment | null {
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
    model: "jev-1.13.0",
    schemaVersion: "contexttrail-evidence-v1",
  };
}

/** Validate raw Jev answers into a §20.1 pairwise judgment, else null. */
export function pairwiseFromAnswers(
  answers: Record<string, unknown>,
): PairwiseContextJudgment | null {
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
