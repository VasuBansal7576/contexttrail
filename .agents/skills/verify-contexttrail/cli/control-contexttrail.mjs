#!/usr/bin/env node
/**
 * control-contexttrail — isolated launch/doctor/drive/evidence/cleanup
 * harness for ContextTrail verification.
 *
 * Commands:
 *   launch   --checkout <abs> [--revision <sha|HEAD>] [--port 3110]
 *            --run-id <id> [--live]
 *   doctor   --run-id <id> [--expect-revision <sha>]
 *   drive    <feature> --run-id <id> [--viewport desktop|mobile]
 *            [--case <fixture-name>] [--live]
 *   evidence --run-id <id>
 *   cleanup  --run-id <id>
 *
 * Normal runs spend zero provider credit: `drive investigation` submits a
 * controlled public-contract NDJSON stream intercepted at POST
 * /api/investigate (evidence tier "public-contract-boundary"). Real
 * provider runs require both RUN_LIVE_TESTS=1 and --live.
 */

import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES_DIR = path.join(SKILL_DIR, "fixtures");

/* ----------------------------- arg parsing ----------------------------- */

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (key === "live" || key === "no-video") flags[key] = true;
      else flags[key] = argv[++i];
    } else positional.push(a);
  }
  return { positional, flags };
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const command = positional[0];

function required(name) {
  if (flags[name] === undefined) {
    fail(`missing required --${name}`);
  }
  return flags[name];
}

function fail(msg, code = 2) {
  console.error(`control-contexttrail: ${msg}`);
  process.exit(code);
}

/* ------------------------------ run state ------------------------------ */

/** Repo root derived from this file's own location — the stable anchor
 *  that lets doctor/drive/evidence/cleanup resolve a run without flags
 *  or a matching cwd. */
const CLI_CHECKOUT = path.resolve(SKILL_DIR, "..", "..", "..");

function runDir(runId) {
  const candidates = [
    flags.checkout && path.resolve(flags.checkout),
    process.env.CONTEXTTRAIL_CHECKOUT && path.resolve(process.env.CONTEXTTRAIL_CHECKOUT),
    CLI_CHECKOUT,
    process.cwd(),
  ].filter(Boolean);
  for (const c of candidates) {
    const dir = path.join(c, ".verify", runId);
    if (fs.existsSync(path.join(dir, "manifest.json"))) return dir;
  }
  if (flags.checkout) return path.join(path.resolve(flags.checkout), ".verify", runId);
  fail(`cannot resolve run ${runId}: pass --checkout or run from the checkout`);
}

function manifestPath(runId) {
  return path.join(runDir(runId), "manifest.json");
}

function readManifest(runId) {
  try {
    const p = manifestPath(runId);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
  } catch {
    return null;
  }
}

function writeManifest(runId, patch) {
  const p = manifestPath(runId);
  const cur = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ ...cur, ...patch }, null, 2) + "\n");
}

/* ------------------------------- helpers ------------------------------- */

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGet(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }),
      );
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve({ status: 0, headers: {}, body: Buffer.alloc(0) }));
  });
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** OS process signature for PID-reuse guarding: start time + argv. */
function pidSignature(pid) {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "args="], {
      encoding: "utf8",
    }).replace(/\s+/g, " ").trim();
  } catch {
    return null;
  }
}

/** PID(s) listening on a TCP port (lsof). */
function portListeners(port) {
  try {
    const out = execFileSync(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { encoding: "utf8" },
    );
    return out.split("\n").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

/** All descendant pids of `pid` (pgrep -P walk), children before parents. */
function descendantsOf(pid) {
  const out = [];
  const walk = (p) => {
    let kids = [];
    try {
      kids = execFileSync("pgrep", ["-P", String(p)], { encoding: "utf8" })
        .split("\n")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n > 0);
    } catch {
      kids = [];
    }
    for (const k of kids) {
      out.push(k);
      walk(k);
    }
  };
  walk(pid);
  return out;
}

/** True when `pid` is an ancestor-or-self of `descendant`. */
function isAncestorOrSelf(pid, descendant) {
  if (pid === descendant) return true;
  let ppid = new Map();
  try {
    for (const line of execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" }).split("\n")) {
      const [a, b] = line.trim().split(/\s+/).map(Number);
      if (Number.isInteger(a) && Number.isInteger(b)) ppid.set(a, b);
    }
  } catch {
    return false;
  }
  let cur = descendant;
  for (let i = 0; i < 100 && cur > 1; i++) {
    cur = ppid.get(cur) ?? 0;
    if (cur === pid) return true;
  }
  return false;
}

function gitSha(checkout, rev) {
  return execFileSync("git", ["-C", checkout, "rev-parse", rev], { encoding: "utf8" }).trim();
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "127.0.0.1");
  });
}

