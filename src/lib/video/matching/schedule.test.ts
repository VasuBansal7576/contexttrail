import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { comparePreparedMedia } from './compare';
import { comparePreparedMediaAsync } from './schedule';
import type { PreparedMatchFrame, PreparedMatchMedia } from './model';

function media(seed: number, count: number): PreparedMatchMedia {
  const mediaId = `unit-media-${seed}`;
  const frames: PreparedMatchFrame[] = Array.from({ length: count }, (_, index) => {
    const bytes = new Uint8Array([seed, index]), pixels = new Uint8Array(96 * 96 * 3);
    let state = seed + index;
    for (let i = 0; i < pixels.length; i++) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; pixels[i] = state >>> 16 & 255; }
    return { mediaId, frameId: `${mediaId}:${index}`, timestampMs: index * 1000, contentHash: createHash('sha256').update(bytes).digest('hex'), mimeType: 'image/png', bytes, pixels, width: 96, height: 96 };
  });
  return { mediaId, contentHash: `unit-hash-${seed}`, frames, rasterPreprocessing: 'encoded_orientation_black_alpha_matte', coverage: { kind: 'sampled_video', durationMs: 3000, requestedTimestampsMs: [0, 1000, 2000], decodedTimestampsMs: frames.map(frame => frame.timestampMs ?? 0), sampleCount: frames.length, largestUnsampledGapMs: 1000, temporalCoverageFraction: null, audioAnalyzed: false } };
}
describe('scheduling around the frozen matcher', () => {
  it('preserves the evaluator-pinned matcher bytes', async () => {
    const bytes = await readFile(new URL('./compare.ts', import.meta.url));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe('c755c5c891ee2c79feb99b272772a8e1160783367b942b79f8474f93757b2575');
  });
  it.each([[0, 0], [1, 3], [3, 3]])('keeps the complete report for %s by %s prepared frames', async (leftCount, rightCount) => {
    const left = media(11, leftCount), right = media(19, rightCount);
    expect(await comparePreparedMediaAsync(left, right, new AbortController().signal)).toEqual(comparePreparedMedia(left, right));
  });
  it('delivers cancellation between bounded pair calls', async () => {
    const controller = new AbortController();
    const pending = comparePreparedMediaAsync(media(11, 3), media(19, 3), controller.signal);
    await setImmediate(); controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  });
});
