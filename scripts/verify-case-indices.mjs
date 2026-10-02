/** Production Chrome character bounds, wrapping and real case-opening controls. No providers. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const before = process.argv.includes('--before');
const artifacts = resolve('.verify/case-indices', before ? 'before' : 'after');
await mkdir(artifacts, { recursive: true });
const probe = createServer();
await new Promise(done => probe.listen(0, '127.0.0.1', done));
const address = probe.address(); assert(address && typeof address === 'object');
await new Promise(done => probe.close(done));
const base = `http://127.0.0.1:${address.port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(address.port)], {
  env: { PATH: process.env.PATH, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', CONTEXTTRAIL_RESEARCH_LOCAL: '1', CONTEXTTRAIL_RESEARCH_DATA_DIR: resolve(artifacts, 'data') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '', browser, complete = false;
server.stdout.on('data', chunk => logs += chunk); server.stderr.on('data', chunk => logs += chunk);
const checks = [], measurements = [], errors = [], remote = [];
const check = (name, value) => { assert.ok(value, name); checks.push(name); };
try {
  for (let attempt = 0; attempt < 120; attempt++) {
    try { if ((await fetch(`${base}/api/research`)).ok) break; } catch {}
    await new Promise(done => setTimeout(done, 100));
  }
  const question = 'When did the supplied bridge record change, and which independent sources support its verylongunbrokentitlewordthatmustremainreadableonmobile?';
  const response = await fetch(`${base}/api/research`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ kind: 'start', operationId: 'case-index-control', question, createdAt: '2026-10-02T00:00:00Z' }) });
  check('real isolated local case created', response.ok);
  const saved = await response.json(), caseId = saved.document.workspace.inquiry.caseId;
  // Exercise the validated listing boundary with 1000 rows. Only row 01
  // points to the real persisted case; the other synthetic rows test layout.
  const listing = { cases: Array.from({ length: 1000 }, (_, index) => ({ caseId: index === 999 ? caseId : `synthetic-layout-${index}`, question, revision: 123456789, createdAt: '2026-10-02T00:00:00Z' })), warnings: [] };
  browser = await chromium.launch({ headless: true, executablePath: process.env.CONTEXTTRAIL_TEST_CHROMIUM || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) { remote.push(url.origin); return route.abort(); }
    if (url.pathname === '/api/research' && !url.search && route.request().method() === 'GET') return route.fulfill({ json: listing });
    return route.continue();
  });
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${base}/casebook`);
    await page.locator('.case-row').last().waitFor();
    await page.evaluate(() => document.fonts.ready);
    check(`${width}: 1000 synthetic indices rendered`, await page.locator('.case-row').count() === 1000);
    const rows = await page.locator('.case-row').evaluateAll(elements => elements.map((row, index) => {
      const number = row.querySelector('.large-number'), title = row.querySelector('h2'), metadata = row.querySelector('.row-meta');
      const bounds = element => { const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom }; };
      const text = number.firstChild;
      const characters = Array.from(text.textContent, (_, offset) => { const range = document.createRange(); range.setStart(text, offset); range.setEnd(text, offset + 1); return bounds(range); });
      const titleRange = document.createRange(); titleRange.selectNodeContents(title);
      const metadataRange = document.createRange(); metadataRange.selectNodeContents(metadata);
      return { index: index + 1, number: number.textContent, row: bounds(row), numberBlock: bounds(number), title: bounds(title), metadata: bounds(metadata), characters, titleLines: titleRange.getClientRects().length, metadataLines: metadataRange.getClientRects().length };
    }));
    const sample = rows.filter(row => [1, 9, 10, 100, 1000].includes(row.index));
    measurements.push({ width, rows: sample });
    if (before) {
      check(`${width}: baseline reproduces expected digit layout`, width === 1440 ? rows[0].characters.every(char => char.y === rows[0].characters[0].y) : rows[0].characters[0].y !== rows[0].characters[1].y);
    } else {
      check(`${width}: every index stays on one line`, rows.every(row => row.characters.every(char => char.y === row.characters[0].y)));
      check(`${width}: all digits fit their number column`, rows.every(row => row.characters.every(char => char.x >= row.numberBlock.x && char.right <= row.numberBlock.right + 0.5)));
      check(`${width}: no number/title overlap`, rows.every(row => Math.max(...row.characters.map(char => char.right)) <= row.title.x));
      check(`${width}: no title/metadata overlap`, rows.every(row => row.title.right <= row.metadata.x || row.title.bottom <= row.metadata.y));
      check(`${width}: no row overflow`, rows.every(row => row.row.x >= 0 && row.row.right <= width && row.metadata.right <= row.row.right + 0.5));
      check(`${width}: document fits viewport`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (width < 761) check(`${width}: title and metadata wrap independently`, sample.every(row => row.titleLines > 1 && row.metadataLines >= 2));
    }
    await page.screenshot({ path: resolve(artifacts, `${width}-casebook.png`) });
    for (const index of [1, 9, 10, 100, 1000]) await page.locator('.case-row').nth(index - 1).screenshot({ path: resolve(artifacts, `${width}-index-${index}.png`) });
    if (!before) {
      await page.locator('.case-row').first().click();
      await page.waitForURL(`**/casebook?case=${encodeURIComponent(caseId)}&chapter=questions`);
      await page.getByRole('button', { name: 'Add explanation', exact: true }).waitFor();
      check(`${width}: row opens actual saved question`, (await page.locator('.case-title-note').innerText()).includes(question));
    }
  }
  check('no remote requests', remote.length === 0); check('no runtime errors', errors.length === 0);
  complete = true;
} finally {
  await browser?.close(); server.kill('SIGTERM');
  await writeFile(resolve(artifacts, 'server.log'), logs);
  await writeFile(resolve(artifacts, 'result.json'), JSON.stringify({ before, complete, checks, measurements, errors, remote }, null, 2));
}
console.log(JSON.stringify({ complete, checks: checks.length, artifacts }));