async function waitReady(url, timeoutMs = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const res = await httpGet(url, 3000);
    if (res.status === 200) return true;
    await delay(500);
  }
  return false;
}

/** Minimal valid 1x1 PNG used as the user upload in controlled drives. */
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function evidenceDir(runId) {
  const d = path.join(runDir(runId), "evidence");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function evidenceRecord(runId, record) {
  const p = path.join(evidenceDir(runId), "actions.jsonl");
  fs.appendFileSync(p, JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n");
}

/* -------------------------------- launch ------------------------------- */

async function launch() {
  const checkout = path.resolve(required("checkout"));
  const runId = required("run-id");
  const revision = flags.revision ?? "HEAD";
  const port = Number(flags.port ?? 3110);
  const live = flags.live === true;
  if (live && process.env.RUN_LIVE_TESTS !== "1") {
    fail("--live requires RUN_LIVE_TESTS=1 (provider credit gate)");
  }
  const sha = gitSha(checkout, revision);
  const dir = runDir(runId);
  const snap = path.join(dir, "checkout");
  const logDir = path.join(dir, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  evidenceDir(runId);

  if (fs.existsSync(snap)) fail(`run-id ${runId} already launched (snapshot exists)`);
  if (!(await portFree(port))) fail(`port ${port} is not free`);
  fs.mkdirSync(snap, { recursive: true });

  // Isolated snapshot of the pinned revision — never build in the source
  // checkout and never against a live server's .next.
  execFileSync("git", ["-C", checkout, "archive", sha], {
    stdio: ["ignore", fs.openSync(path.join(logDir, "archive.tar"), "w"), "inherit"],
  });
  execFileSync("tar", ["-xf", path.join(logDir, "archive.tar"), "-C", snap]);

  if (live) {
    const env = path.join(checkout, ".env.local");
    if (!fs.existsSync(env)) fail("--live requires .env.local in the source checkout");
    fs.symlinkSync(env, path.join(snap, ".env.local"));
  }

  const installLog = fs.openSync(path.join(logDir, "install.log"), "w");
  execFileSync("npm", ["ci"], { cwd: snap, stdio: ["ignore", installLog, installLog] });
  const buildLog = fs.openSync(path.join(logDir, "build.log"), "w");
  execFileSync("npm", ["run", "build"], { cwd: snap, stdio: ["ignore", buildLog, buildLog] });
  const buildId = fs.readFileSync(path.join(snap, ".next", "BUILD_ID"), "utf8").trim();

  const serverLog = fs.openSync(path.join(logDir, "server.log"), "w");
  const child = spawn("npm", ["start", "--", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: snap,
    detached: true,
    stdio: ["ignore", serverLog, serverLog],
    env: { ...process.env, NODE_ENV: "production" },
  });
  child.unref();

  const url = `http://127.0.0.1:${port}`;
  const ok = await waitReady(url);
  writeManifest(runId, {
    runId,
    pid: child.pid,
    pidSig: pidSignature(child.pid),
    port,
    url,
    revision: sha,
    buildId,
    sourceCheckout: checkout,
    snapshot: snap,
    live,
    startedAt: new Date().toISOString(),
    lockfileSha: crypto.createHash("sha256").update(fs.readFileSync(path.join(snap, "package-lock.json"))).digest("hex").slice(0, 16),
    node: process.version,
    ready: ok,
  });
  if (!ok) {
    console.log(JSON.stringify({ launched: false, reason: "server did not become ready", logDir }));
    process.exit(1);
  }
  console.log(JSON.stringify({ launched: true, url, pid: child.pid, revision: sha, buildId }));
}

/* -------------------------------- doctor ------------------------------- */

/** PID reuse guard: the recorded process must still be our process. */
function pidIsOwned(m) {
  if (!m.pid || !pidAlive(m.pid)) return false;
  if (!m.pidSig) return true; // manifests predating the guard
  return pidSignature(m.pid) === m.pidSig;
}

async function doctor() {
  const runId = required("run-id");
  const m = readManifest(runId);
  if (!m) fail(`no manifest for run-id ${runId}`);
  const checks = {};
  checks.ownedPidAlive = pidIsOwned(m);
  // The expected port must be bound by our recorded process or one of
  // its descendants — not just any listener on the port.
  const listeners = portListeners(m.port);
  checks.portBoundByOwnedProcess =
    listeners.length > 0 &&
    (listeners.includes(m.pid) ||
      listeners.some((p) => isAncestorOrSelf(m.pid, p)) ||
      descendantsOf(m.pid).some((p) => listeners.includes(p)));
  const landing = await httpGet(m.url);
  checks.landing200 = landing.status === 200;
  checks.titlePresent = landing.body.toString("utf8").includes("ContextTrail");
  const css = [...landing.body.toString("utf8").matchAll(/href="([^"]+\.css[^"]*)"/g)]
    .map((x) => x[1])[0];
  checks.stylesheet200 = css ? (await httpGet(new URL(css, m.url).href)).status === 200 : false;
  // The served build — not merely a file on disk — must match manifest.
  // Next serves /_next/static/<BUILD_ID>/_ssgManifest.js keyed by build id.
  checks.servedBuildIdMatch =
    (await httpGet(`${m.url}/_next/static/${m.buildId}/_ssgManifest.js`)).status === 200;
  checks.revisionMatch =
    flags["expect-revision"] === undefined
      ? true
      : m.revision.startsWith(flags["expect-revision"]) ||
        gitSha(m.sourceCheckout, flags["expect-revision"]).startsWith(m.revision);
  checks.investigateRouteAnswers = (await httpGet(`${m.url}/api/investigate`)).status !== 0;
  // Configuration presence as a boolean only — never read secret values.
  // Informational: required only for gated live runs, not controlled drives.
  const envFilePresent = fs.existsSync(path.join(m.snapshot, ".env.local"));
  const healthy = Object.values(checks).every(Boolean);
  console.log(JSON.stringify({ runId, healthy, checks, envFilePresent, revision: m.revision, buildId: m.buildId, url: m.url }));
  process.exit(healthy ? 0 : 1);
}

/* -------------------------------- drive -------------------------------- */

const VIEWPORTS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } };

async function openSession(m, runId, viewport) {
  const { chromium } = await import("playwright");
  const outDir = evidenceDir(runId);
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: VIEWPORTS[viewport] ?? VIEWPORTS.desktop,
    recordVideo: flags["no-video"] ? undefined : { dir: outDir, size: VIEWPORTS[viewport] ?? VIEWPORTS.desktop },
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(`console: ${msg.text().slice(0, 300)}`);
  });
  return { browser, context, page, consoleErrors };
}

