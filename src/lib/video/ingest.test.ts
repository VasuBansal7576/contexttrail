import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseVideoMetadata, prepareVideo, sampleTimes, VIDEO_LIMITS } from './ingest';
import { imageInputForFrame } from './image-input';

const metadata = (duration = '3', width = 320, height = 240) => ({ format: { duration }, streams: [{ codec_type: 'video', index: 0, width, height }] });

describe('video input boundary', () => {
  it('rejects empty and oversize uploads before decoder work', async () => {
    await expect(prepareVideo(new Uint8Array())).rejects.toMatchObject({ code: 'invalid_video' });
    await expect(prepareVideo(new Uint8Array(VIDEO_LIMITS.bytes + 1))).rejects.toMatchObject({ code: 'limit_exceeded' });
  });
  it('rejects missing, nonfinite, negative, long, and huge metadata', () => {
    for (const raw of [null, {}, { streams: [], format: {} }, metadata('NaN'), metadata('-1'), metadata('0'), metadata('Infinity'), metadata('3', 0), metadata('3', 2.5)]) {
      expect(() => parseVideoMetadata(raw)).toThrow('invalid_video');
    }
    for (const raw of [metadata('121'), metadata('3', 10000, 10000)]) expect(() => parseVideoMetadata(raw)).toThrow('limit_exceeded');
    expect(parseVideoMetadata(metadata())).toEqual({ durationMs: 3000, streamIndex: 0 });
  });
  it('uses deterministic bounded samples', () => {
    expect(sampleTimes(3000)).toEqual([0, 1000, 2000]);
    expect(sampleTimes(120000)).toEqual([0, 40000, 80000]);
    for (const duration of [0, NaN, Infinity, -1, 120001]) expect(() => sampleTimes(duration)).toThrow();
  });
  it('reports missing binaries without leaking subprocess diagnostics', async () => {
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = '';
      await expect(prepareVideo(Buffer.from('invalid'))).rejects.toMatchObject({ code: 'decoder_unavailable', message: 'decoder_unavailable' });
    } finally { process.env.PATH = originalPath; }
  });
  it('honors cancellation before creating temporary files', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(prepareVideo(new Uint8Array([1]), { signal: controller.signal })).rejects.toThrow();
  });
});

const binariesAvailable = (() => {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
})();
// Optional on hosts without FFmpeg; VIDEO_REQUIRE_FFMPEG=1 makes missing binaries a failure.
it('requires FFmpeg when integration verification is requested', () => {
  if (process.env.VIDEO_REQUIRE_FFMPEG === '1') expect(binariesAvailable).toBe(true);
});

describe.skipIf(!binariesAvailable)('real local FFmpeg integration (no providers)', () => {
  it('extracts timestamped JPEG frames from MP4 and WebM and preserves parent identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'contexttrail-synthetic-'));
    try {
      for (const extension of ['mp4', 'webm']) {
        const path = join(directory, `synthetic.${extension}`);
        execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10:duration=3', '-an', '-threads', '1', '-c:v', extension === 'mp4' ? 'mpeg4' : 'libvpx', path], { timeout: 10000 });
        const bytes = await readFile(path);
        const prepared = await prepareVideo(bytes);
        expect(prepared.coverage).toBe('sampled_frames_only');
        expect(prepared.frames.map(f => f.timestampMs)).toEqual([0, 1000, 2000]);
        expect(prepared.durationMs).toBe(3000);
        expect(prepared.mediaId).toBe(`video:sha256:${prepared.contentHash}`);
        expect(new Set(prepared.frames.map(f => f.contentHash)).size).toBe(3);
        for (const frame of prepared.frames) {
          expect(frame.mediaId).toBe(prepared.mediaId);
          expect(frame.bytes.byteLength).toBeLessThanOrEqual(VIDEO_LIMITS.frameBytes);
          const adapted = imageInputForFrame(frame, { claim: null, timezone: 'UTC', locale: 'en' });
          expect(adapted.input.media).toBe(frame.bytes);
          expect(adapted.input).not.toHaveProperty('publicImageUrl');
          expect(adapted.input).not.toHaveProperty('publicImageId');
          expect(adapted.source.timestampMs).toBe(frame.timestampMs);
        }
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 30000);
  it('rejects malformed media and playlists and cleans staging directories on failure', async () => {
    const before = (await readdir(tmpdir())).filter(name => name.startsWith('contexttrail-video-')).sort();
    for (const content of ['not video', '#EXTM3U\n#EXTINF:2,\nhttp://127.0.0.1/private\n']) {
      await expect(prepareVideo(Buffer.from(content))).rejects.toMatchObject({ code: 'decode_failed' });
    }
    const after = (await readdir(tmpdir())).filter(name => name.startsWith('contexttrail-video-')).sort();
    expect(after).toEqual(before);
  });
});
