/** Production Chrome + actual local disk saves. Completed responses are synthetic, no providers. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
const artifacts = resolve('.verify/saved-topic-limits'); await mkdir(artifacts, { recursive: true });
const data = await mkdtemp(resolve(artifacts, 'data-'));
const compiled = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '--module', 'commonjs', '--target', 'ES2023', '--esModuleInterop', '--skipLibCheck', '--strict', '--outDir', resolve(artifacts, 'fixture'), 'src/lib/research/saved-topic-fixture.ts'], { encoding: 'utf8' });
assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
const fixture = createRequire(import.meta.url)(resolve(artifacts, 'fixture/research/saved-topic-fixture.js')).savedTopicFixture;
const probe = createServer(); await new Promise(done => probe.listen(0, '127.0.0.1', done));
const address = probe.address(); assert(address && typeof address === 'object'); await new Promise(done => probe.close(done));
const base = `http://127.0.0.1:${address.port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(address.port)], { env: { PATH: process.env.PATH, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', CONTEXTTRAIL_RESEARCH_LOCAL: '1', CONTEXTTRAIL_RESEARCH_DATA_DIR: data }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '', browser, completed, investigations = 0, complete = false; server.stdout.on('data', chunk => logs += chunk); server.stderr.on('data', chunk => logs += chunk);
const checks = [], errors = [], remote = [], mutations = [], descriptions = [];
const check = (name, value) => { assert.ok(value, name); checks.push(name); };
const caseFile = id => resolve(data, createHash('sha256').update(id).digest('hex') + '.json');
const read = async id => (await (await fetch(`${base}/api/research?caseId=${encodeURIComponent(id)}`)).json());
async function correct(result, operationId) {
  const response = await fetch(`${base}/api/research`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ kind: 'update', caseId: result.caseRecord.id, operationId, expectedRevision: 1, change: { kind: 'evidence', value: { ...result.caseRecord.evidence[0], title: 'Corrected current source' }, assets: [] } }) });
  check(`${operationId}: actual correction succeeds`, response.ok);
}
try {
  for (let attempt = 0; attempt < 120; attempt++) { try { if ((await fetch(`${base}/api/research`)).ok) break; } catch {} await new Promise(done => setTimeout(done, 100)); }
  browser = await chromium.launch({ headless: true, executablePath: process.env.CONTEXTTRAIL_TEST_CHROMIUM || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage({ reducedMotion: 'reduce' }); page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== base) { remote.push(url.origin); return route.abort(); }
    if (request.method() !== 'GET') mutations.push(url.pathname);
    if (url.pathname === '/api/research/investigate') { investigations++; return route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'research.completed', result: completed }) + '\n' }); }
    return route.continue();
  });
  async function inspect(result, width, state) {
    const id = result.caseRecord.id, name = `${width}-${state}`;
    await page.setViewportSize({ width, height: 1000 });
    const before = await readFile(caseFile(id)), writeCount = mutations.length, requestCount = investigations;
    await page.goto(`${base}/casebook?case=${encodeURIComponent(id)}&chapter=evidence`);
    const region = page.getByRole('region', { name: 'Saved grounded report', exact: true }); await region.waitFor();
    const coverage = region.getByRole('region', { name: 'Saved investigation coverage', exact: true });
    for (const phase of ['open', 'reload']) {
      if (phase === 'reload') { await page.reload(); await coverage.waitFor(); }
      const text = await coverage.innerText(); descriptions.push({ width, state, phase, text });
      if (state.startsWith('legacy')) {
        check(`${name}/${phase}: legacy coverage unavailable`, text.includes('original investigation coverage snapshot was not retained'));
        check(`${name}/${phase}: current coverage not substituted`, !text.includes(result.caseRecord.coverage.limitations[1]));
      } else {
        check(`${name}/${phase}: all retained warnings visible`, result.caseRecord.coverage.limitations.every(limit => text.includes(limit)));
        check(`${name}/${phase}: failed and rejected read outcomes visible`, text.includes('Failed reads: 1') && text.includes('Rejected destinations: 1'));
        check(`${name}/${phase}: original metadata visible`, text.includes('12 omitted candidates') && text.includes('case record created 2026-10-02T00:00:00Z'));
        check(`${name}/${phase}: coverage outside collapsed report`, await coverage.evaluate(el => !el.closest('details')));
      }
      if (state.includes('stale')) {
        check(`${name}/${phase}: stale historical report clear`, (await region.innerText()).includes('Needs review'));
        check(`${name}/${phase}: original report stays collapsed`, await region.locator('.saved-original-report').getAttribute('open') === null);
        if (!state.startsWith('legacy')) check(`${name}/${phase}: historical coverage labeled`, text.includes('original historical report'));
      } else check(`${name}/${phase}: source-assertion semantics preserved`, (await region.innerText()).includes('not claims supplied by you or established facts'));
      check(`${name}/${phase}: no overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    await page.screenshot({ path: resolve(artifacts, `${name}.png`), fullPage: true });
    check(`${name}: no archive rewrite`, (await readFile(caseFile(id))).equals(before));
    check(`${name}: no reopen mutations or investigation`, mutations.length === writeCount && investigations === requestCount);
    const reopened = await read(id);
    check(`${name}: exact claim report survives`, JSON.stringify(reopened.document.claimReport) === JSON.stringify(result.claimReport));
    check(`${name}: no forced stronger relationships`, reopened.document.claimReport.sources.every(source => source.relation === 'insufficient'));
  }
  for (const width of [1440, 390, 320]) {
    completed = fixture(`offline-saved-topic-${width}`);
    await page.setViewportSize({ width, height: 1000 }); await page.goto(`${base}/questions`);
    await page.locator('textarea').fill(completed.question); await page.getByRole('button', { name: 'Investigate question', exact: true }).click();
    await page.getByRole('button', { name: 'Save report', exact: true }).click();
    const opener = page.getByRole('link', { name: 'Open saved case', exact: true }); await opener.waitFor();
    const savedBytes = await readFile(caseFile(completed.caseRecord.id)), saveWrites = mutations.length, saveInvestigations = investigations;
    await opener.click(); await page.getByRole('region', { name: 'Saved grounded report', exact: true }).waitFor();
    check(`${width}: initial saved-case opening does no work`, mutations.length === saveWrites && investigations === saveInvestigations);
    check(`${width}: initial saved-case opening preserves archive bytes`, (await readFile(caseFile(completed.caseRecord.id))).equals(savedBytes));
    check(`${width}: actual save retains original coverage`, JSON.stringify((await read(completed.caseRecord.id)).document.claimReportCase.coverage) === JSON.stringify(completed.caseRecord.coverage));
    await inspect(completed, width, 'current');
  }
  const original = fixture('offline-saved-topic-1440'); await correct(original, 'source-correction');
  for (const width of [1440, 390, 320]) await inspect(original, width, 'stale');
  const legacy = fixture('offline-saved-topic-390');
  const legacyDocument = JSON.parse(await readFile(caseFile(legacy.caseRecord.id), 'utf8')); delete legacyDocument.claimReportCase; delete legacyDocument.claimReportCaseOrigin;
  await writeFile(caseFile(legacy.caseRecord.id), JSON.stringify(legacyDocument));
  for (const width of [1440, 390, 320]) await inspect(legacy, width, 'legacy');
  await correct(legacy, 'legacy-correction');
  for (const width of [1440, 390, 320]) await inspect(legacy, width, 'legacy-stale');
  check('only three injected completed investigations', investigations === 3);
  check('no remote requests', remote.length === 0); check('no browser errors', errors.length === 0);
  complete = true;
} finally {
  await browser?.close(); server.kill('SIGTERM');
  await writeFile(resolve(artifacts, 'server.log'), logs);
  await writeFile(resolve(artifacts, 'evidence.json'), JSON.stringify({ complete, scenarios: descriptions.length, checks, errors, remote, mutations, investigations, descriptions }, null, 2));
}
console.log(JSON.stringify({ complete, scenarios: descriptions.length, checks: checks.length, investigations, artifacts }));