async function shot(page, runId, name) {
  const p = path.join(evidenceDir(runId), `${name}.png`);
  await page.screenshot({ path: p, fullPage: true });
  return p;
}

async function aria(page, runId, name) {
  const p = path.join(evidenceDir(runId), `${name}.aria.txt`);
  fs.writeFileSync(p, await page.locator("body").ariaSnapshot());
  return p;
}

function saveConsole(runId, name, errors) {
  fs.writeFileSync(
    path.join(evidenceDir(runId), `${name}-console.json`),
    JSON.stringify(errors, null, 2),
  );
}

function fixturePath(name) {
  const p = path.join(FIXTURES_DIR, `${name}.ndjson`);
  if (!fs.existsSync(p)) fail(`unknown fixture case ${name} (expected ${p})`);
  return p;
}

/** Intercept POST /api/investigate with a controlled public-contract stream. */
async function stubInvestigation(page, fixtureName) {
  const body = fs.readFileSync(fixturePath(fixtureName));
  await page.route("**/api/investigate", (route) => {
    if (route.request().method() !== "POST") return route.continue();
    return route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body,
    });
  });
}

async function submitUpload(page, runId, { claim = null } = {}) {
  const tmp = path.join(runDir(runId), "scratch");
  fs.mkdirSync(tmp, { recursive: true });
  const img = path.join(tmp, "upload.png");
  if (!fs.existsSync(img)) fs.writeFileSync(img, PNG_1PX);
  await page.goto(`${readManifest(runId).url}/investigate`, { waitUntil: "domcontentloaded" });
  // The dropzone label (#ct-image-input) forwards to a hidden file input —
  // setInputFiles exercises the same onChange path a native chooser drives.
  await page.setInputFiles("#ct-image-input", img);
  if (claim) {
    const box = page.getByRole("textbox", { name: /claim|caption/i });
    await box.fill(claim);
  }
}

