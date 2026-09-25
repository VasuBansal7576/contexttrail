/**
 * Bounded search-budget policy (spec §7, §8, §29).
 *
 * Hard invariants enforced here:
 * - every attempted search consumes budget *before* dispatch, including
 *   failures and retries;
 * - each base slot may be reserved at most once — a failed base slot is never
 *   silently retried or repurposed;
 * - at most one adaptive expansion exists per mode, and only after every base
 *   slot has been consumed ("reserve base-call capacity before permitting
 *   expansion");
 * - Trace mode's adaptive slot is Google Search on a related-content query
 *   only; Claim-check mode may also spend it on a refined Lens type=all query;
 * - the image upload is one bounded attempt and never a search request;
 * - About This Image and the dedicated exact-match request each run at most
 *   once per investigation.
 */

import type { InvestigationMode } from "./contracts/investigation";
import {
  CLAIM_MAX_SEARCHES,
  MAX_IMAGE_UPLOAD_ATTEMPTS,
  TRACE_MAX_SEARCHES,
} from "./limits";

/** Distinct reserved request slots, one per SerpApi request kind. */
export type BaseSearchSlot =
  | "lens_all"
  | "lens_exact_matches"
  | "lens_about_this_image"
  | "google_search_claim"
  | "google_news_claim";

export type AdaptiveSearchSlot =
  /** Claim mode §8: Lens type=all refined with q=claim. */
  | "adaptive_lens_refined"
  /** §8 / §7.2: Google Search on strongest related-content or quoted query. */
  | "adaptive_google_search";

export type SearchSlot = BaseSearchSlot | AdaptiveSearchSlot;

export type SearchOutcome = "pending" | "succeeded" | "failed";

export interface SearchTicket {
  readonly slot: SearchSlot;
  readonly sequence: number;
  readonly reservedAtMs: number;
  outcome: SearchOutcome;
  /** Mark a completed attempt. The budget was already consumed at reserve. */
  succeed(): void;
  fail(): void;
}

const CLAIM_BASE_SLOTS: readonly BaseSearchSlot[] = [
  "lens_all",
  "lens_exact_matches",
  "lens_about_this_image",
  "google_search_claim",
  "google_news_claim",
];

const TRACE_BASE_SLOTS: readonly BaseSearchSlot[] = [
  "lens_all",
  "lens_exact_matches",
  "lens_about_this_image",
];

const CLAIM_ADAPTIVE_SLOTS: readonly AdaptiveSearchSlot[] = [
  "adaptive_lens_refined",
  "adaptive_google_search",
];

const TRACE_ADAPTIVE_SLOTS: readonly AdaptiveSearchSlot[] = [
  "adaptive_google_search",
];

export class SearchBudget {
  readonly mode: InvestigationMode;
  readonly maxSearches: number;

  private readonly baseSlots: ReadonlySet<BaseSearchSlot>;
  private readonly adaptiveSlots: ReadonlySet<AdaptiveSearchSlot>;
  private readonly usedSlots = new Set<SearchSlot>();
  private readonly attempts: SearchTicket[] = [];
  private uploadAttempts = 0;
  private adaptiveConsumed = false;

  constructor(mode: InvestigationMode) {
    this.mode = mode;
    this.maxSearches =
      mode === "claim_check" ? CLAIM_MAX_SEARCHES : TRACE_MAX_SEARCHES;
    this.baseSlots = new Set(
      mode === "claim_check" ? CLAIM_BASE_SLOTS : TRACE_BASE_SLOTS,
    );
    this.adaptiveSlots = new Set(
      mode === "claim_check" ? CLAIM_ADAPTIVE_SLOTS : TRACE_ADAPTIVE_SLOTS,
    );
  }

  get used(): number {
    return this.attempts.length;
  }

  get remaining(): number {
    return this.maxSearches - this.used;
  }

  get searchAttempts(): readonly SearchTicket[] {
    return this.attempts;
  }

  /** True once every base slot for this mode has consumed its reservation. */
  get baseCapacityReserved(): boolean {
    for (const slot of this.baseSlots) {
      if (!this.usedSlots.has(slot)) return false;
    }
    return true;
  }

  /**
   * Reserve a base search slot. Returns null when the slot is not part of
   * this mode's base budget or was already consumed — a failed base call may
   * not be retried or repurposed (§7.2, §29).
   */
  reserveBase(slot: BaseSearchSlot, nowMs = Date.now()): SearchTicket | null {
    if (!this.baseSlots.has(slot)) return null;
    if (this.usedSlots.has(slot)) return null;
    return this.consume(slot, nowMs);
  }

  /**
   * Reserve the single adaptive expansion slot (§8). Denied until all base
   * capacity is reserved, denied a second time, and denied for engines the
   * mode does not allow.
   */
  reserveAdaptive(
    slot: AdaptiveSearchSlot,
    nowMs = Date.now(),
  ): SearchTicket | null {
    if (!this.adaptiveSlots.has(slot)) return null;
    if (!this.baseCapacityReserved) return null;
    if (this.adaptiveConsumed) return null;
    const ticket = this.consume(slot, nowMs);
    if (ticket !== null) this.adaptiveConsumed = true;
    return ticket;
  }

  /**
   * The upload is one bounded attempt and is not a search request (§7.2).
   * Returns false once the single attempt has been used.
   */
  tryReserveUpload(): boolean {
    if (this.uploadAttempts >= MAX_IMAGE_UPLOAD_ATTEMPTS) return false;
    this.uploadAttempts += 1;
    return true;
  }

  /** Attempts against a given slot (0 or 1 — slots are single-use). */
  attemptFor(slot: SearchSlot): SearchTicket | null {
    return this.attempts.find((a) => a.slot === slot) ?? null;
  }

  /**
   * §29 — fatal condition: both the visual-discovery (type=all) and the
   * dedicated exact-match requests failed. About This Image success does not
   * satisfy visual-search success.
   */
  visualSearchFatallyFailed(): boolean {
    const all = this.attemptFor("lens_all");
    const exact = this.attemptFor("lens_exact_matches");
    return all?.outcome === "failed" && exact?.outcome === "failed";
  }

  private consume(slot: SearchSlot, nowMs: number): SearchTicket | null {
    if (this.remaining <= 0) return null;
    if (this.usedSlots.has(slot)) return null;
    this.usedSlots.add(slot);
    const ticket: SearchTicket = {
      slot,
      sequence: this.attempts.length,
      reservedAtMs: nowMs,
      outcome: "pending",
      succeed() {
        if (ticket.outcome === "pending") ticket.outcome = "succeeded";
      },
      fail() {
        if (ticket.outcome === "pending") ticket.outcome = "failed";
      },
    };
    this.attempts.push(ticket);
    return ticket;
  }
}
