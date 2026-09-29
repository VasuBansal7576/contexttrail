import { describe, expect, it } from "vitest";
import {
  reportingGroupCount,
  satisfiesCorroborationGate,
  unresolvedOriginCount,
} from "../reporting-origins";
import { makeCandidate, separateOrigin, sharedOrigin } from "./testkit";

describe("reporting-origin gate (§13, §38.3)", () => {
  it("syndicated copies on different domains share one group and cannot corroborate", () => {
    const a = sharedOrigin(makeCandidate(), "wire-report");
    const b = sharedOrigin(makeCandidate(), "wire-report");
    a.registrableDomain = "a.com";
    b.registrableDomain = "b.com";
    expect(satisfiesCorroborationGate([a, b]).satisfied).toBe(false);
    expect(reportingGroupCount([a, b])).toBe(1);
  });

  it("unresolved origins cannot satisfy the gate even across domains", () => {
    const a = makeCandidate();
    const b = makeCandidate();
    a.registrableDomain = "a.com";
    b.registrableDomain = "b.com";
    expect(satisfiesCorroborationGate([a, b]).satisfied).toBe(false);
    expect(unresolvedOriginCount([a, b])).toBe(2);
  });

  it("different hostnames alone are not corroboration", () => {
    const a = separateOrigin(makeCandidate(), "g1");
    const b = separateOrigin(makeCandidate(), "g1");
    a.registrableDomain = "a.com";
    b.registrableDomain = "b.com";
    // same group -> shared reporting origin, not corroboration
    expect(satisfiesCorroborationGate([a, b]).satisfied).toBe(false);
  });

  it("two separately evidenced groups on distinct domains satisfy", () => {
    const a = separateOrigin(makeCandidate(), "g1");
    const b = separateOrigin(makeCandidate(), "g2");
    a.registrableDomain = "a.com";
    b.registrableDomain = "b.com";
    const r = satisfiesCorroborationGate([a, b]);
    expect(r.satisfied).toBe(true);
    expect(r.pairIds).toEqual([a.id, b.id]);
  });

  it("same-domain separately-evidenced groups do not satisfy", () => {
    const a = separateOrigin(makeCandidate(), "g1");
    const b = separateOrigin(makeCandidate(), "g2");
    a.registrableDomain = "news.com";
    b.registrableDomain = "news.com";
    expect(satisfiesCorroborationGate([a, b]).satisfied).toBe(false);
  });
});
