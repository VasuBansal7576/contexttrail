/** Built browser/HTTP reopen of synthetic, contract-generated historical source removals. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const checkout = fileURLToPath(new URL('..', import.meta.url)), artifacts = resolve(checkout, '.verify/historical-evidence');
await mkdir(resolve(artifacts, 'data'), { recursive: true });
const compiled = spawnSync(process.execPath, [resolve(checkout, 'node_modules/typescript/bin/tsc'), '--module', 'commonjs', '--moduleResolution', 'node', '--target', 'ES2022', '--esModuleInterop', '--skipLibCheck', '--strict', '--outDir', resolve(artifacts, 'fixture'), 'src/lib/research/historical-evidence-fixture.ts'], { cwd: checkout, encoding: 'utf8' });
assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
const fixture = createRequire(import.meta.url)(resolve(artifacts, 'fixture/research/historical-evidence-fixture.js')).historicalEvidenceFixture;
const cases = [['text', 'missing'], ['image', 'missing'], ['table', 'missing'], ['table', 'changed'], ['table', 'withdrawn']].map(([kind, state]) => ({ kind, state, report: fixture(kind, state) }));
for (const item of cases) { const id = item.report.document.workspace.inquiry.caseId; await writeFile(resolve(artifacts, 'data', createHash('sha256').update(id).digest('hex') + '.json'), JSON.stringify(item.report.document)); }
const probe = createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); const address = probe.address(); assert(address && typeof address === 'object'); await new Promise(r => probe.close(r));
const base = `http://127.0.0.1:${address.port}`;
const server = spawn(process.execPath, [resolve(checkout, 'node_modules/next/dist/bin/next'), 'start', '-H', '127.0.0.1', '-p', String(address.port)], { cwd: checkout, env: { PATH: process.env.PATH, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', CONTEXTTRAIL_RESEARCH_LOCAL: '1', CONTEXTTRAIL_RESEARCH_DATA_DIR: resolve(artifacts, 'data') }, stdio: ['ignore', 'pipe', 'pipe'] });
let output = ''; server.stdout.on('data', v => output += v); server.stderr.on('data', v => output += v); let browser;
try {
  for (let attempt = 0; attempt < 100; attempt++) { try { if ((await fetch(`${base}/api/research`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [], mutations = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => { const request = route.request(), url = new URL(request.url()); if (request.method() !== 'GET') mutations.push(url.pathname); return url.origin === base ? route.continue() : route.abort(); });
  const checks = [];
  for (const item of cases) {
    const id = item.report.document.workspace.inquiry.caseId, name = `${item.kind}-${item.state}`;
    await page.goto(`${base}/casebook?case=${encodeURIComponent(id)}&chapter=questions`); await page.getByRole('button', { name: 'Inspect original evidence', exact: true }).click();
    const dialog = page.getByRole('dialog'); await dialog.waitFor(); const text = await dialog.innerText();
    assert.match(text, /Read-only original evidence/); assert.match(text, /Finding needs review/); assert.match(text, /2026-09-30T00:00:00Z/); assert.match(text, /2026-10-01T00:00:00Z/);
    if (item.state === 'missing') assert.match(text, /Current source is unavailable/);
    if (item.state === 'changed') assert.match(text, /Current source or material changed/);
    if (item.state === 'withdrawn') assert.match(text, /Retained material was withdrawn/);
    if (item.kind === 'text') assert.equal(await dialog.locator('mark').innerText(), 'the exact saved quote');
    if (item.kind === 'table') assert.equal(await dialog.locator('.selected-cell').innerText(), '18');
    if (item.kind === 'image') assert.equal(await dialog.locator('.region-selection').getAttribute('aria-label'), 'Selected region: x 2, y 1, width 6, height 5 pixels');
    assert.equal(await dialog.getByRole('button').count(), 1);
    await page.screenshot({ path: resolve(artifacts, name + '-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: resolve(artifacts, name + '-mobile.png'), fullPage: true }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    await page.setViewportSize({ width: 1440, height: 1000 }); await page.reload(); await page.getByRole('button', { name: 'Inspect original evidence', exact: true }).waitFor();
    const reopened = await (await fetch(`${base}/api/research?caseId=${encodeURIComponent(id)}`)).json(); assert.equal(reopened.findings[0].reviewStatus, 'needs_review'); assert.deepEqual(reopened.document, item.report.document);
    checks.push(name);
  }
  assert.deepEqual(errors, []); assert.deepEqual(mutations, []);
  const evidence = { passed: true, syntheticOnly: true, checked: checks, browserErrors: errors, mutations, reopenPreservesBindings: true, mobileOverflow: false };
  await writeFile(resolve(artifacts, 'evidence.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence));
} finally { await browser?.close(); server.kill('SIGTERM'); await writeFile(resolve(artifacts, 'server.log'), output); }
