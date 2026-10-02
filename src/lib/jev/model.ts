/** Browser-safe pinned model provenance and probability-validation policy. */
/** §15.1 — pinned production model. Never a moving alias. */
export const JEV_MODEL = "jev-1.13.0";

/**
 * Assumed number of decimal places retained in a provider probability.
 *
 * Honest scope: no documented provider precision or rounding guarantee was
 * found, and no live response was observed. This is a local policy input, not a
 * fact about TypeSafe. It is exported and single-sourced so a retained response
 * can correct it in one place.
 */
export const JEV_PROBABILITY_RETAINED_DECIMALS = 3;

/**
 * Absolute tolerance allowed between the sum of a Choice answer's declared
 * option probabilities and 1.
 *
 * Rounding a value to {@link JEV_PROBABILITY_RETAINED_DECIMALS} decimals can
 * move it by up to half a unit in the last retained place, so a distribution of
 * N options can miss 1 by up to N times that. A fixed tolerance would have to
 * either reject legitimate rounded output (six options at .167 sum to 1.002, a
 * 0.002 miss) or admit genuinely broken maps, so the tolerance scales with the
 * option count. With six options and three retained decimals it is 0.003; the
 * clearly non-distributional cases are still refused (six at .9 = 5.4, six at
 * .2 = 1.2, six at .25 = 1.5, three at .33 = 0.99).
 *
 * Values are **not** renormalized. The accepted components are the provider's
 * own numbers, because the frozen §17 thresholds are compared against them
 * directly and rescaling them here would change what those thresholds mean.
 */
export function jevProbabilitySumTolerance(optionCount: number): number {
  return optionCount * 0.5 * 10 ** -JEV_PROBABILITY_RETAINED_DECIMALS;
}

/**
 * Absolute difference within which two option probabilities count as tied, so
 * that either may be the declared winner. Two values that were equal before
 * rounding can differ by up to one unit in the last retained place, so the
 * bound is one full unit there rather than half.
 */
export const JEV_WINNER_TIE_TOLERANCE = 10 ** -JEV_PROBABILITY_RETAINED_DECIMALS;


function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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
 * pinned model label: the identifiers themselves must show that the provider
 * answered as the model that was actually requested, and that model must be the
 * pinned one.
 *
 * The `status`/`pinned` fields on the supplied record are deliberately *not*
 * trusted — they are derived data and a caller could hand-build a record whose
 * flags say "verified" while its identifiers say otherwise. The identifiers are
 * re-resolved here, so only `requested === reported === JEV_MODEL` qualifies. An
 * explicit override to any other model is therefore reported, never relabelled —
 * §46 requires provider model details to change only through an explicit
 * revision of the pinned constant and the §15.5 contract together.
 */
export function verifiedPinnedModel(
  identity: JevModelIdentity | null | undefined,
): typeof JEV_MODEL | null {
  if (identity === null || identity === undefined) return null;
  if (!isRecord(identity)) return null;
  const requested = identity.requested;
  const reported = identity.reported;
  if (typeof requested !== "string" || typeof reported !== "string") return null;
  const recheck = resolveModelIdentity(requested, reported);
  if (recheck.status !== "verified" || !recheck.pinned) return null;
  return JEV_MODEL;
}

