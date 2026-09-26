import { describe, expect, it } from "vitest";
import { applyEvent, type InvestigationSnapshot } from "./useInvestigation";
import type { InvestigationEvent } from "./events";

const snap = (overrides: Partial<InvestigationSnapshot> = {}): InvestigationSnapshot => ({
  phase: "streaming",
  investigationId: "inv-1",
  stages: [],
  searchCounts: [],
  evidence: [],
  classifications: {},
  partialTimeline: null,
  preliminaryVerdict: null,
  divergence: null,
  result: null,
  error: null,
  ...overrides,
});

const discovered = (id: string, extra: Record<string, unknown> = {}): InvestigationEvent => ({
  type: "evidence.discovered",
  evidence: { id, canonicalUrl: `https://example.com/${id}`, ...extra },
});

describe("applyEvent — evidence.discovered", () => {
  it("appends distinct evidence ids in order", () => {
    const s = applyEvent(applyEvent(snap(), discovered("ev-1")), discovered("ev-2"));
    expect(s.evidence.map((e) => e.id)).toEqual(["ev-1", "ev-2"]);
  });

  it("a repeated id enriches the existing row instead of duplicating it", () => {
    let s = applyEvent(snap(), discovered("ev-1", { title: "first" }));
    s = applyEvent(s, discovered("ev-2"));
    // Server dedupe is primary, but the reducer must also never duplicate an id.
    s = applyEvent(s, discovered("ev-1", { snippet: "page text" }));
    expect(s.evidence).toHaveLength(2);
    const merged = s.evidence.find((e) => e.id === "ev-1");
    expect(merged?.title).toBe("first");
    expect(merged?.snippet).toBe("page text");
    // Position preserved — no duplicate React key.
    expect(s.evidence.map((e) => e.id)).toEqual(["ev-1", "ev-2"]);
  });
});
