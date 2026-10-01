#!/usr/bin/env node
/** Real localhost production HTTP + native decoder checks. Owned synthetic media, no providers. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const checkout = fileURLToPath(new URL('..', import.meta.url));
const artifacts = resolve(checkout, '.verify', `media-http-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const data = resolve(artifacts, 'research-data'), staging = resolve(artifacts, 'decoder-tmp');
await mkdir(data, { recursive: true }); await mkdir(staging);
const sourceFiles = ['src/app/api/media/compare/route.ts', 'src/lib/research/local-boundary.ts', 'src/lib/video/matching/application.ts', 'src/lib/video/matching/application-contract.ts', 'src/lib/video/matching/prepare.ts', 'src/lib/video/matching/decode.ts', 'src/lib/video/matching/compare.ts', 'src/lib/video/ingest.ts', 'scripts/verify-media-http.mjs', 'package-lock.json'];
const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async path => [path, createHash('sha256').update(await readFile(resolve(checkout, path))).digest('hex')])));
const assertions = [], hash = bytes => createHash('sha256').update(bytes).digest('hex');
const check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); assertions.push({ name, passed: true }); };
let server, base, output = '', completed = false;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition, label, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await condition()) return; await pause(20); }
  throw new Error(`${label} timed out`);
}
async function launch(enabled) {
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address(); assert(address && typeof address !== 'string');
  await new Promise(resolve => probe.close(resolve)); base = `http://127.0.0.1:${address.port}`;
  server = spawn(process.execPath, [resolve(checkout, 'node_modules/next/dist/bin/next'), 'start', '-H', '127.0.0.1', '-p', String(address.port)], {
    cwd: checkout,
    env: { PATH: process.env.PATH, TMPDIR: staging, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', CONTEXTTRAIL_RESEARCH_LOCAL: '1', CONTEXTTRAIL_MEDIA_LOCAL: enabled ? '1' : '0', CONTEXTTRAIL_RESEARCH_DATA_DIR: data },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', chunk => { output += chunk; }); server.stderr.on('data', chunk => { output += chunk; });
  await until(async () => { if (server.exitCode !== null) throw new Error(`Server exited ${server.exitCode}`); try { return (await fetch(`${base}/api/media/compare`)).status === (enabled ? 200 : 503); } catch { return false; } }, 'server startup');
}
async function stop() {
  const owned = server; if (!owned || owned.exitCode !== null) return;
  const exited = new Promise(resolve => owned.once('exit', resolve)); owned.kill('SIGTERM');
  const timer = setTimeout(() => owned.kill('SIGKILL'), 5000); await exited; clearTimeout(timer); server = undefined;
}
function synthetic(seed) {
  const png = new PNG({ width: 320, height: 240 });
  let state = seed;
  const cells = Array.from({ length: 16 * 12 }, () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return [state & 255, state >>> 8 & 255, state >>> 16 & 255]; });
  for (let y = 0; y < 240; y++) for (let x = 0; x < 320; x++) {
    const i = (y * 320 + x) * 4, color = cells[Math.floor(y / 20) * 16 + Math.floor(x / 20)];
    for (let c = 0; c < 3; c++) png.data[i + c] = color[c]; png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}
async function fixture(prefix, seed, extension = 'mp4') {
  const still = synthetic(seed); await writeFile(resolve(artifacts, `${prefix}.png`), still);
  execFileSync('ffmpeg', ['-v', 'error', '-loop', '1', '-i', resolve(artifacts, `${prefix}.png`), '-t', '3', '-an', '-threads', '1', '-c:v', extension === 'mp4' ? 'mpeg4' : 'libvpx', '-pix_fmt', 'yuv420p', '-r', '10', resolve(artifacts, `${prefix}.${extension}`)], { timeout: 10000 });
  return { still, video: await readFile(resolve(artifacts, `${prefix}.${extension}`)) };
}
function form(left, right, leftKind = 'image', rightExtension = 'mp4') {
  const body = new FormData();
  body.set('left', new Blob([left], { type: leftKind === 'image' ? 'image/png' : 'video/mp4' }), `left.${leftKind === 'image' ? 'png' : 'mp4'}`);
  body.set('right', new Blob([right], { type: `video/${rightExtension}` }), `right.${rightExtension}`);
  body.set('leftKind', leftKind); body.set('rightKind', 'video'); body.set('rights', 'user_provided'); return body;
}
async function post(body, status = 200, headers = {}) {
  const response = await fetch(`${base}/api/media/compare`, { method: 'POST', body, headers });
  const result = await response.json(); assert.equal(response.status, status, JSON.stringify(result));
  assert.equal(response.headers.get('cache-control'), 'no-store'); return result;
}
const capabilities = async () => (await fetch(`${base}/api/media/compare`)).json();
function raw(headers, body) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${base}/api/media/compare`, { method: 'POST', headers: { ...headers, connection: 'close' }, agent: false }, response => {
      const chunks = []; response.on('data', data => chunks.push(data)); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    }); request.on('error', reject); request.end(body);
  });
}
try {
  const a = await fixture('owned-a', 182), b = await fixture('owned-b', 9913, 'webm');
  await launch(false);
  check('decoder requires separate opt-in', (await post(form(a.still, a.video), 503)).code, 'LOCAL_MEDIA_DISABLED');
  await stop(); await launch(true);
  const limits = (await capabilities()).limits;
  check('candidate-only capability is local and does not persist', (await capabilities()).persistence, 'not_saved');
  const research = await fetch(`${base}/api/research`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'start', operationId: 'media-http-case', question: 'Compare these supplied files', createdAt: '2026-10-01T00:00:00Z' }) });
  assert.equal(research.status, 200); const originalCase = await research.json();
  const first = await post(form(a.still, a.video));
  check('still/video computes all three sample pairs', first.report.comparedFramePairs, 3);
  check('actual media produces timestamped candidate pairs', first.report.candidates.map(pair => pair.right.timestampMs), [0, 1000, 2000]);
  check('relative timestamps never become publication dates', first.report.inputs.right.coverage.decodedTimestampsMs, [0, 1000, 2000]);
  check('point samples do not claim interval coverage', first.report.inputs.right.coverage.temporalCoverageFraction, null);
  check('still timestamp remains absent', first.frames.left[0].timestampMs, null);
  for (const [index, frame] of [...first.frames.left, ...first.frames.right].entries()) check(`returned frame ${index} hash matches its actual bytes`, hash(Buffer.from(frame.base64, 'base64')), frame.contentHash);
  check('supplied file hashes bind actual uploaded bytes', [first.report.inputs.left.contentHash, first.report.inputs.right.contentHash], [hash(a.still), hash(a.video)]);
  check('explicit comparison-not-saved response', first.persistence.status, 'not_saved');
  check('candidate report has no truth or identity verdict', Object.hasOwn(first.report, 'verdict'), false);
  check('response stays inside advertised byte bound', Buffer.byteLength(JSON.stringify(first)) < limits.responseBytes, true);
  await writeFile(resolve(artifacts, 'still-video-response.json'), JSON.stringify(first, null, 2));
  check('identical retry is deterministic', await post(form(a.still, a.video)), first);
  const pair = await post(form(a.video, a.video, 'video'));
  check('video/video compares nine sample pairs', pair.report.comparedFramePairs, 9);
  const unrelated = await post(form(a.video, b.video, 'video', 'webm'));
  check('independent second input is isolated by its supplied hash', unrelated.report.inputs.right.contentHash, hash(b.video));
  check('unrelated owned scenes produce no candidate in this fixture', unrelated.report.candidates.length, 0);
  check('no previous right-side frame payload leaks into next request', unrelated.frames.right.some(frame => first.frames.right.some(old => old.contentHash === frame.contentHash)), false);
  check('cross-origin rejection', (await post(form(a.still, a.video), 403, { origin: 'https://untrusted.example' })).code, 'ORIGIN_REJECTED');
  check('cross-site rejection', (await post(form(a.still, a.video), 403, { 'sec-fetch-site': 'cross-site' })).code, 'ORIGIN_REJECTED');
  check('foreign Host rejected', (await raw({ host: 'untrusted.example', 'content-type': 'multipart/form-data; boundary=x' }, 'x')).status, 403);
  check('malformed multipart rejected', (await post('broken', 400, { 'content-type': 'multipart/form-data; boundary=x' })).code, 'INVALID_INPUT');
  const path = form(a.still, a.video); path.set('path', '/tmp/do-not-read'); check('path input rejected without any file read', (await post(path, 400)).code, 'INVALID_INPUT');
  const remote = form(a.still, a.video); remote.set('right', 'https://not-requested.example/clip.mp4'); check('URL input rejected without fetching', (await post(remote, 400)).code, 'INVALID_INPUT');
  check('wrong signature rejected before decoding', (await post(form(Buffer.from('not a PNG'), a.video), 415)).code, 'SIGNATURE_MISMATCH');
  const malformedVideo = Buffer.alloc(20); malformedVideo.write('ftyp', 4);
  check('native decoder rejects malformed container after signature check', (await post(form(a.still, malformedVideo), 422)).code, 'INVALID_MEDIA');
  check('oversized still rejected', (await post(form(new Uint8Array(limits.imageBytes + 1), a.video), 413)).code, 'MEDIA_TOO_LARGE');
  check('oversized declared HTTP body rejected', (await raw({ 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(limits.requestBytes + 1) }, 'x')).status, 413);
  // Keep a real chunked HTTP upload open to inspect admission and disconnect cleanup.
  const stalled = httpRequest(`${base}/api/media/compare`, { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x' } });
  stalled.on('error', error => { output += `\nStalled request error: ${error.code}`; }); stalled.on('response', response => { output += `\nStalled request response: ${response.statusCode}`; response.on('data', chunk => { output += chunk; }); }); stalled.write('--x\r\n'); stalled.flushHeaders();
  await until(async () => (await capabilities()).busy, 'stalled-upload admission');
  check('second request cannot bypass one-job admission', (await post(form(a.still, a.video), 429)).code, 'COMPARISON_BUSY');
  stalled.destroy(); await until(async () => !(await capabilities()).busy, 'disconnect cleanup');
  check('cancelled upload releases its slot', (await capabilities()).busy, false);
  // Abort during real native video extraction. Its scratch directory must be removed before retry.
  const controller = new AbortController();
  const running = fetch(`${base}/api/media/compare`, { method: 'POST', body: form(a.video, b.video, 'video', 'webm'), signal: controller.signal }).catch(error => error);
  await until(async () => (await readdir(staging)).some(name => name.startsWith('contexttrail-video-')), 'native decode staging');
  controller.abort(); const cancelled = await running;
  check('caller observes cancellation during real native decoding', cancelled.name, 'AbortError');
  await until(async () => !(await capabilities()).busy, 'decoder cancellation cleanup');
  check('native decode temporary files cleaned after cancellation', await readdir(staging), []);
  check('retry after cancelled decoding produces a fresh result', await post(form(a.still, a.video)), first);
  check('successful and rejected comparisons retain no decoder scratch files', await readdir(staging), []);
  const reopened = await (await fetch(`${base}/api/research?caseId=${encodeURIComponent(originalCase.document.workspace.inquiry.caseId)}`)).json();
  check('comparison never alters the saved case', reopened, originalCase);
  check('only the pre-existing saved case remains in research storage', (await readdir(data)).length, 1);
  await stop(); await launch(true);
  check('restart retains no comparison session or busy job', (await capabilities()).busy, false);
  check('restart leaves prior research case intact', await (await fetch(`${base}/api/research?caseId=${encodeURIComponent(originalCase.document.workspace.inquiry.caseId)}`)).json(), originalCase);
  completed = true;
} finally {
  await stop();
  await writeFile(resolve(artifacts, 'server.log'), output);
  await writeFile(resolve(artifacts, 'verification.json'), JSON.stringify({ completed, tier: 'real-local-http-native-decoder', noProviderCredentialsPassed: true, sourceHashes, assertions }, null, 2));
  process.stdout.write(`${JSON.stringify({ completed, assertions: assertions.length, artifacts })}\n`);
}
