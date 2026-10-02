/** Offline Chromium verification. HTTP responses are synthetic; external requests are blocked. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
const artifacts = resolve('.verify/research-copy'); await mkdir(artifacts, { recursive: true });
const base = 'http://127.0.0.1:3191';
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', '3191'], { env: { PATH: process.env.PATH, NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'production' }, stdio: 'ignore' });
let browser; const checks = [], errors = [], remote = [];
const check = (name, value) => { assert.ok(value, name); checks.push(name); };
const codes = ['near_match_verifier_disabled', 'reporting_origins_unresolved', 'unknown_dates_present', 'insufficient_dated_occurrences', 'future_limit'];
function fixture(kind, state) {
 const evidence = { id: 'source', sourceUrl: 'https://example.com/offline', title: 'Offline retained source', content: { kind: 'text', text: 'Synthetic source passage. No provider was contacted.', attribution: 'search_snippet' }, publicationDate: { status: 'unknown', reason: 'Synthetic fixture.' }, provenance: { method: 'retrieval', toolVersion: null, capturedAt: null, retrievedAt: null, rights: 'public_reference', retention: 'reference_only', contentHash: null } };
 return { kind, question: 'Offline research copy verification?', caseRecord: { schemaVersion: 'contexttrail-case-v1', id: 'offline-copy', revision: 1, createdAt: '2026-10-02T00:00:00Z', claims: [], assets: [], evidence: [evidence], occurrences: [], relations: [], coverage: { scope: 'retrieved_evidence', completeness: state === 'complete' ? 'partial' : 'unknown', omittedEvidenceCount: 0, originalPublication: { status: 'unknown', reason: 'Offline fixture. Original publication unestablished.' }, limitations: codes, searches: [] } }, frames: kind === 'video' ? [{ timestampMs: 1000, imageResult: { limitations: codes, timeline: [], undatedEvidence: [{ evidenceId: 'source', title: evidence.title, sourceUrl: evidence.sourceUrl, dateStatus: 'unknown', observedAt: null, identityBasis: 'exact_match', excerpt: evidence.content.text, displayAttribution: 'Synthetic excerpt', excerptSource: 'search_snippet' }], supportingEvidence: [], contextualEvidence: [] } }] : [], assessments: [], limitations: codes };
}
try {
 for (let attempt = 0; attempt < 100; attempt++) { try { if ((await fetch(base)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
 browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
 const context = await browser.newContext({ reducedMotion: 'reduce' });
 await context.route('**/*', async route => { const url = new URL(route.request().url()); if (url.origin === base || ['blob:', 'data:'].includes(url.protocol)) return route.continue(); remote.push(url.origin); return route.abort(); });
 const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
 for (const width of [1440, 390]) for (const kind of ['topic', 'video']) for (const state of ['complete', 'partial', 'failure']) {
  await page.setViewportSize({ width, height: 1000 }); await page.goto(`${base}/${kind === 'topic' ? 'questions' : 'video'}`);
  const progress = kind === 'topic' ? 'Reading source 2 of 6…' : 'Examining retrieved frame evidence: REFINED_CLASSIFY…';
  await page.evaluate(message => { window.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'research.progress', message }) + '\n')); window.offlineFinish = event => { controller.enqueue(new TextEncoder().encode(JSON.stringify(event) + '\n')); controller.close(); }; } }), { headers: { 'content-type': 'application/x-ndjson' } }); }, progress);
  if (kind === 'topic') await page.locator('textarea').fill('Offline research copy verification?');
  else { await page.locator('input[type=file]').setInputFiles({ name: 'offline.webm', mimeType: 'video/webm', buffer: Buffer.from('synthetic-fixture') }); await page.locator('input[type=checkbox]').check(); }
  await page.getByRole('button', { name: kind === 'topic' ? 'Investigate question' : 'Investigate video', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel investigation', exact: true }).waitFor();
  const status = await page.locator('.automatic-action-status').innerText();
  check(`${width}/${kind}/${state}: readable progress`, status === (kind === 'topic' ? progress : 'Assessing context in retrieved passages…'));
  check(`${width}/${kind}/${state}: progress visible`, await page.locator('.automatic-action-status').isVisible());
  await page.screenshot({ path: resolve(artifacts, `${width}-${kind}-${state}-progress.png`), fullPage: true });
  await page.evaluate(event => window.offlineFinish(event), state === 'failure' ? { type: 'research.error', message: 'Offline fixture: source search unavailable. Try again.' } : { type: 'research.completed', result: fixture(kind, state) });
  if (state === 'failure') { await page.locator('.automatic-status [role=alert]').waitFor(); check(`${width}/${kind}: failure recovery`, await page.getByRole('button', { name: kind === 'topic' ? 'Investigate question' : 'Investigate video', exact: true }).isEnabled()); }
  else {
   await page.locator('.automatic-results').waitFor();
   check(`${width}/${kind}/${state}: coverage unchanged`, (await page.locator('.automatic-results .state-label').textContent()) === `${state === 'complete' ? 'partial' : 'unknown'} coverage`);
   const visible = await page.locator('.automatic-limitations').first().innerText();
   check(`${width}/${kind}/${state}: uncertainty visible`, visible.includes('Similar-looking images were not independently checked') && visible.includes('meaning is unavailable'));
   check(`${width}/${kind}/${state}: raw tokens collapsed`, !visible.includes(codes[0]));
   check(`${width}/${kind}/${state}: retained link`, await page.locator('a[href="https://example.com/offline"]').count() > 0);
   await page.locator('.automatic-limitations summary').first().click(); check(`${width}/${kind}/${state}: raw value retained`, (await page.locator('.automatic-limitations').first().innerText()).includes(codes[0])); await page.locator('.automatic-limitations summary').first().click();
   if (kind === 'video') { await page.getByRole('button', { name: 'Sampled frames (1)' }).click(); check(`${width}/${kind}/${state}: frame limits readable`, (await page.locator('.automatic-frame .automatic-limitations').innerText()).includes('Similar-looking images were not independently checked')); }
  }
  check(`${width}/${kind}/${state}: no document overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: resolve(artifacts, `${width}-${kind}-${state}.png`), fullPage: true });
 }
 check('no remote requests', remote.length === 0); check('no runtime errors', errors.length === 0);
} finally { if (browser) await browser.close(); server.kill('SIGTERM'); await writeFile(resolve(artifacts, 'result.json'), JSON.stringify({ checks, errors, remote }, null, 2)); }
console.log(JSON.stringify({ checks: checks.length, artifacts }));
