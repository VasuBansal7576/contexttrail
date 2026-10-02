import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAutomaticForm } from './automatic-input';
import { prepareVideo, VIDEO_LIMITS } from '../video/ingest';
import { parseComparisonForm } from '../video/matching/application';
const binariesAvailable = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
afterEach(() => vi.unstubAllEnvs());
function form(bytes: Uint8Array, mime = 'video/quicktime', name = 'synthetic.mov') {
  const value = new FormData(); value.set('kind', 'video'); value.set('rights', 'user_provided'); value.set('video', new Blob([new Uint8Array(bytes)], { type: mime }), name); return value;
}
it('requires FFmpeg when generated MOV verification is requested', () => { if (process.env.VIDEO_REQUIRE_FFMPEG === '1') expect(binariesAvailable).toBe(true); });
describe.skipIf(!binariesAvailable)('real generated MOV input (no providers)', () => {
  it('accepts generated ftyp, free-first, extended-size and true legacy mdat-first MOV files through both upload paths', async () => {
    vi.stubEnv('CONTEXTTRAIL_MEDIA_LOCAL', '1');
    const directory = await mkdtemp(join(tmpdir(), 'ct-issue24-'));
    try {
      const path = join(directory, 'synthetic.mov');
      execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10:duration=1', '-an', '-threads', '1', '-c:v', 'mpeg4', '-f', 'mov', path], { timeout: 10_000 });
      const normal = await readFile(path); expect(normal.toString('ascii', 4, 8)).toBe('ftyp');
      const freeFirst = Buffer.from(normal); freeFirst.write('free', 4, 4, 'ascii');
      const extended = Buffer.from(freeFirst), firstSize = extended.readUInt32BE(0);
      expect(firstSize).toBeGreaterThanOrEqual(16);
      extended.writeUInt32BE(1); extended.writeBigUInt64BE(BigInt(firstSize), 8);
      // Remove only leading declarations/padding, then repair the generated
      // file's chunk offsets. Media bytes stay intact; this is a real old-style
      // MOV beginning with mdat and containing no ftyp anywhere.
      let prefix = 0;
      while (['ftyp', 'wide', 'free'].includes(normal.toString('ascii', prefix + 4, prefix + 8))) prefix += normal.readUInt32BE(prefix);
      expect(normal.toString('ascii', prefix + 4, prefix + 8)).toBe('mdat');
      const legacy = Buffer.from(normal.subarray(prefix)), movieOffset = legacy.readUInt32BE(0), offsets = legacy.indexOf('stco', movieOffset);
      expect(offsets).toBeGreaterThan(movieOffset);
      const entries = legacy.readUInt32BE(offsets + 8);
      for (let index = 0; index < entries; index++) { const position = offsets + 12 + index * 4; legacy.writeUInt32BE(legacy.readUInt32BE(position) - prefix, position); }
      const terminalMovie = Buffer.from(normal); let offset = 0;
      while (offset < terminalMovie.length) { const size = terminalMovie.readUInt32BE(offset); if (terminalMovie.toString('ascii', offset + 4, offset + 8) === 'moov') { expect(offset + size).toBe(terminalMovie.length); terminalMovie.writeUInt32BE(0, offset); break; } offset += size; }
      const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAYAAAD+Bd/7AAAALElEQVR4AX3BQQ2AABADsJJMwt57498gOLj24f2KoiiKoog5xZxiTjGnmNMPhN8CX95XlDwAAAAASUVORK5CYII=', 'base64');
      for (const bytes of [normal, freeFirst, extended, legacy, terminalMovie]) {
        const decoded = await prepareVideo(bytes);
        expect(decoded.durationMs).toBe(1000); expect(decoded.frames).toHaveLength(3);
        const accepted = await parseAutomaticForm(form(bytes));
        expect(accepted).toMatchObject({ kind: 'video', rights: 'user_provided' });
        if (accepted.kind !== 'video') throw new Error('Expected video');
        expect(accepted.bytes).toEqual(new Uint8Array(bytes));
        const comparison = new FormData(); comparison.set('rights', 'user_provided'); comparison.set('leftKind', 'image'); comparison.set('rightKind', 'video'); comparison.set('left', new Blob([image], { type: 'image/png' }), 'synthetic.png'); comparison.set('right', new Blob([bytes], { type: 'video/quicktime' }), 'synthetic.mov');
        expect((await parseComparisonForm(comparison, new AbortController().signal)).right.bytes).toEqual(bytes);
      }
      const external = Buffer.from(normal), dref = external.indexOf('dref', normal.indexOf('moov'));
      expect(dref).toBeGreaterThan(0); expect(external.toString('ascii', dref + 16, dref + 20)).toBe('url '); expect(external.readUInt32BE(dref + 20)).toBe(1);
      external.writeUInt32BE(0, dref + 20);
      await expect(parseAutomaticForm(form(external))).rejects.toMatchObject({ status: 415, code: 'INVALID_VIDEO' });
      for (const bytes of [normal.subarray(0, normal.length - 1), normal.subarray(0, 12)]) await expect(parseAutomaticForm(form(bytes))).rejects.toMatchObject({ status: 415 });
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 30_000);
});
it('preserves rights, local opt-in and byte caps, and rejects empty/unsupported/remote inputs', async () => {
  vi.stubEnv('CONTEXTTRAIL_MEDIA_LOCAL', '1');
  for (const bytes of [new Uint8Array(), new Uint8Array(VIDEO_LIMITS.bytes + 1)]) await expect(parseAutomaticForm(form(bytes))).rejects.toMatchObject({ status: 413, code: 'INVALID_VIDEO' });
  for (const text of ['#EXTM3U\nhttps://example.com/private\n', 'RIFF AVI ', 'not a video']) await expect(parseAutomaticForm(form(Buffer.from(text)))).rejects.toMatchObject({ status: 415 });
  const remote = form(Buffer.from('invalid')); remote.set('video', 'https://example.com/private.mov'); await expect(parseAutomaticForm(remote)).rejects.toMatchObject({ status: 413 });
  const denied = form(Buffer.from('invalid')); denied.set('rights', 'no'); await expect(parseAutomaticForm(denied)).rejects.toMatchObject({ code: 'RIGHTS_REQUIRED' });
  vi.stubEnv('CONTEXTTRAIL_MEDIA_LOCAL', '0'); await expect(parseAutomaticForm(form(Buffer.from('invalid')))).rejects.toMatchObject({ code: 'LOCAL_MEDIA_DISABLED' });
});
