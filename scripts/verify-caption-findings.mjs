/** Built desktop/mobile UI and real HTTP/disk. Only investigation completion is synthetic. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const checkout = fileURLToPath(new URL('..', import.meta.url));
const artifacts = resolve(checkout, '.verify/caption-findings');
await mkdir(artifacts, { recursive: true });
const dataDirectory = await mkdtemp(resolve(artifacts, 'data-'));
const compiled = spawnSync(process.execPath, [resolve(checkout, 'node_modules/typescript/bin/tsc'), '--module', 'commonjs', '--target', 'ES2020', '--outDir', resolve(artifacts, 'fixture'), 'src/lib/research/caption-findings-fixture.ts'], { cwd: checkout, encoding: 'utf8' });
assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
const fixture = createRequire(import.meta.url)(resolve(artifacts, 'fixture/research/caption-findings-fixture.js')).captionFindingsFixture();
const probe = createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
const address = probe.address(); assert(address && typeof address === 'object');
await new Promise(r => probe.close(r)); const base = `http://127.0.0.1:${address.port}`;
const server = spawn(process.execPath, [resolve(checkout, 'node_modules/next/dist/bin/next'), 'start', '-H', '127.0.0.1', '-p', String(address.port)], { cwd: checkout, env: { PATH: process.env.PATH, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', CONTEXTTRAIL_RESEARCH_LOCAL: '1', CONTEXTTRAIL_RESEARCH_DATA_DIR: dataDirectory }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOutput = ''; server.stdout.on('data', v => serverOutput += v); server.stderr.on('data', v => serverOutput += v);
let browser;
try {
  for (let attempt = 0; attempt < 100; attempt++) { try { if ((await fetch(`${base}/api/research`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  let investigations = 0, saves = 0, blockedExternal = 0; const errors = [], matrix = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== base) { blockedExternal++; return route.abort(); }
    if (url.pathname === '/api/research/investigate') { investigations++; return route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'research.completed', result: fixture }) + '\n' }); }
    if (url.pathname === '/api/research' && request.method() === 'POST') saves++;
    return route.continue();
  });
  await page.goto(`${base}/video`);
  await page.locator('input[type=file]').setInputFiles({ name: 'synthetic.webm', mimeType: 'video/webm', buffer: Buffer.from('Injected offline completion. No decoding or provider upload.') });
  await page.locator('textarea').fill('Synthetic archival video.');
  await page.locator('input[type=checkbox]').check();
  await page.getByRole('button', { name: 'Investigate video', exact: true }).click();
  const leads = page.getByRole('region', { name: 'Source-linked caption leads', exact: true });
  async function inspect(mode, width) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await leads.waitFor();
    assert.equal(await leads.locator('article').count(), 3);
    const cards = leads.locator('article');
    for (let i = 0; i < 3; i++) { const detail = cards.nth(i).locator('details').first(); if (await detail.getAttribute('open') === null) await detail.locator('summary').first().click(); }
    assert.match(await cards.nth(0).innerText(), /Title used for classification/i);
    assert.match(await cards.nth(0).innerText(), /No page quote can be shown/);
    assert.equal(await cards.nth(0).locator('.evidence-passage').count(), 0);
    assert.equal(await cards.nth(0).locator('a').getAttribute('href'), 'https://example.com/article?id=old-context');
    assert.match(await cards.nth(1).innerText(), /Retained search snippet/i);
    assert.match(await cards.nth(2).innerText(), /Retained page excerpt/i);
    assert.match(await leads.innerText(), /Source challenges the supplied caption/);
    assert.match(await leads.innerText(), /Source supports the supplied caption/);
    const probabilities = cards.nth(0).getByText('Inspect model probabilities', { exact: true });
    if (await probabilities.locator('..').getAttribute('open') === null) await probabilities.click();
    assert.match(await cards.nth(0).innerText(), /0.85/);
    assert.match(await cards.nth(0).innerText(), /not factual truth/);
    assert.match(await page.getByRole('region', { name: 'Sampled-frame caption comparison' }).innerText(), /Insufficient evidence to compare this caption/);
    const gate = leads.getByText('Why a stronger caption result requires more evidence', { exact: true });
    if (await gate.locator('..').getAttribute('open') === null) await gate.click();
    assert.match(await leads.innerText(), /not met in the recorded result/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    const box = await leads.boundingBox(); assert(box && box.width <= width);
    await page.screenshot({ path: resolve(artifacts, `${mode}-${width}.png`), fullPage: true });
    matrix.push({ mode, width, findings: 3, overflow: false, titleQuote: false, status: 'INSUFFICIENT_EVIDENCE' });
  }
  for (const width of [1440, 390, 320]) await inspect('live', width);
  await page.getByRole('button', { name: 'Save video report', exact: true }).click();
  await page.getByRole('link', { name: 'Open saved case', exact: true }).click();
  await page.getByRole('region', { name: 'Saved video report', exact: true }).waitFor();
  await page.reload();
  for (const width of [1440, 390, 320]) await inspect('reopened', width);
  assert.equal(investigations, 1); assert.equal(saves, 1);
  const original = await (await fetch(`${base}/api/research?caseId=${encodeURIComponent(fixture.caseRecord.id)}`)).json();
  assert.deepEqual(original.document.videoReport.result, fixture);
  const revision = original.document.revision;
  // Old archives retain the same schema. Missing and invalid additive findings
  // must remain openable, inspectable and inconclusive after a real disk reload.
  for (const variant of ['legacy', 'malformed', 'withheld', 'failed-spatial']) {
    const archive = structuredClone(fixture); archive.caseRecord.id = `offline-caption-${variant}`;
    const image = archive.frames[0].imageResult;
    if (variant === 'legacy') delete image.sourceLinkedReport;
    if (variant === 'malformed') image.sourceLinkedReport = { version: 'unknown', captionFindings: [] };
    if (variant === 'withheld') image.sourceLinkedReport.captionFindings[0].classificationContext = 'Invented unbound context';
    if (variant === 'failed-spatial') { image.undatedEvidence[0].identityBasis = 'local_spatial_verification'; image.sourceLinkedReport.captionFindings[0].mediaIdentity.basis = 'local_spatial_verification'; image.sourceLinkedReport.captionFindings[0].mediaIdentity.verificationStatus = 'failed'; }
    const saved = await fetch(`${base}/api/research`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'import_case', operationId: `offline-${variant}`, question: archive.question, createdAt: archive.caseRecord.createdAt, caseRecord: archive.caseRecord, videoReport: { schemaVersion: 'contexttrail-video-report-v1', result: archive } }) });
    assert.equal(saved.status, 200, await saved.text());
    await page.goto(`${base}/casebook?case=${archive.caseRecord.id}&chapter=evidence`); await page.reload(); await leads.waitFor();
    assert.match(await page.getByRole('region', { name: 'Sampled-frame caption comparison' }).innerText(), /Insufficient evidence/);
    if (variant === 'legacy') assert.match(await leads.innerText(), /older report did not retain/);
    if (variant === 'malformed') assert.match(await leads.innerText(), /could not be validated/);
    if (variant === 'withheld') { assert.equal(await leads.locator('article').count(), 2); assert.match(await leads.innerText(), /1 retained finding was withheld/); }
    if (variant === 'failed-spatial') { assert.equal(await leads.locator('article').count(), 3); assert.match(await leads.innerText(), /recorded identity check did not establish/); assert.doesNotMatch(await leads.locator('article').first().innerText(), /recorded with local spatial verification/); }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    await page.screenshot({ path: resolve(artifacts, `${variant}-320.png`), fullPage: true });
    matrix.push({ mode: variant, width: 320, overflow: false });
  }
  assert.equal(investigations, 1); assert.equal(saves, 1); assert.equal(blockedExternal, 0); assert.deepEqual(errors, []);
  const after = await (await fetch(`${base}/api/research?caseId=${encodeURIComponent(fixture.caseRecord.id)}`)).json();
  assert.equal(after.document.revision, revision); assert.deepEqual(after.document.videoReport.result, fixture);
  const evidence = { passed: true, fixture: 'synthetic only, no providers', investigations, browserSaves: saves, revisionUnchanged: true, archiveUnchanged: true, blockedExternal, browserErrors: errors, matrix };
  await writeFile(resolve(artifacts, 'evidence.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence));
} finally { await browser?.close(); server.kill('SIGTERM'); await writeFile(resolve(artifacts, 'server.log'), serverOutput); }
