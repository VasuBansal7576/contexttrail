import { describe, expect, it } from "vitest";
import { SearchBudget } from "../budget";

describe("SearchBudget (§7, §29, §38.3)", () => {
  it("claim-check allows 5 base + at most 1 adaptive = 6 max", () => {
    const b = new SearchBudget("claim_check");
    for (const slot of [
      "lens_all",
      "lens_exact_matches",
      "lens_about_this_image",
      "google_search_claim",
      "google_news_claim",
    ] as const) {
      expect(b.reserveBase(slot)).not.toBeNull();
    }
    expect(b.used).toBe(5);
    expect(b.reserveAdaptive("adaptive_google_search")).not.toBeNull();
    expect(b.used).toBe(6);
    expect(b.remaining).toBe(0);
  });

  it("trace allows 3 base + at most 1 adaptive = 4 max", () => {
    const b = new SearchBudget("trace");
    expect(b.reserveBase("lens_all")).not.toBeNull();
    expect(b.reserveBase("lens_exact_matches")).not.toBeNull();
    expect(b.reserveBase("lens_about_this_image")).not.toBeNull();
    // claim-side searches are not part of trace base capacity
    expect(b.reserveBase("google_search_claim")).toBeNull();
    expect(b.reserveAdaptive("adaptive_google_search")).not.toBeNull();
    expect(b.used).toBe(4);
  });

  it("denies adaptive expansion before all base capacity is reserved", () => {
    const b = new SearchBudget("claim_check");
    b.reserveBase("lens_all");
    expect(b.reserveAdaptive("adaptive_google_search")).toBeNull();
  });

  it("denies a second adaptive search", () => {
    const b = new SearchBudget("trace");
    b.reserveBase("lens_all");
    b.reserveBase("lens_exact_matches");
    b.reserveBase("lens_about_this_image");
    expect(b.reserveAdaptive("adaptive_google_search")).not.toBeNull();
    expect(b.reserveAdaptive("adaptive_google_search")).toBeNull();
    expect(b.reserveAdaptive("adaptive_lens_refined")).toBeNull();
  });

  it("denies trace-mode lens refinement (claim-only adaptive slot)", () => {
    const b = new SearchBudget("trace");
    b.reserveBase("lens_all");
    b.reserveBase("lens_exact_matches");
    b.reserveBase("lens_about_this_image");
    expect(b.reserveAdaptive("adaptive_lens_refined")).toBeNull();
  });

  it("a failed base slot is consumed and cannot be retried", () => {
    const b = new SearchBudget("claim_check");
    const t = b.reserveBase("lens_exact_matches");
    expect(t).not.toBeNull();
    t!.fail();
    expect(b.reserveBase("lens_exact_matches")).toBeNull();
    expect(b.attemptFor("lens_exact_matches")?.outcome).toBe("failed");
  });

  it("detects the fatal both-lens-failures condition", () => {
    const b = new SearchBudget("trace");
    b.reserveBase("lens_all")!.fail();
    b.reserveBase("lens_exact_matches")!.fail();
    expect(b.visualSearchFatallyFailed()).toBe(true);
  });

  it("about-this-image success does not rescue fatal visual failure", () => {
    const b = new SearchBudget("trace");
    b.reserveBase("lens_all")!.fail();
    b.reserveBase("lens_exact_matches")!.fail();
    b.reserveBase("lens_about_this_image")!.succeed();
    expect(b.visualSearchFatallyFailed()).toBe(true);
  });

  it("bounds the image upload to one attempt outside search budget", () => {
    const b = new SearchBudget("trace");
    expect(b.tryReserveUpload()).toBe(true);
    expect(b.tryReserveUpload()).toBe(false);
    expect(b.used).toBe(0);
  });
});
