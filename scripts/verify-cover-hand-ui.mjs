/** Production Chromium cover rendering, unchanged asset hash and interaction checks. No providers. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
const artifacts = resolve('.verify/cover-hand'); await mkdir(artifacts, { recursive: true });
const base = 'http://127.0.0.1:3192';
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', '3192'], { env: { PATH: process.env.PATH, NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'production' }, stdio: 'ignore' });
let browser; const checks = [], errors = [], remote = [];
const check = (name, value) => { assert.ok(value, name); checks.push(name); };
try {
 check('original concept asset SHA unchanged', createHash('sha256').update(await readFile('public/illustrative-pointing-hand.png')).digest('hex') === 'f4c7a55cbb4084b915c4f23233619c5156018323bf878091b7cd4c178047cbef');
 for (let attempt = 0; attempt < 100; attempt++) { try { if ((await fetch(base)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
 browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
 const context = await browser.newContext({ reducedMotion: 'reduce' });
 await context.route('**/*', async route => { const url = new URL(route.request().url()); if (url.origin === base || ['blob:', 'data:'].includes(url.protocol)) return route.continue(); remote.push(url.origin); return route.abort(); });
 const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
 for (const width of [1440, 1024, 390, 320]) {
  await page.setViewportSize({ width, height: 1000 }); await page.goto(base); await page.waitForLoadState('networkidle');
  check(`${width}: original hand decoded`, await page.locator('.cover-pointing-hand').evaluate(el => el.complete && el.naturalWidth === 1536 && el.naturalHeight === 1024));
  check(`${width}: illustrative provenance visible`, (await page.locator('.specimen-caption').innerText()).includes('original concept'));
  await page.screenshot({ path: resolve(artifacts, `${width}-cover.png`), fullPage: true });
  check(`${width}: no document overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  check(`${width}: pointer events excluded`, await page.locator('.cover-pointing-hand').evaluate(el => getComputedStyle(el).pointerEvents === 'none' && el.getAttribute('aria-hidden') === 'true' && el.alt === ''));
  const bounds = await page.locator('.cover-pointing-hand').boundingBox();
  check(`${width}: hand stays within page width`, bounds.x >= 0 && bounds.x + bounds.width <= width);
  await page.screenshot({ path: resolve(artifacts, `${width}-cover.png`), fullPage: true });
  for (const [name, href] of [['Investigate an image', '/investigate'], ['Investigate a question', '/questions'], ['Investigate a video', '/video'], ['Return to a saved case', '/casebook']]) {
   const link = page.getByRole('link', { name, exact: false }).first(); await link.scrollIntoViewIfNeeded();
   check(`${width}: ${name} clickable above artwork`, await link.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }));
   await link.click(); await page.waitForURL(`${base}${href}`); await page.goto(base);
  }
 }
 check('no remote requests', remote.length === 0); check('no runtime errors', errors.length === 0);
} finally { if (browser) await browser.close(); server.kill('SIGTERM'); await writeFile(resolve(artifacts, 'result.json'), JSON.stringify({ checks, errors, remote }, null, 2)); }
console.log(JSON.stringify({ checks: checks.length, artifacts }));
