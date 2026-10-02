import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { comparePreparedMedia } from '@/lib/video/matching/compare';
import { comparePreparedMediaAsync } from '@/lib/video/matching/schedule';
import { prepareMatchMedia } from '@/lib/video/matching/prepare';
import { syntheticPng } from '@/lib/video/matching/fixtures';
import { LOCAL_COMPARISON_LIMITS } from '@/lib/video/matching/application';
import { GET, POST } from './route';

const endpoint = 'http://127.0.0.1:3119/api/media/compare';
const available = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'contexttrail-media-route-test-'));
  vi.stubEnv('CONTEXTTRAIL_RESEARCH_LOCAL', '1');
  vi.stubEnv('CONTEXTTRAIL_MEDIA_LOCAL', '1');
  vi.stubEnv('CONTEXTTRAIL_RESEARCH_DATA_DIR', directory);
});
afterEach(async () => { vi.unstubAllEnvs(); vi.useRealTimers(); await rm(directory, { recursive: true, force: true }); });
function form(left: Uint8Array = new Uint8Array([0]), right: Uint8Array = new Uint8Array([0])) {
  const body = new FormData();
  body.set('left', new Blob([new Uint8Array(left)], { type: 'image/png' }), 'left.png');
  body.set('right', new Blob([new Uint8Array(right)], { type: 'video/mp4' }), 'right.mp4');
  body.set('leftKind', 'image'); body.set('rightKind', 'video'); body.set('rights', 'user_provided');
  return body;
}
function request(body: FormData, init: RequestInit = {}) { return new Request(endpoint, { method: 'POST', body, ...init }); }
function streamRequest(body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  const init: RequestInit & { duplex: 'half' } = { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x' }, body, signal, duplex: 'half' };
  return new Request(endpoint, init);
}
async function expectCode(response: Response, status: number, code: string) {
  expect(response.status).toBe(status); expect(response.headers.get('cache-control')).toBe('no-store'); expect((await response.json()).code).toBe(code);
}
it('requires installed FFmpeg when requested', () => { if (process.env.VIDEO_REQUIRE_FFMPEG === '1') expect(available).toBe(true); });
it('shares loopback/origin isolation, is separately opted in and refuses hosted markers', async () => {
  await expectCode(await POST(request(form(), { headers: { host: 'foreign.example' } })), 403, 'LOCAL_ONLY');
  await expectCode(await POST(request(form(), { headers: { origin: 'https://foreign.example' } })), 403, 'ORIGIN_REJECTED');
  await expectCode(await POST(request(form(), { headers: { 'sec-fetch-site': 'cross-site' } })), 403, 'ORIGIN_REJECTED');
  await expectCode(await GET(new Request('http://foreign.example/api/media/compare')), 403, 'LOCAL_ONLY');
  vi.stubEnv('CONTEXTTRAIL_RESEARCH_LOCAL', '0');
  await expectCode(await POST(request(form())), 503, 'LOCAL_SERVICE_DISABLED');
  vi.stubEnv('CONTEXTTRAIL_RESEARCH_LOCAL', '1'); vi.stubEnv('CONTEXTTRAIL_MEDIA_LOCAL', '0');
  await expectCode(await POST(request(form())), 503, 'LOCAL_MEDIA_DISABLED');
  vi.stubEnv('CONTEXTTRAIL_MEDIA_LOCAL', '1'); vi.stubEnv('VERCEL', '1');
  await expectCode(await POST(request(form())), 503, 'LOCAL_MEDIA_ONLY');
  expect(await readdir(directory)).toEqual([]);
});
it('rejects malformed multipart, paths, URLs, extra/duplicate fields, missing rights and mismatched bytes', async () => {
  await expectCode(await POST(new Request(endpoint, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })), 415, 'CONTENT_TYPE');
  await expectCode(await POST(new Request(endpoint, { method: 'POST', body: 'bad', headers: { 'content-type': 'multipart/form-data; boundary=x' } })), 400, 'INVALID_INPUT');
  const rights = form(); rights.delete('rights'); await expectCode(await POST(request(rights)), 400, 'INVALID_INPUT');
  rights.set('rights', 'public'); await expectCode(await POST(request(rights)), 400, 'RIGHTS_REQUIRED');
  const extra = form(); extra.set('path', '/tmp/no-read'); await expectCode(await POST(request(extra)), 400, 'INVALID_INPUT');
  const url = form(); url.set('right', 'https://no-fetch.example/video.mp4'); await expectCode(await POST(request(url)), 400, 'INVALID_INPUT');
  const duplicate = form(); duplicate.append('rights', 'user_provided'); await expectCode(await POST(request(duplicate)), 400, 'INVALID_INPUT');
  const wrongType = form(); wrongType.set('left', new Blob([new Uint8Array(syntheticPng(2))], { type: 'text/html' }), 'left.png'); await expectCode(await POST(request(wrongType)), 415, 'UNSUPPORTED_MEDIA');
  const bothImages = form(); bothImages.set('rightKind', 'image'); bothImages.set('right', new Blob([new Uint8Array(syntheticPng(2))], { type: 'image/png' }), 'right.png'); await expectCode(await POST(request(bothImages)), 400, 'VIDEO_REQUIRED');
  await expectCode(await POST(request(form())), 415, 'SIGNATURE_MISMATCH');
  expect(await readdir(directory)).toEqual([]);
});
it('enforces advertised and streamed byte caps before decoding', async () => {
  await expectCode(await POST(request(form(), { headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(LOCAL_COMPARISON_LIMITS.requestBytes + 1) } })), 413, 'REQUEST_TOO_LARGE');
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(LOCAL_COMPARISON_LIMITS.requestBytes + 1)); controller.close(); } });
  const streamed = streamRequest(body);
  await expectCode(await POST(streamed), 413, 'REQUEST_TOO_LARGE');
  const big = form(new Uint8Array(LOCAL_COMPARISON_LIMITS.imageBytes + 1)); await expectCode(await POST(request(big)), 413, 'MEDIA_TOO_LARGE');
  expect(await readdir(directory)).toEqual([]);
});
it('admits one upload, cancels stalled intake, then permits retry without shared results', async () => {
  const controller = new AbortController();
  const body = new ReadableStream<Uint8Array>({ start(stream) { stream.enqueue(new Uint8Array([1])); } });
  const stalled = streamRequest(body, controller.signal);
  const pending = POST(stalled);
  expect((await (await GET(new Request(endpoint))).json()).busy).toBe(true);
  await expectCode(await POST(request(form())), 429, 'COMPARISON_BUSY');
  controller.abort(); await expectCode(await pending, 499, 'CANCELLED');
  expect((await (await GET(new Request(endpoint))).json()).busy).toBe(false);
  await expectCode(await POST(request(form())), 415, 'SIGNATURE_MISMATCH');
  expect(await readdir(directory)).toEqual([]);
});
it('times out stalled upload and releases admission', async () => {
  vi.useFakeTimers();
  const body = new ReadableStream<Uint8Array>();
  const pending = POST(streamRequest(body));
  await vi.advanceTimersByTimeAsync(LOCAL_COMPARISON_LIMITS.uploadMs);
  await expectCode(await pending, 408, 'DEADLINE_EXCEEDED');
  expect((await (await GET(new Request(endpoint))).json()).busy).toBe(false);
});
describe.skipIf(!available)('real decoder route and frozen matcher', () => {
  it('returns actual still/video frames, timestamps and candidate-only report; retry is deterministic', async () => {
    const still = syntheticPng(811);
    await writeFile(join(directory, 'frame.png'), still);
    execFileSync('ffmpeg', ['-v', 'error', '-loop', '1', '-i', join(directory, 'frame.png'), '-t', '3', '-an', '-threads', '1', '-c:v', 'mpeg4', '-pix_fmt', 'yuv420p', '-r', '10', join(directory, 'video.mp4')], { timeout: 10000 });
    const video = await readFile(join(directory, 'video.mp4'));
    const first = await POST(request(form(still, video)));
    expect(first.status).toBe(200);
    const result = await first.json();
    expect(result.report.comparedFramePairs).toBe(3);
    expect(result.report.candidates.length).toBeGreaterThan(0);
    expect(result.report.inputs.right.coverage.decodedTimestampsMs).toEqual([0, 1000, 2000]);
    expect(result.report.inputs.right.coverage.temporalCoverageFraction).toBeNull();
    expect(result.frames.left[0].timestampMs).toBeNull();
    for (const frame of [...result.frames.left, ...result.frames.right]) expect(createHash('sha256').update(Buffer.from(frame.base64, 'base64')).digest('hex')).toBe(frame.contentHash);
    expect(result.persistence.status).toBe('not_saved');
    expect(result.report).not.toHaveProperty('verdict');
    expect(result).not.toHaveProperty('document');
    expect(await (await POST(request(form(still, video)))).json()).toEqual(result);
    expect((await readdir(directory)).sort()).toEqual(['frame.png', 'video.mp4']);
  }, 30000);
  it('async adapter preserves the exact frozen algorithm report and responds to cancellation', async () => {
    const left = await prepareMatchMedia({ kind: 'image', bytes: syntheticPng(182), rights: 'user_provided' });
    const right = await prepareMatchMedia({ kind: 'image', bytes: syntheticPng(666), rights: 'user_provided' });
    const controller = new AbortController();
    expect(await comparePreparedMediaAsync(left, right, controller.signal)).toEqual(comparePreparedMedia(left, right));
    controller.abort();
    await expect(comparePreparedMediaAsync(left, right, controller.signal)).rejects.toMatchObject({ code: 'cancelled' });
  }, 30000);
});
