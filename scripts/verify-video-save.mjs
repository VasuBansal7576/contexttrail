/** Built UI + real HTTP/disk. Synthetic completed report; providers have no environment. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const checkout = fileURLToPath(new URL('..', import.meta.url));
const artifacts = resolve(checkout, '.verify/video-save');
await mkdir(artifacts, { recursive: true });
const compiled = spawnSync(process.execPath, [resolve(checkout, 'node_modules/typescript/bin/tsc'), '--module', 'commonjs', '--target', 'ES2020', '--outDir', resolve(artifacts, 'fixture'), 'src/lib/research/video-save-fixture.ts'], { cwd: checkout, encoding: 'utf8' });
assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
const fixture = createRequire(import.meta.url)(resolve(artifacts, 'fixture/research/video-save-fixture.js')).videoSaveFixture();
const probe = createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
const address = probe.address(); assert(address && typeof address === 'object');
await new Promise(r => probe.close(r)); const base = `http://127.0.0.1:${address.port}`;
const server = spawn(process.execPath, [resolve(checkout, 'node_modules/next/dist/bin/next'), 'start', '-H', '127.0.0.1', '-p', String(address.port)], { cwd: checkout, env: { PATH: process.env.PATH, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', CONTEXTTRAIL_RESEARCH_LOCAL: '1', CONTEXTTRAIL_RESEARCH_DATA_DIR: resolve(artifacts, 'data') }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOutput = ''; server.stdout.on('data', v => serverOutput += v); server.stderr.on('data', v => serverOutput += v);
let browser;
try {
  for (let attempt = 0; attempt < 100; attempt++) { try { if ((await fetch(`${base}/api/research`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  let investigations = 0, lost = false; const saveInputs = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== base) return route.abort();
    if (url.pathname === '/api/research/investigate') {
      investigations++; return route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'research.completed', result: fixture }) + '\n' });
    }
    if (url.pathname === '/api/research' && request.method() === 'POST') {
      saveInputs.push(request.postDataJSON());
      if (!lost) { lost = true; const committed = await route.fetch(); assert.equal(committed.status(), 200); return route.abort('failed'); }
    }
    return route.continue();
  });
  await page.goto(`${base}/video`);
  await page.locator('input[type=file]').setInputFiles({ name: 'synthetic.webm', mimeType: 'video/webm', buffer: Buffer.from('Offline fixture. Not decoded or uploaded.') });
  await page.locator('input[type=checkbox]').check();
  await page.getByRole('button', { name: 'Investigate video', exact: true }).click();
  await page.getByRole('button', { name: 'Save video report', exact: true }).click();
  await page.getByRole('alert').waitFor();
  await page.getByRole('button', { name: 'Save video report', exact: true }).click();
  await page.getByRole('link', { name: 'Open saved case', exact: true }).click();
  const report = page.getByRole('region', { name: 'Saved video report', exact: true });
  await report.waitFor(); assert.match(await report.innerText(), /Insufficient evidence/);
  assert.deepEqual(saveInputs[0], saveInputs[1]); assert.equal(investigations, 1);
  await page.reload(); await report.waitFor(); assert.equal(investigations, 1);
  await page.screenshot({ path: resolve(artifacts, 'reopened-desktop.png'), fullPage: true });
  const original = await (await fetch(`${base}/api/research?caseId=${encodeURIComponent(fixture.caseRecord.id)}`)).json();
  assert.deepEqual(original.document.videoReport.result, fixture);
  const conflict = await fetch(`${base}/api/research`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...saveInputs[0], videoReport: { ...saveInputs[0].videoReport, result: { ...fixture, limitations: ['Changed report'] } } }) }); assert.equal(conflict.status, 409);
  const correction = await fetch(`${base}/api/research`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'update', caseId: fixture.caseRecord.id, operationId: 'offline-source-correction', expectedRevision: 1, change: { kind: 'evidence', value: { ...fixture.caseRecord.evidence[0], title: 'Corrected current source' }, assets: [] } }) }); assert.equal(correction.status, 200);
  const corrected = await correction.json(); assert.equal(corrected.videoReportStatus, 'stale'); assert.deepEqual(corrected.document.videoReport.result, fixture);
  await page.reload(); await report.waitFor(); assert.match(await report.innerText(), /Needs review/); assert.equal(await report.locator('details').first().getAttribute('open'), null);
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: resolve(artifacts, 'corrected-mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  assert.deepEqual(errors, []);
  const evidence = { passed: true, fixture: 'synthetic only', investigations, saves: saveInputs.length, responseLossRetry: true, reload: true, changedInputConflict: conflict.status, sourceCorrectionStatus: corrected.videoReportStatus, browserErrors: errors };
  await writeFile(resolve(artifacts, 'evidence.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence));
} finally { await browser?.close(); server.kill('SIGTERM'); await writeFile(resolve(artifacts, 'server.log'), serverOutput); }