async function waitForResult(page, timeoutMs = 30_000) {
  await page.waitForSelector("text=/Limited media history|Media history|INSUFFICIENT|CONFLICT|Investigation|Earliest observed|Evidence limits/i", { timeout: timeoutMs });
}

async function drive() {
  const feature = positional[1];
  const runId = required("run-id");
  const m = readManifest(runId);
  if (!m) fail(`no manifest for run-id ${runId}`);
  if (!pidIsOwned(m)) fail(`server pid ${m.pid} is not alive (or was reused) — relaunch`);
  const viewport = flags.viewport ?? "desktop";
  const live = flags.live === true;
  if (live && process.env.RUN_LIVE_TESTS !== "1") fail("--live requires RUN_LIVE_TESTS=1");

  const { browser, context, page, consoleErrors } = await openSession(m, runId, viewport);
  const t0 = Date.now();
  try {
    switch (feature) {
      case "landing": {
        await page.goto(m.url, { waitUntil: "networkidle" });
        await shot(page, runId, "landing-hero");
        await aria(page, runId, "landing");
        // No provider request may fire from the landing page.
        let apiHit = false;
        page.on("request", (r) => {
          if (r.url().includes("/api/investigate")) apiHit = true;
        });
        const cta = page.getByRole("link", { name: /start investigating/i }).first();
        await cta.click();
        await page.waitForURL(/\/investigate/);
        await shot(page, runId, "landing-cta-destination");
        evidenceRecord(runId, {
          feature: "landing", viewport, tier: "real-ui",
          apiRequestFromLanding: apiHit, destination: page.url(),
        });
        break;
      }
      case "upload": {
        const imgPath = path.join(runDir(runId), "scratch");
        fs.mkdirSync(imgPath, { recursive: true });
        fs.writeFileSync(path.join(imgPath, "upload.png"), PNG_1PX);
        await page.goto(`${m.url}/investigate`, { waitUntil: "domcontentloaded" });
        await page.setInputFiles("#ct-image-input", path.join(imgPath, "upload.png"));
        await shot(page, runId, "upload-selected");
        await aria(page, runId, "upload-selected");
        const submit = page.getByRole("button", { name: /start investigation/i });
        evidenceRecord(runId, {
          feature: "upload", entry: "setInputFiles", viewport, tier: "real-ui",
          submitEnabled: await submit.isEnabled().catch(() => null),
        });
        break;
      }
      case "investigation": {
        const caseName = flags.case ?? "controlled-trace";
        const mode = flags.mode ?? "trace";
        if (!live) await stubInvestigation(page, caseName);
        await submitUpload(page, runId, { claim: mode === "claim" ? "controlled claim text" : null });
        await page.getByRole("button", { name: /start investigation/i }).click();
        await waitForResult(page, live ? 95_000 : 30_000);
        await shot(page, runId, `investigation-${mode}-progress`);
        await waitForResult(page);
        await shot(page, runId, `investigation-${mode}-result`);
        await aria(page, runId, `investigation-${mode}-result`);
        evidenceRecord(runId, {
          feature: "investigation", mode, case: live ? "live" : caseName,
          tier: live ? "live" : "public-contract-boundary",
          elapsedMs: Date.now() - t0,
        });
        break;
      }
      case "result": {
        const caseName = flags.case ?? "controlled-claim";
        const view = flags.view ?? "overview";
        if (!live) await stubInvestigation(page, caseName);
        await submitUpload(page, runId, { claim: "controlled claim text" });
        await page.getByRole("button", { name: /start investigation/i }).click();
        await waitForResult(page);
        for (const tab of ["Overview", "Timeline", "Sources", "Analysis"]) {
          const el = page.getByRole("tab", { name: tab }).or(page.getByRole("button", { name: tab }));
          if (await el.first().isVisible().catch(() => false)) {
            await el.first().click();
            await delay(250);
            await shot(page, runId, `result-${tab.toLowerCase()}`);
          }
        }
        await aria(page, runId, `result-${view}`);
        evidenceRecord(runId, {
          feature: "result", view, case: caseName, tier: "public-contract-boundary",
        });
        break;
      }
      default:
        fail(`unknown drive feature ${feature}`);
    }
    saveConsole(runId, `${feature}-${flags.case ?? "default"}`, consoleErrors);
    await context.close();
    await browser.close();
    console.log(JSON.stringify({ drove: feature, runId, consoleErrors: consoleErrors.length }));
  } catch (err) {
    saveConsole(runId, `${feature}-failed`, consoleErrors);
    try {
      await shot(page, runId, `${feature}-FAILED`);
    } catch { /* page may be dead */ }
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    throw err;
  }
}

