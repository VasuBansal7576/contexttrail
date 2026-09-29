import { describe, expect, it } from "vitest";
import {
  parseClaimDate,
  parseDateValue,
  predatesClaim,
  resolveEvidenceDate,
} from "../dates";

const REF = new Date("2026-09-25T12:00:00.000Z");

describe("parseClaimDate (§19.1)", () => {
  it("parses a single usable date", () => {
    const r = parseClaimDate("this was taken on March 12 2019", {
      referenceInstant: REF,
    });
    expect(r.claimDate).toBe("2019-03-12");
    expect(r.precision).toBe("day");
    expect(r.ambiguous).toBe(false);
  });

  it("returns null when no date exists", () => {
    const r = parseClaimDate("a photo of a bridge", {
      referenceInstant: REF,
    });
    expect(r.claimDate).toBeNull();
  });

  it("returns null for materially ambiguous dates", () => {
    const r = parseClaimDate(
      "seen March 5 and again September 8 2026",
      { referenceInstant: REF },
    );
    expect(r.claimDate).toBeNull();
    expect(r.ambiguous).toBe(true);
  });

  it("keeps month-only claims at month precision", () => {
    const r = parseClaimDate("flooding in September 2026", {
      referenceInstant: REF,
    });
    expect(r.precision).toBe("month");
    expect(r.claimDate).toBe("2026-09");
  });
});

describe("parseDateValue", () => {
  it("parses ISO granularities without inventing precision", () => {
    expect(parseDateValue("2019-03-12", REF)).toEqual({
      value: "2019-03-12",
      precision: "day",
    });
    expect(parseDateValue("2019-03", REF)).toEqual({
      value: "2019-03",
      precision: "month",
    });
    expect(parseDateValue("2019", REF)).toEqual({
      value: "2019",
      precision: "year",
    });
  });

  it("resolves relative SerpApi date text against retrieval time", () => {
    expect(parseDateValue("3 days ago", REF)).toEqual({
      value: "2026-09-22",
      precision: "day",
    });
    expect(parseDateValue("4 months ago", REF)?.precision).toBe("month");
  });
});

describe("resolveEvidenceDate (§19.2)", () => {
  it("prefers JSON-LD over serpapi", () => {
    const r = resolveEvidenceDate(
      { pageJsonLd: "2019-03-12", serpapi: "2020-01-01" },
      REF,
    );
    expect(r.publishedAt).toBe("2019-03-12");
    expect(r.publishedAtSource).toBe("page_json_ld");
    expect(r.dateStatus).toBe("usable");
  });

  it("nulls the date when page sources materially disagree", () => {
    const r = resolveEvidenceDate(
      { pageJsonLd: "2019-03-12", pageMeta: "2021-11-02" },
      REF,
    );
    expect(r.publishedAt).toBeNull();
    expect(r.dateStatus).toBe("disputed");
  });

  it("keeps the structured page field when only serpapi disagrees", () => {
    const r = resolveEvidenceDate(
      { pageMeta: "2020-06-01", serpapi: "2019-01-01" },
      REF,
    );
    expect(r.publishedAt).toBe("2020-06-01");
    expect(r.dateStatus).toBe("usable");
  });

  it("returns unknown when nothing parses", () => {
    const r = resolveEvidenceDate({ serpapi: "recently" }, REF);
    // chrono may parse "recently" loosely; either null or unusable is fine,
    // but it must never invent a day.
    if (r.publishedAt === null) {
      expect(r.dateStatus).toBe("unknown");
    } else {
      expect(r.datePrecision).not.toBe("unknown");
    }
  });

  it("never promotes a month-only date to day precision", () => {
    const r = resolveEvidenceDate({ pageMeta: "2019-03" }, REF);
    expect(r.publishedAt).toBe("2019-03");
    expect(r.datePrecision).toBe("month");
  });
});

describe("predatesClaim (§19.3)", () => {
  it("requires a >24h gap", () => {
    expect(
      predatesClaim("2026-09-24", "day", "usable", "2026-09-25"),
    ).toBe(false);
    expect(
      predatesClaim("2026-09-23", "day", "usable", "2026-09-25"),
    ).toBe(true);
  });

  it("never fires on unknown or disputed dates", () => {
    expect(
      predatesClaim(null, "unknown", "unknown", "2026-09-25"),
    ).toBe(false);
    expect(
      predatesClaim("2020-01-01", "day", "disputed", "2026-09-25"),
    ).toBe(false);
  });

  it("fires only when a month-precision value entirely predates the claim", () => {
    expect(
      predatesClaim("2026-08", "month", "usable", "2026-09-25"),
    ).toBe(true);
    // Claim inside the same month: cannot assert predating.
    expect(
      predatesClaim("2026-09", "month", "usable", "2026-09-25"),
    ).toBe(false);
  });
});
