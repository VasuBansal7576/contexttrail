/**
 * Jev question sets (spec §15.3, §16, §20.1).
 *
 * Instructions and option descriptions are copied verbatim from the frozen
 * spec; question keys are wire labels only — the model never sees them as
 * semantic input beyond the instruction text.
 */

import type { EvidenceCandidate } from "../investigation/contracts/evidence";

export type JevQuestionType = "noul" | "choice" | "score";

export interface JevQuestion {
  type: JevQuestionType;
  instructions: string;
  criteria?: Record<string, string | null>;
}

/** §16.1 — Relevance (Noul). */
export const RELEVANCE_QUESTION: JevQuestion = {
  type: "noul",
  instructions:
    "Based only on the supplied evidence, is this result materially relevant to the image or event under investigation?",
  criteria: {
    true: "The result contains meaningful evidence concerning the same media, the same underlying event, or directly related context.",
    false: "The relationship is incidental, generic, or off-topic.",
  },
};

/** §16.2 — Context relationship (Choice, claim-check mode only). */
export const CONTEXT_QUESTION: JevQuestion = {
  type: "choice",
  instructions:
    "How does the context described by this result relate to the context asserted in the user's claim?",
  criteria: {
    SAME_CONTEXT:
      "The result appears to describe the same underlying event or situation asserted by the claim.",
    DIFFERENT_CONTEXT:
      "The result associates the media with a different event, place, time, or situation.",
    HISTORICAL_REFERENCE:
      "The result discusses the same or related media historically or retrospectively rather than presenting it as the claimed current event.",
    UNCLEAR:
      "The evidence does not contain enough information to determine the relationship.",
  },
};

/** §16.3 — Page role (Choice). */
export const PAGE_ROLE_QUESTION: JevQuestion = {
  type: "choice",
  instructions:
    "What role does this page appear to play based only on the supplied evidence?",
  criteria: {
    REPORTING: null,
    FACT_CHECK: null,
    SOCIAL_REPOST: null,
    AGGREGATOR: null,
    COMMENTARY: null,
    OTHER: null,
  },
};

/** §16.4 — Claim relationship (Choice, claim-check mode only). */
export const CLAIM_QUESTION: JevQuestion = {
  type: "choice",
  instructions:
    "Based only on the supplied evidence, how does this source relate to the user's claim about what the media depicts?",
  criteria: {
    SUPPORTS: null,
    CONTRADICTS: null,
    NEUTRAL: null,
    INSUFFICIENT: null,
  },
};

/** §16.5 — Location relationship (Choice, only when the claim states one). */
export const LOCATION_QUESTION: JevQuestion = {
  type: "choice",
  instructions:
    "Based only on explicit location information in the claim and evidence, how do the locations relate?",
  criteria: {
    SAME_LOCATION: null,
    DIFFERENT_LOCATION: null,
    LOCATION_NOT_STATED: null,
    UNCLEAR: null,
  },
};

/** §20.1 — Pairwise context comparison (Choice). */
export const PAIRWISE_QUESTION: JevQuestion = {
  type: "choice",
  instructions:
    "Do these two occurrences present the media as belonging to the same underlying event or context?",
  criteria: {
    SAME_CONTEXT: null,
    DIFFERENT_CONTEXT: null,
    UNCLEAR: null,
  },
};

/** §15.3 — one candidate per Jev state; never the whole pool. */
export function candidateState(
  c: EvidenceCandidate,
  claim: string | null,
  excerpt: string | null,
): Record<string, unknown> {
  return {
    claim,
    media_relationship: c.mediaRelationship,
    result: {
      title: c.title,
      snippet: c.snippet,
      domain: c.registrableDomain,
      published_at: c.publishedAt,
      retrieval_kind: c.retrievalKind,
      page_excerpt: excerpt,
    },
  };
}

/** §20.1 — two occurrences per pairwise state. */
export function pairwiseState(
  a: EvidenceCandidate,
  b: EvidenceCandidate,
  excerptA: string | null,
  excerptB: string | null,
): Record<string, unknown> {
  const summarize = (c: EvidenceCandidate, excerpt: string | null) => ({
    title: c.title,
    snippet: c.snippet,
    domain: c.registrableDomain,
    published_at: c.publishedAt,
    media_relationship: c.mediaRelationship,
    page_excerpt: excerpt,
  });
  return { occurrence_a: summarize(a, excerptA), occurrence_b: summarize(b, excerptB) };
}

/**
 * §16.5 — location question is only asked when the claim explicitly contains
 * a plausible location token. Conservative heuristic: a capitalized word
 * (>=3 letters) that is not the first token and not a date/month/weekday.
 */
export function claimMayStateLocation(claim: string): boolean {
  const stop = new Set([
    "this", "that", "these", "those", "today", "yesterday", "monday",
    "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
    "january", "february", "march", "april", "june", "july", "august",
    "september", "october", "november", "december", "breaking", "photo",
    "image", "video", "live", "news", "watch",
  ]);
  const tokens = claim.split(/\s+/).filter((t) => t.length > 0);
  for (let i = 1; i < tokens.length; i++) {
    const w = tokens[i].replace(/[^A-Za-z]/g, "");
    if (w.length >= 3 && /^[A-Z]/.test(w) && !stop.has(w.toLowerCase())) {
      return true;
    }
  }
  return false;
}

/** Build the §16 question map for one candidate. */
export function evidenceQuestions(opts: {
  claimMode: boolean;
  claimHasLocation: boolean;
}): Record<string, JevQuestion> {
  const q: Record<string, JevQuestion> = {
    relevance: RELEVANCE_QUESTION,
    page_role: PAGE_ROLE_QUESTION,
  };
  if (opts.claimMode) {
    q.context_relation = CONTEXT_QUESTION;
    q.claim_relation = CLAIM_QUESTION;
    if (opts.claimHasLocation) q.location_relation = LOCATION_QUESTION;
  }
  return q;
}
