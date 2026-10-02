import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { prepareMatchMedia } from './prepare';
import { comparePreparedMedia, MATCH_PARAMETERS } from './compare';
import { MATCH_LIMITS } from './model';
import { decodeMatchImage } from './decode';
import { syntheticPng, transformPng } from './fixtures';
const available = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const image = (bytes: Uint8Array) => prepareMatchMedia({ kind: 'image', bytes, rights: 'user_provided' });

it('requires real FFmpeg when explicitly requested', () => { if (process.env.VIDEO_REQUIRE_FFMPEG === '1') expect(available).toBe(true); });
it('rejects excessive inputs, unsupported signatures and pre-cancelled work', async () => {
  await expect(image(new Uint8Array(MATCH_LIMITS.imageBytes + 1))).rejects.toMatchObject({ code: 'limit_exceeded' });
  await expect(image(Buffer.from('not an image'))).rejects.toMatchObject({ code: 'invalid_image' });
  const controller = new AbortController(); controller.abort();
  await expect(prepareMatchMedia({ kind: 'video', bytes: Buffer.from('x'), rights: 'user_provided' }, { signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
});
describe.skipIf(!available)('actual local pixel comparison', () => {
  it('retains still-image hashes and distinguishes crop, subtitles and unrelated input', async () => {
    const bytes = syntheticPng(31415), base = await image(bytes);
    const variants = [bytes, transformPng(bytes, { crop: { x: 32, y: 24, width: 256, height: 192 } }), transformPng(bytes, { overlay: true })];
    for (const variant of variants) {
      const other = await image(variant), report = comparePreparedMedia(base, other);
      expect(report.candidates).toHaveLength(1);
      expect(report.candidates[0].left.timestampMs).toBeNull();
      expect(report.candidates[0].left.contentHash).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect(report.parameters).toEqual(MATCH_PARAMETERS);
      expect(JSON.stringify(report)).not.toContain('pixels');
    }
    const negative = comparePreparedMedia(base, await image(syntheticPng(8675309)));
    expect(negative.candidates).toHaveLength(0);
  }, 30000);
  it('rejects uninformative visual similarity but still reports identical encoded bytes', async () => {
    const a = new PNG({ width: 128, height: 128 }); a.data.fill(255);
    const first = PNG.sync.write(a); a.data.fill(248); for (let i = 3; i < a.data.length; i += 4) a.data[i] = 255;
    const second = PNG.sync.write(a), left = await image(first);
    expect(comparePreparedMedia(left, await image(second)).comparisons[0].status).toBe('uninformative');
    expect(comparePreparedMedia(left, await image(first)).candidates[0].basis).toBe('identical_encoded_bytes');
  });
  it('retains opposing edge errors above one in discarded tiles without promoting identity', async () => {
    const left = new PNG({ width: 96, height: 96 }), right = new PNG({ width: 96, height: 96 });
    for (let y = 0; y < 96; y++) for (let x = 0; x < 96; x++) {
      const offset = (y * 96 + x) * 4;
      const value = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? 255 : 0;
      for (let channel = 0; channel < 3; channel++) {
        left.data[offset + channel] = value;
        right.data[offset + channel] = x < 24 && y < 24 ? 255 - value : value;
      }
      left.data[offset + 3] = right.data[offset + 3] = 255;
    }
    const report = comparePreparedMedia(await image(PNG.sync.write(left)), await image(PNG.sync.write(right)));
    expect(report.candidates).toHaveLength(1);
    // Native FFmpeg versions can differ by one decoded 8-bit colour level.
    const distance = report.candidates[0].distance;
    expect(Math.abs(distance.meanAbsoluteRgbError - 0.0625)).toBeLessThanOrEqual(1 / 255);
    expect(distance.trimmedAbsoluteRgbError).toBe(0);
    expect(distance.edgeError).toBe(0);
    const opposing = distance.tiles.find(tile => tile.column === 0 && tile.row === 0);
    expect(opposing?.retained).toBe(false);
    expect(Math.abs((opposing?.rgbError ?? NaN) - 1)).toBeLessThanOrEqual(1 / 255 + Number.EPSILON);
    expect(Math.abs((opposing?.edgeError ?? NaN) - 2)).toBeLessThanOrEqual(2 / 255 + Number.EPSILON);
    expect(opposing?.edgeError).toBeGreaterThan(1);
    expect(report).not.toHaveProperty('verdict');
  });
  it('decodes real MP4/WebM, maps reordered sampled moments and compares image-to-video', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'contexttrail-matching-test-'));
    try {
      const originals = [syntheticPng(131), syntheticPng(992), syntheticPng(812)];
      for (const [index, bytes] of originals.entries()) await writeFile(join(directory, `left-${index}.png`), bytes);
      for (const [index, source] of [2, 0, 1].entries()) await writeFile(join(directory, `right-${index}.png`), transformPng(originals[source], { overlay: true }));
      for (const [prefix, extension, codec] of [['left', 'mp4', 'mpeg4'], ['right', 'webm', 'libvpx']]) {
        execFileSync('ffmpeg', ['-v', 'error', '-framerate', '1', '-i', join(directory, `${prefix}-%d.png`), '-an', '-threads', '1', '-c:v', codec, '-pix_fmt', 'yuv420p', '-r', '10', join(directory, `${prefix}.${extension}`)], { timeout: 10000 });
      }
      const left = await prepareMatchMedia({ kind: 'video', bytes: await readFile(join(directory, 'left.mp4')), rights: 'user_provided' });
      const right = await prepareMatchMedia({ kind: 'video', bytes: await readFile(join(directory, 'right.webm')), rights: 'user_provided' });
      const report = comparePreparedMedia(left, right);
      expect(report.comparedFramePairs).toBe(9);
      expect(report.candidates.map(pair => [pair.left.timestampMs, pair.right.timestampMs])).toEqual([[0, 1000], [1000, 2000], [2000, 0]]);
      expect(report.inputs.left.coverage).toMatchObject({ kind: 'sampled_video', requestedTimestampsMs: [0, 1000, 2000], decodedTimestampsMs: [0, 1000, 2000], largestUnsampledGapMs: 1000, temporalCoverageFraction: null, audioAnalyzed: false });
      const stillReport = comparePreparedMedia(await image(originals[1]), right);
      expect(stillReport.candidates.map(pair => pair.right.timestampMs)).toEqual([2000]);
      for (const frame of [...left.frames, ...right.frames]) expect(frame.contentHash).toBe(createHash('sha256').update(frame.bytes).digest('hex'));
      expect(report).not.toHaveProperty('verdict');
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 30000);
  it('composites transparent PNG/WebP pixels onto black before comparison', async () => {
    const hidden = PNG.sync.read(syntheticPng(777));
    for (let i = 3; i < hidden.data.length; i += 4) hidden.data[i] = 0;
    const hiddenBytes = PNG.sync.write(hidden);
    expect([...((await decodeMatchImage(hiddenBytes)).pixels)].every(value => value === 0)).toBe(true);
    const opaque = await image(syntheticPng(777));
    expect(comparePreparedMedia(opaque, await image(hiddenBytes)).candidates).toHaveLength(0);
    const half = new PNG({ width: 96, height: 96 });
    for (let i = 0; i < half.data.length; i += 4) { half.data[i] = 255; half.data[i + 3] = 128; }
    const decoded = await decodeMatchImage(PNG.sync.write(half));
    expect([...decoded.pixels.subarray(0, 3)]).toEqual([128, 0, 0]);
    // Fixed 96×96 fully transparent lossless WebP, generated with FFmpeg/libwebp.
    // Only decoding is a runtime requirement; do not require a local WebP encoder.
    const webpBytes = Buffer.from('UklGRiAAAABXRUJQVlA4TBQAAAAvX8AXEAcQEREGICH83y9F9D/1Aw==', 'base64');
    const webp = await decodeMatchImage(webpBytes);
    expect(webp.mimeType).toBe('image/webp');
    expect([...webp.pixels].every(value => value === 0)).toBe(true);
  });
  it('rejects animated image containers before decoder work and excessive decoded dimensions', async () => {
    const animatedWebp = Buffer.from('524946461000000057454250414e494d0400000000000000', 'hex');
    await expect(image(animatedWebp)).rejects.toMatchObject({ code: 'invalid_image' });
    const source = syntheticPng(99), animationChunk = Buffer.alloc(20);
    animationChunk.writeUInt32BE(8); animationChunk.write('acTL', 4);
    await expect(image(Buffer.concat([source.subarray(0, 33), animationChunk, source.subarray(33)]))).rejects.toMatchObject({ code: 'invalid_image' });
    const huge = new PNG({ width: 4000, height: 2200 });
    await expect(image(PNG.sync.write(huge))).rejects.toMatchObject({ code: 'limit_exceeded' });
  });
  it('snapshots caller bytes before decoding and reports missing executables without diagnostics', async () => {
    const bytes = syntheticPng(891), expected = createHash('sha256').update(bytes).digest('hex');
    const pending = image(bytes); bytes.fill(0);
    expect((await pending).contentHash).toBe(expected);
    const path = process.env.PATH;
    try { process.env.PATH = ''; await expect(image(syntheticPng(345))).rejects.toMatchObject({ code: 'decoder_unavailable' }); }
    finally { process.env.PATH = path; }
  });
});
