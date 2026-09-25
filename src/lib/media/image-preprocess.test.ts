import { describe, expect, it } from "vitest";
import {
  MAX_BYTES,
  MIN_QUALITY,
  START_QUALITY,
  isSupportedImageFile,
  qualityLadder,
} from "./image-preprocess.client";

describe("qualityLadder", () => {
  it("starts at 0.82 and never drops below 0.55", () => {
    const ladder = qualityLadder();
    expect(ladder[0]).toBe(START_QUALITY);
    expect(Math.min(...ladder)).toBeGreaterThanOrEqual(MIN_QUALITY);
    expect(ladder).toHaveLength(new Set(ladder).size);
  });

  it("is strictly descending", () => {
    const ladder = qualityLadder();
    for (let i = 1; i < ladder.length; i++) {
      expect(ladder[i]).toBeLessThan(ladder[i - 1]);
    }
  });
});

describe("payload budget", () => {
  it("targets 450 KB", () => {
    expect(MAX_BYTES).toBe(450 * 1024);
  });
});

describe("isSupportedImageFile", () => {
  const makeFile = (name: string, type: string) => new File(["x"], name, { type });

  it("accepts JPEG, PNG, and WebP", () => {
    expect(isSupportedImageFile(makeFile("a.jpg", "image/jpeg"))).toBe(true);
    expect(isSupportedImageFile(makeFile("a.jpeg", "image/jpeg"))).toBe(true);
    expect(isSupportedImageFile(makeFile("a.png", "image/png"))).toBe(true);
    expect(isSupportedImageFile(makeFile("a.webp", "image/webp"))).toBe(true);
  });

  it("rejects video and other types", () => {
    expect(isSupportedImageFile(makeFile("a.mp4", "video/mp4"))).toBe(false);
    expect(isSupportedImageFile(makeFile("a.gif", "image/gif"))).toBe(false);
    expect(isSupportedImageFile(makeFile("a.pdf", "application/pdf"))).toBe(false);
  });
});
