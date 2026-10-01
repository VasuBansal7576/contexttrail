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
  it('snapshots caller bytes before decoding and reports missing executables without diagnostics', async () => {
    const bytes = syntheticPng(891), expected = createHash('sha256').update(bytes).digest('hex');
    const pending = image(bytes); bytes.fill(0);
    expect((await pending).contentHash).toBe(expected);
    const path = process.env.PATH;
    try { process.env.PATH = ''; await expect(image(syntheticPng(345))).rejects.toMatchObject({ code: 'decoder_unavailable' }); }
    finally { process.env.PATH = path; }
  });
});
