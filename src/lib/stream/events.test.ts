import { describe, expect, it } from "vitest";
import { isKnownEventType, parseEventLine } from "./events";

describe("parseEventLine", () => {
  it("parses a documented event", () => {
    const event = parseEventLine(
      JSON.stringify({ type: "search.batch", engine: "google_lens", count: 18 }),
    );
    expect(event).toMatchObject({ type: "search.batch", engine: "google_lens", count: 18 });
  });

  it("returns null for blank lines", () => {
    expect(parseEventLine("")).toBeNull();
    expect(parseEventLine("   \n")).toBeNull();
  });

  it("returns null for malformed JSON instead of throwing", () => {
    expect(parseEventLine("{not json")).toBeNull();
  });

  it("returns null when type is missing or not a string", () => {
    expect(parseEventLine(JSON.stringify({ count: 3 }))).toBeNull();
    expect(parseEventLine(JSON.stringify({ type: 42 }))).toBeNull();
    expect(parseEventLine(JSON.stringify([1, 2]))).toBeNull();
  });

  it("tolerates unknown future event types without throwing", () => {
    const event = parseEventLine(JSON.stringify({ type: "analysis.new-detail", foo: "bar" }));
    expect(event).toMatchObject({ type: "analysis.new-detail" });
    expect(isKnownEventType("analysis.new-detail")).toBe(false);
  });

  it("recognizes documented event types", () => {
    for (const type of [
      "investigation.started",
      "stage.started",
      "stage.completed",
      "search.batch",
      "evidence.discovered",
      "evidence.classified",
      "provenance.partial",
      "verdict.preliminary",
      "divergence.detected",
      "investigation.completed",
      "investigation.error",
    ]) {
      expect(isKnownEventType(type)).toBe(true);
    }
  });
});