/* ------------------------------- evidence ------------------------------ */

async function evidence() {
  const runId = required("run-id");
  const m = readManifest(runId);
  if (!m) fail(`no manifest for run-id ${runId}`);
  const dir = evidenceDir(runId);
  const files = fs.readdirSync(dir).sort();
  const summary = {
    runId,
    revision: m.revision,
    buildId: m.buildId,
    generatedAt: new Date().toISOString(),
    artifactCount: files.length,
    artifacts: files,
  };
  fs.writeFileSync(path.join(dir, "evidence-manifest.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
}

/* ------------------------------- cleanup ------------------------------- */

async function cleanup() {
  const runId = required("run-id");
  const m = readManifest(runId);
  if (!m) fail(`no manifest for run-id ${runId}`);
  const killed = [];
  if (m.pid && pidAlive(m.pid)) {
    if (!pidIsOwned(m)) {
      // PID was recycled by the OS — never signal a process we don't own.
      console.log(JSON.stringify({ cleaned: runId, killed, pidReused: true, evidenceArtifacts: fs.existsSync(path.join(runDir(runId), "evidence")) ? fs.readdirSync(path.join(runDir(runId), "evidence")).length : 0 }));
      process.exit(1);
    }
    // Stop the whole owned tree — children (next-server) first, npm last.
    const tree = [...descendantsOf(m.pid), m.pid];
    for (const p of tree) {
      try {
        process.kill(p, "SIGTERM");
        killed.push(p);
      } catch { /* already gone */ }
    }
    await delay(500);
    for (const p of tree) {
      try {
        if (pidAlive(p)) process.kill(p, "SIGKILL");
      } catch { /* already gone */ }
    }
    // Wait until the port is released or give up with a nonzero exit —
    // a surviving listener means our tree was not fully stopped.
    const t0 = Date.now();
    while (portListeners(m.port).length > 0 && Date.now() - t0 < 5000) {
      await delay(250);
    }
    if (portListeners(m.port).length > 0) {
      console.log(JSON.stringify({ cleaned: runId, killed, portStillBound: true }));
      process.exit(1);
    }
  }
  // Remove scratch checkout/install — preserve evidence, logs and manifest.
  const snap = path.join(runDir(runId), "checkout");
  if (fs.existsSync(snap)) fs.rmSync(snap, { recursive: true, force: true });
  const scratch = path.join(runDir(runId), "scratch");
  if (fs.existsSync(scratch)) fs.rmSync(scratch, { recursive: true, force: true });
  writeManifest(runId, { cleanedAt: new Date().toISOString(), pid: null, alive: false });
  const ev = fs.existsSync(path.join(runDir(runId), "evidence"))
    ? fs.readdirSync(path.join(runDir(runId), "evidence")).length
    : 0;
  console.log(JSON.stringify({ cleaned: runId, killed, evidenceArtifacts: ev }));
}

/* --------------------------------- main -------------------------------- */

const handlers = { launch, doctor, drive, evidence, cleanup };
if (!command || !handlers[command]) {
  console.error(
    "usage: control-contexttrail <launch|doctor|drive|evidence|cleanup> [args]\n" +
      "  drive <landing|upload|investigation|result> --run-id <id>",
  );
  process.exit(2);
}
handlers[command]().catch((err) => {
  console.error(`control-contexttrail ${command} failed:`, err.message ?? err);
  process.exit(1);
});
