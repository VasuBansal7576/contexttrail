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
import zlib from "node:zlib";
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

/** OS process signature for PID-reuse guarding: process start time. argv
 *  is deliberately excluded — npm re-execs itself between spawn and
 *  steady-state, which would false-positive as a different process. A
 *  recycled PID always has a different lstart. */
function pidSignature(pid) {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
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

  // Write the manifest BEFORE the expensive steps so a failed launch is
  // still cleanable (snapshot/scratch removal) and diagnosable.
  writeManifest(runId, {
    runId,
    port,
    url: `http://127.0.0.1:${port}`,
    revision: sha,
    sourceCheckout: checkout,
    snapshot: snap,
    live,
    startedAt: new Date().toISOString(),
    lockfileSha: crypto.createHash("sha256").update(fs.readFileSync(path.join(snap, "package-lock.json"))).digest("hex").slice(0, 16),
    node: process.version,
    stage: "install",
    ready: false,
  });

  const installLog = fs.openSync(path.join(logDir, "install.log"), "w");
  execFileSync("npm", ["ci"], { cwd: snap, stdio: ["ignore", installLog, installLog] });
  writeManifest(runId, { stage: "build" });
  const buildLog = fs.openSync(path.join(logDir, "build.log"), "w");
  execFileSync("npm", ["run", "build"], { cwd: snap, stdio: ["ignore", buildLog, buildLog] });
  const buildId = fs.readFileSync(path.join(snap, ".next", "BUILD_ID"), "utf8").trim();
  writeManifest(runId, { buildId, stage: "start" });

  const serverLog = fs.openSync(path.join(logDir, "server.log"), "w");
  const child = spawn("npm", ["start", "--", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: snap,
    detached: true,
    stdio: ["ignore", serverLog, serverLog],
    env: { ...process.env, NODE_ENV: "production" },
  });
  child.unref();
  writeManifest(runId, {
    pid: child.pid,
    pidSig: pidSignature(child.pid),
    pgid: child.pid, // detached: the npm process leads its own process group
    stage: "started",
  });

  const url = `http://127.0.0.1:${port}`;
  const ok = await waitReady(url);
  writeManifest(runId, { ready: ok, stage: ok ? "ready" : "failed" });
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
  const sig = pidSignature(m.pid);
  // Current format: lstart only. Legacy manifests stored "lstart args" —
  // a prefix match still proves the same process incarnation.
  return sig === m.pidSig || m.pidSig.startsWith(`${sig} `);
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
const RESULT_TABS = ["Overview", "Timeline", "Sources", "Analysis"];

/** Per-feature executable contract: which options exist, which values are
 *  supported, and which are accepted-but-rejected with an honest error. */
const FEATURE_SPECS = {
  landing: { options: [] },
  upload: {
    options: ["entry", "case"],
    entries: ["browse", "keyboard", "drop", "paste", "setinputfiles"],
    cases: ["valid", "unsupported", "empty", "decode", "oversize", "replace", "remove", "claim-limit"],
    defaultEntry: "browse",
    defaultCase: "valid",
  },
  investigation: {
    options: ["mode", "case", "delay-ms"],
    modes: ["trace", "claim"],
    defaultMode: "trace",
    defaultCase: (mode) => `controlled-${mode}`,
    anyFixtureCase: true,
  },
  result: {
    options: ["case", "view"],
    views: ["overview", "timeline", "sources", "analysis"],
    defaultView: "overview",
    defaultCase: "controlled-claim",
    anyFixtureCase: true,
  },
  viewer: {
    options: ["entry", "case"],
    entries: ["timeline", "sources", "takeaway"],
    cases: ["image-load", "image-fail", "no-excerpt", "pair"],
    notImplementedCases: { pair: "no linked-pair viewer entry exists in the product yet (map: viewer-conclusion pending)" },
    defaultEntry: "timeline",
    defaultCase: "image-load",
  },
  session: {
    options: ["case"],
    cases: ["refresh", "back", "new", "cancel", "fatal-retry"],
    defaultCase: "refresh",
  },
  accessibility: { options: [] },
};

/** Hard drive failure — caught by the drive wrapper so console/shot capture
 *  still happens, unlike fail() which exits the process immediately. */
function assertDrive(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function fixtureNames() {
  return fs
    .readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".ndjson"))
    .map((f) => f.replace(/\.ndjson$/, ""));
}

/** Validate every drive option BEFORE the browser opens — unsupported
 *  combinations are rejected, never silently ignored. */
function validateDriveOptions(feature) {
  const spec = FEATURE_SPECS[feature];
  if (!spec) fail(`unknown drive feature ${feature} (implemented: ${Object.keys(FEATURE_SPECS).join(", ")})`);
  const unknown = Object.keys(flags).filter(
    (k) => !["checkout", "run-id", "viewport", "live", "no-video", "expect-revision", "revision", "port"].includes(k) &&
      !spec.options.includes(k),
  );
  if (unknown.length) fail(`unsupported option(s) for ${feature}: ${unknown.map((k) => `--${k}`).join(", ")}`);
  if (flags.viewport !== undefined && !VIEWPORTS[flags.viewport]) {
    fail(`unsupported --viewport ${flags.viewport} (supported: ${Object.keys(VIEWPORTS).join("|")})`);
  }
  if (spec.entries && flags.entry !== undefined && !spec.entries.includes(flags.entry)) {
    fail(`unsupported --entry ${flags.entry} for ${feature} (supported: ${spec.entries.join("|")})`);
  }
  if (spec.cases && flags.case !== undefined && !spec.cases.includes(flags.case)) {
    fail(`unsupported --case ${flags.case} for ${feature} (supported: ${spec.cases.join("|")})`);
  }
  if (spec.notImplementedCases?.[flags.case]) {
    fail(`NOT IMPLEMENTED: --case ${flags.case} — ${spec.notImplementedCases[flags.case]}`);
  }
  if (spec.anyFixtureCase && flags.case !== undefined && !fixtureNames().includes(flags.case)) {
    fail(`unknown fixture case ${flags.case} (available: ${fixtureNames().join(", ") || "none"})`);
  }
  if (spec.modes && flags.mode !== undefined && !spec.modes.includes(flags.mode)) {
    fail(`unsupported --mode ${flags.mode} (supported: ${spec.modes.join("|")})`);
  }
  if (spec.views && flags.view !== undefined && !spec.views.includes(flags.view)) {
    fail(`unsupported --view ${flags.view} (supported: ${spec.views.join("|")})`);
  }
  if (flags.live && !["investigation", "result"].includes(feature)) {
    fail(`--live is only valid for investigation|result drives`);
  }
  return spec;
}

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

/* --------------------------- crc32/png helpers -------------------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

/** A valid but near-incompressible noise PNG — exercises the client's
 *  >450 KB preprocessing rejection path for the `oversize` case. */
function noisePng(width, height) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor RGB
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const o = y * (1 + width * 3);
    raw[o] = 0; // filter: none
    crypto.randomFillSync(raw, o + 1, width * 3);
  }
  const idat = zlib.deflateSync(raw, { level: 0 });
  return Buffer.concat([sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))]);
}

/* ------------------------------ drive io ------------------------------- */

/** Scratch files used by upload drives — generated media, never user data. */
function uploadFileSet(runId) {
  const dir = path.join(runDir(runId), "scratch");
  fs.mkdirSync(dir, { recursive: true });
  const defs = {
    "upload.png": { data: PNG_1PX, mime: "image/png" },
    "upload-2.png": { data: PNG_1PX, mime: "image/png" },
    "notes.txt": { data: Buffer.from("this is not an image\n"), mime: "text/plain" },
    "empty.png": { data: Buffer.alloc(0), mime: "image/png" },
    "corrupt.png": { data: Buffer.from("definitely not a png"), mime: "image/png" },
    "noise.png": { data: noisePng(2800, 2800), mime: "image/png" },
  };
  const out = {};
  for (const [name, { data, mime }] of Object.entries(defs)) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) fs.writeFileSync(p, data);
    out[name] = { path: p, mime };
  }
  return out;
}

/**
 * Deliver a file through a real upload entry point.
 * - browse: click the visible label and answer the real file chooser event.
 * - keyboard: focus the input and press Enter; the real chooser must open.
 * - drop: dispatch a genuine DataTransfer drop on the dropzone.
 * - paste: dispatch a genuine ClipboardEvent carrying a File.
 * - setinputfiles: direct input assignment (honest label; no chooser proof).
 */
async function applyUploadEntry(page, entry, file) {
  const b64 = () => fs.readFileSync(file.path).toString("base64");
  const fileName = path.basename(file.path);
  switch (entry) {
    case "browse": {
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: 10_000 }),
        page.locator('label[for="ct-image-input"]').click(),
      ]);
      await chooser.setFiles(file.path);
      return { chooserSeen: true };
    }
    case "keyboard": {
      await page.locator("#ct-image-input").focus();
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: 10_000 }),
        page.keyboard.press("Enter"),
      ]);
      await chooser.setFiles(file.path);
      return { chooserSeen: true };
    }
    case "drop":
    case "paste": {
      // The app's listeners attach after hydration — dispatching before
      // that loses the event, so retry like a real user until the preview
      // appears (bounded; a real miss still fails below).
      const b64Data = b64();
      const preview = page.locator('img[alt^="Selected image preview"]');
      let delivered = false;
      for (let attempt = 0; attempt < 10 && !delivered; attempt++) {
        await page.evaluate(
          ([b64, name, mime, kind]) => {
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const dt = new DataTransfer();
            dt.items.add(new File([bytes], name, { type: mime }));
            if (kind === "drop") {
              const zone = document.getElementById("ct-image-input").parentElement;
              zone.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
            } else {
              // ClipboardEventInit.clipboardData is unreliable in Chromium —
              // a plain Event carrying the property reaches the same handler.
              const ev = new Event("paste", { bubbles: true, cancelable: true });
              ev.clipboardData = dt;
              window.dispatchEvent(ev);
            }
          },
          [b64Data, fileName, file.mime, entry],
        );
        delivered = await preview.isVisible().catch(() => false);
        if (!delivered) await delay(400);
      }
      return entry === "drop" ? { dataTransferUsed: true } : { clipboardEventUsed: true };
    }
    case "setinputfiles":
      await page.setInputFiles("#ct-image-input", file.path);
      return { setInputFilesOnly: true };
    default:
      fail(`unsupported --entry ${entry}`);
  }
}

async function expectSelectedPreview(page, fileName = null) {
  const img = page.locator('img[alt^="Selected image preview"]');
  await img.waitFor({ timeout: 10_000 });
  if (fileName) {
    const alt = await img.getAttribute("alt");
    assertDrive(alt?.includes(fileName), `expected selected preview for ${fileName}, got "${alt}"`);
  }
  return img;
}

function submitButton(page) {
  return page.getByRole("button", { name: /start investigation/i });
}

async function expectUploadError(page, pattern) {
  // Exclude Next's route announcer (role=alert, always empty). Upload
  // errors render as p[role=alert]; stream failures as div[role=alert].
  const alert = page.locator('[role="alert"]:not(#__next-route-announcer__)');
  await alert.first().waitFor({ timeout: 25_000 });
  const texts = await alert.allTextContents();
  const hit = texts.find((t) => pattern.test(t));
  assertDrive(hit !== undefined, `expected alert matching ${pattern}, got ${JSON.stringify(texts.map((t) => t.slice(0, 120)))}`);
}

/**
 * Terminal result = the completed report, not progressive copy. Requires the
 * result tablist and the overview section — a bare "Investigation" string
 * match can fire while the stream is still open.
 */
async function waitForTerminalResult(page, timeoutMs = 30_000) {
  await page.waitForSelector('[aria-label="Result views"]', { timeout: timeoutMs });
  await page.waitForSelector('[aria-label="Investigation result"]', { timeout: timeoutMs });
}

/** Click a result tab and prove it became the selected tab. */
async function selectTab(page, name) {
  const tab = page.getByRole("tab", { name: new RegExp(`^${name}$`, "i") });
  assertDrive((await tab.count()) > 0, `required result tab missing: ${name}`);
  await tab.first().click();
  await delay(250);
  assertDrive((await tab.first().getAttribute("aria-selected")) === "true", `tab ${name} did not become selected`);
}

/** Intercept POST /api/investigate with a controlled public-contract stream.
 *  delayMs defers the response so cancellation/failure flows have time. */
async function stubInvestigation(page, fixtureName, { delayMs = 0 } = {}) {
  const body = fs.readFileSync(fixturePath(fixtureName));
  await page.route("**/api/investigate", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    if (delayMs > 0) await delay(delayMs);
    return route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body,
    });
  });
}

async function submitUpload(page, runId, { claim = null, entry = "setinputfiles" } = {}) {
  const files = uploadFileSet(runId);
  await page.goto(`${readManifest(runId).url}/investigate`, { waitUntil: "domcontentloaded" });
  await applyUploadEntry(page, entry, files["upload.png"]);
  await expectSelectedPreview(page, "upload.png");
  if (claim) await page.locator("#ct-claim").fill(claim);
}

async function drive() {
  const feature = positional[1];
  const runId = required("run-id");
  const spec = validateDriveOptions(feature);
  const m = readManifest(runId);
  if (!m) fail(`no manifest for run-id ${runId}`);
  if (!pidIsOwned(m)) fail(`server pid ${m.pid} is not alive (or was reused) — relaunch`);
  const viewport = flags.viewport ?? "desktop";
  const live = flags.live === true;
  if (live && process.env.RUN_LIVE_TESTS !== "1") fail("--live requires RUN_LIVE_TESTS=1");
  const tier = live ? "live" : "public-contract-boundary";

  const { browser, context, page, consoleErrors } = await openSession(m, runId, viewport);
  const t0 = Date.now();
  const record = (extra) => evidenceRecord(runId, { feature, viewport, ...extra });
  try {
    switch (feature) {
      case "landing": {
        // Listener attaches BEFORE navigation: any provider request during
        // load or CTA clicks is a hard failure, not just recorded data.
        let apiHit = false;
        page.on("request", (r) => {
          if (r.url().includes("/api/investigate")) apiHit = true;
        });
        await page.goto(m.url, { waitUntil: "networkidle" });
        await shot(page, runId, "landing-hero");
        await aria(page, runId, "landing");
        assertDrive(!apiHit, "/api/investigate fired during landing load");
        const ctas = page.getByRole("link", { name: /start investigating/i });
        const ctaCount = await ctas.count();
        assertDrive(ctaCount > 0, "no 'Start investigating' CTA on landing");
        const destinations = [];
        for (let i = 0; i < ctaCount; i++) {
          await ctas.nth(i).click();
          await page.waitForURL(/\/investigate/, { timeout: 10_000 });
          destinations.push(page.url());
          if (i < ctaCount - 1) await page.goto(m.url, { waitUntil: "domcontentloaded" });
        }
        assertDrive(!apiHit, "/api/investigate fired while following landing CTAs");
        await shot(page, runId, "landing-cta-destination");
        // Section anchors must point at real sections.
        const hrefs = await page
          .locator('a[href^="#"], a[href^="/#"]')
          .evaluateAll((els) => els.map((e) => e.getAttribute("href")).filter(Boolean));
        const anchors = {};
        for (const href of [...new Set(hrefs)]) {
          const sel = href.replace(/^\//, "");
          anchors[href] = await page.evaluate((s) => {
            try {
              return !!document.querySelector(s);
            } catch {
              return false;
            }
          }, sel);
        }
        for (const [href, ok] of Object.entries(anchors)) {
          assertDrive(ok, `landing anchor ${href} has no target section`);
        }
        record({ entry: "cta", case: null, tier: "real-ui", apiRequestFromLanding: apiHit, ctaCount, destinations, anchors });
        break;
      }

      case "upload": {
        const entry = flags.entry ?? spec.defaultEntry;
        const uc = flags.case ?? spec.defaultCase;
        const files = uploadFileSet(runId);
        await page.goto(`${m.url}/investigate`, { waitUntil: "domcontentloaded" });
        const submit = submitButton(page);
        const out = { entry, case: uc, tier: "real-ui" };

        const caseFile = {
          valid: "upload.png",
          unsupported: "notes.txt",
          empty: "empty.png",
          decode: "corrupt.png",
          oversize: "noise.png",
          replace: "upload.png",
          remove: "upload.png",
          "claim-limit": "upload.png",
        }[uc];
        const entryInfo = await applyUploadEntry(page, entry, files[caseFile]);
        Object.assign(out, entryInfo);

        switch (uc) {
          case "valid": {
            await expectSelectedPreview(page, "upload.png");
            assertDrive(await submit.isEnabled(), "submit not enabled after valid selection");
            break;
          }
          case "unsupported": {
            await expectUploadError(page, /unsupported file/i);
            assertDrive(!(await submit.isEnabled()), "submit enabled after unsupported file");
            break;
          }
          case "empty":
          case "decode": {
            await expectSelectedPreview(page, caseFile);
            await page.locator("#ct-claim").fill("claim must survive the decode failure");
            await submit.click();
            await expectUploadError(page, /could not be decoded/i);
            assertDrive((await page.locator("#ct-claim").inputValue()).length > 0, "claim lost after decode failure");
            break;
          }
          case "oversize": {
            await expectSelectedPreview(page, "noise.png");
            await submit.click();
            await expectUploadError(page, /could not be compressed|smaller image/i);
            break;
          }
          case "replace": {
            await expectSelectedPreview(page, "upload.png");
            const [chooser] = await Promise.all([
              page.waitForEvent("filechooser", { timeout: 10_000 }),
              page.getByRole("button", { name: "Replace", exact: true }).click(),
            ]);
            await chooser.setFiles(files["upload-2.png"].path);
            await expectSelectedPreview(page, "upload-2.png");
            break;
          }
          case "remove": {
            await expectSelectedPreview(page, "upload.png");
            await page.locator("#ct-claim").fill("claim kept after remove");
            await page.getByRole("button", { name: "Remove" }).click();
            assertDrive(!(await submit.isEnabled()), "submit still enabled after remove");
            assertDrive((await page.locator("#ct-claim").inputValue()).length > 0, "claim lost after remove");
            await page.locator('label[for="ct-image-input"]').waitFor({ timeout: 5_000 });
            break;
          }
          case "claim-limit": {
            await expectSelectedPreview(page, "upload.png");
            const over = "x".repeat(600);
            await page.locator("#ct-claim").fill(over);
            const value = await page.locator("#ct-claim").inputValue();
            assertDrive(value.length === 500, `claim cap expected 500 chars, got ${value.length}`);
            break;
          }
        }
        await shot(page, runId, `upload-${entry}-${uc}`);
        await aria(page, runId, `upload-${entry}-${uc}`);
        record(out);
        break;
      }

      case "investigation": {
        const mode = flags.mode ?? spec.defaultMode;
        const caseName = flags.case ?? spec.defaultCase(mode);
        const delayMs = Number(flags["delay-ms"] ?? 0);
        // Controlled streams fulfill almost instantly — hold the response
        // briefly (default 1200ms, overridable) so the progressive surface
        // provably renders before the terminal result. Live runs are untouched.
        const effectiveDelay = live ? 0 : Math.max(delayMs, 1200);
        if (!live) await stubInvestigation(page, caseName, { delayMs: effectiveDelay });
        await submitUpload(page, runId, { claim: mode === "claim" ? "controlled claim text" : null });
        await submitButton(page).click();
        // Progressive surface must appear before the terminal result.
        await page.getByRole("button", { name: /cancel investigation/i }).waitFor({ timeout: 15_000 });
        await page.getByText(/tracing the web/i).waitFor({ timeout: 15_000 });
        await shot(page, runId, `investigation-${mode}-progress`);
        await waitForTerminalResult(page, live ? 95_000 : Math.max(30_000, effectiveDelay + 30_000));
        await shot(page, runId, `investigation-${mode}-result`);
        await aria(page, runId, `investigation-${mode}-result`);
        record({
          entry: "setinputfiles", mode, case: live ? "live" : caseName, tier,
          delayMs: effectiveDelay || undefined, progressiveSeen: true, elapsedMs: Date.now() - t0,
        });
        break;
      }

      case "result": {
        const caseName = flags.case ?? spec.defaultCase;
        const view = flags.view ?? spec.defaultView;
        if (!live) await stubInvestigation(page, caseName);
        await submitUpload(page, runId, { claim: "controlled claim text" });
        await submitButton(page).click();
        await waitForTerminalResult(page, live ? 95_000 : 30_000);
        // Every mapped tab is required — missing tabs fail, they are not skipped.
        const seen = {};
        for (const name of RESULT_TABS) {
          await selectTab(page, name);
          seen[name] = true;
          await shot(page, runId, `result-${name.toLowerCase()}`);
        }
        // The requested --view must end up selected and asserted.
        await selectTab(page, view[0].toUpperCase() + view.slice(1));
        await aria(page, runId, `result-${view}`);
        record({ entry: "setinputfiles", view, case: live ? "live" : caseName, tier, tabsSeen: seen });
        break;
      }

      case "viewer": {
        const entry = flags.entry ?? spec.defaultEntry;
        const vcase = flags.case ?? spec.defaultCase;
        const fixture = vcase === "image-load" || vcase === "no-excerpt" ? "controlled-viewer" : "controlled-claim";
        await stubInvestigation(page, fixture);
        await submitUpload(page, runId, { claim: "controlled claim text" });
        await submitButton(page).click();
        await waitForTerminalResult(page);
        // Open the viewer through the mapped entry point.
        if (entry === "timeline") {
          await selectTab(page, "Timeline");
          const btn = page.getByRole("button", { name: /inspect evidence/i }).first();
          assertDrive((await btn.count()) > 0, "no Inspect evidence button on Timeline");
          await btn.click();
        } else if (entry === "sources") {
          await selectTab(page, "Sources");
          const btn = page.getByRole("button", { name: /inspect/i }).first();
          assertDrive((await btn.count()) > 0, "no Inspect button on Sources");
          await btn.click();
        } else {
          const btn = page.locator('[aria-label="Key takeaways"]').getByRole("button", { name: /view evidence/i }).first();
          assertDrive((await btn.count()) > 0, "no takeaway 'View evidence' button — fixture produced no takeaways");
          await btn.click();
        }
        const dialog = page.locator('[role="dialog"]');
        await dialog.waitFor({ timeout: 10_000 });
        // The retrieved image must resolve one way or the other — real load
        // or the explicit failure state, never a silent blank.
        const retrievedImg = dialog.locator('img[alt^="Retrieved image"]');
        const fallback = dialog.getByText(/retrieved image unavailable/i);
        await Promise.race([
          retrievedImg.waitFor({ timeout: 15_000 }).catch(() => {}),
          fallback.waitFor({ timeout: 15_000 }).catch(() => {}),
        ]);
        if (vcase === "image-load") {
          // The first item may legitimately be a failed remote image —
          // walk until one retrieved image actually finishes loading.
          const nextBtn = page.getByRole("button", { name: "Next evidence" });
          let loaded = await retrievedImg
            .evaluate((el) => el.complete && el.naturalWidth > 0)
            .catch(() => false);
          for (let i = 0; i < 20 && !loaded && (await nextBtn.isEnabled()); i++) {
            await nextBtn.click();
            await delay(300);
            loaded = await retrievedImg
              .evaluate((el) => el.complete && el.naturalWidth > 0)
              .catch(() => false);
          }
          assertDrive(loaded, "no retrieved image finished loading across all items");
        } else if (vcase === "image-fail") {
          await fallback.waitFor({ timeout: 15_000 });
          assertDrive(await dialog.locator('img[alt^="Retrieved image"]').count() === 0, "broken retrieved <img> still rendered");
        } else if (vcase === "no-excerpt") {
          // Walk items until one shows the explicit no-excerpt state.
          const next = page.getByRole("button", { name: "Next evidence" });
          let found = await dialog.getByText(/no excerpt available/i).count();
          for (let i = 0; i < 20 && !found && (await next.isEnabled()); i++) {
            await next.click();
            await delay(200);
            found = await dialog.getByText(/no excerpt available/i).count();
          }
          assertDrive(found > 0, "no item in fixture reached the no-excerpt state");
        }
        // Navigation both directions.
        const next = page.getByRole("button", { name: "Next evidence" });
        const prev = page.getByRole("button", { name: "Previous evidence" });
        const counter = dialog.getByText(/^\d+ of \d+$/);
        if (await next.isEnabled()) {
          const before = await counter.textContent();
          await next.click();
          await delay(200);
          assertDrive((await counter.textContent()) !== before, "Next did not change evidence position");
          await prev.click();
          await delay(200);
          assertDrive((await counter.textContent()) === before, "Previous did not restore evidence position");
        }
        // Mobile image toggle is required on narrow viewports.
        if (viewport === "mobile") {
          assertDrive((await dialog.getByRole("button", { name: "submitted image" }).count()) > 0, "mobile submitted/retrieved toggle missing");
        }
        // Source link: real href, new tab, noopener.
        const src = dialog.getByRole("link", { name: /open original source/i });
        assertDrive((await src.count()) > 0, "no Open original source link in viewer");
        const href = await src.getAttribute("href");
        const rel = (await src.getAttribute("rel")) ?? "";
        const target = await src.getAttribute("target");
        assertDrive(/^https?:\/\//.test(href ?? ""), `source link href is not a URL: ${href}`);
        assertDrive(target === "_blank" && rel.includes("noopener"), `source link must open a new noopener tab (target=${target} rel=${rel})`);
        // Technical details are real fields only.
        await dialog.getByText("Technical details").click();
        assertDrive((await dialog.locator("dd").count()) > 0, "technical details opened with no fields");
        // Escape closes; focus-restore target is recorded honestly.
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden", timeout: 10_000 });
        const focusAfter = await page.evaluate(() => {
          const el = document.activeElement;
          return el ? { tag: el.tagName, label: el.getAttribute("aria-label"), role: el.getAttribute("role") } : null;
        });
        await shot(page, runId, `viewer-${entry}-${vcase}`);
        record({ entry, case: vcase, tier, fixture, focusAfterClose: focusAfter });
        break;
      }

      case "session": {
        const scase = flags.case ?? spec.defaultCase;
        switch (scase) {
          case "new": {
            await stubInvestigation(page, "controlled-claim");
            await submitUpload(page, runId, { claim: "controlled claim text" });
            await submitButton(page).click();
            await waitForTerminalResult(page);
            await page.getByRole("button", { name: "New investigation" }).click();
            await page.locator('label[for="ct-image-input"]').waitFor({ timeout: 10_000 });
            assertDrive((await page.locator("#ct-claim").inputValue()) === "", "claim not cleared by New investigation");
            assertDrive((await page.locator('img[alt^="Selected image preview"]').count()) === 0, "image not cleared by New investigation");
            break;
          }
          case "back": {
            // Real history: land first, then arrive at /investigate the way
            // a user does before pressing browser Back.
            await page.goto(m.url, { waitUntil: "domcontentloaded" });
            await page.getByRole("link", { name: /start investigating/i }).first().click();
            await page.waitForURL(/\/investigate/, { timeout: 10_000 });
            await page.goBack();
            await page.waitForURL(new RegExp(`${m.url}/?$`), { timeout: 10_000 });
            await page.getByRole("link", { name: /start investigating/i }).first().waitFor({ timeout: 10_000 });
            break;
          }
          case "refresh": {
            await stubInvestigation(page, "controlled-claim");
            await submitUpload(page, runId, { claim: "controlled claim text" });
            await submitButton(page).click();
            await waitForTerminalResult(page);
            await page.reload({ waitUntil: "domcontentloaded" });
            // In-memory flow: a reload must land on a usable screen. Record
            // exactly which surface appears rather than assuming persistence.
            await Promise.race([
              page.locator('label[for="ct-image-input"]').waitFor({ timeout: 10_000 }).catch(() => {}),
              page.waitForSelector('[aria-label="Result views"]', { timeout: 10_000 }).catch(() => {}),
            ]);
            const resultPersisted = (await page.locator('[aria-label="Result views"]').count()) > 0;
            const uploadShown = (await page.locator('label[for="ct-image-input"]').count()) > 0;
            assertDrive(resultPersisted || uploadShown, "refresh left neither a result nor an upload screen");
            record({ entry: null, case: scase, tier, resultPersisted });
            break;
          }
          case "cancel": {
            await stubInvestigation(page, "controlled-claim", { delayMs: 20_000 });
            await submitUpload(page, runId, { claim: "claim kept through cancel" });
            await submitButton(page).click();
            await page.getByRole("button", { name: /cancel investigation/i }).click();
            await page.getByText(/investigation cancelled/i).waitFor({ timeout: 15_000 });
            await shot(page, runId, "session-cancel");
            await page.getByRole("button", { name: /return to upload/i }).click();
            await expectSelectedPreview(page, "upload.png");
            assertDrive((await page.locator("#ct-claim").inputValue()).length > 0, "claim lost after cancel → return");
            break;
          }
          case "fatal-retry": {
            await page.route("**/api/investigate", (route) =>
              route.request().method() === "POST"
                ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"controlled failure"}' })
                : route.continue(),
            );
            await submitUpload(page, runId, { claim: "claim kept through failure" });
            await submitButton(page).click();
            await expectUploadError(page, /investigation interrupted/i);
            await page.getByRole("button", { name: /return to upload/i }).click();
            await expectSelectedPreview(page, "upload.png");
            assertDrive((await page.locator("#ct-claim").inputValue()).length > 0, "claim lost after fatal → return");
            break;
          }
        }
        await shot(page, runId, `session-${scase}`);
        await aria(page, runId, `session-${scase}`);
        if (scase !== "refresh") record({ entry: null, case: scase, tier: "real-ui" });
        break;
      }

      case "accessibility": {
        await page.goto(`${m.url}/investigate`, { waitUntil: "domcontentloaded" });
        const violations = [];
        // Keyboard: essential controls reachable by Tab within a bound.
        const focusSeq = [];
        for (let i = 0; i < 14; i++) {
          await page.keyboard.press("Tab");
          focusSeq.push(
            await page.evaluate(() => {
              const el = document.activeElement;
              return el ? { tag: el.tagName, id: el.id || null, label: el.getAttribute("aria-label"), text: (el.textContent || "").trim().slice(0, 50) } : null;
            }),
          );
        }
        if (!focusSeq.some((s) => s && s.id === "ct-claim")) {
          violations.push("claim textarea unreachable by Tab within 14 presses");
        }
        if (!focusSeq.some((s) => s && s.tag === "A")) {
          violations.push("no link reachable by Tab within 14 presses");
        }
        // No horizontal overflow at the chosen viewport.
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (overflow > 1) violations.push(`horizontal overflow ${overflow}px`);
        // Primary action meets the 44px target floor.
        const submitH = (await submitButton(page).boundingBox())?.height ?? 0;
        if (submitH < 44) violations.push(`submit target ${submitH}px < 44px`);
        // Recorded-only measurements: contrast input, focus visibility,
        // sessionStorage key names (never image bytes/values).
        const contrastInput = await page.evaluate(() => {
          const h1 = document.querySelector("h1");
          const cs = h1 ? getComputedStyle(h1) : null;
          return cs ? { color: cs.color, fontSize: cs.fontSize, fontWeight: cs.fontWeight } : null;
        });
        const sessionKeys = await page.evaluate(() => Object.keys(sessionStorage));
        fs.writeFileSync(
          path.join(evidenceDir(runId), `accessibility-${viewport}.json`),
          JSON.stringify({ viewport, focusSeq, overflow, submitTargetPx: submitH, contrastInput, sessionKeys, violations }, null, 2),
        );
        await shot(page, runId, `accessibility-${viewport}`);
        await aria(page, runId, `accessibility-${viewport}`);
        record({ entry: "keyboard", case: null, tier: "real-ui", violations });
        assertDrive(violations.length === 0, `accessibility violations: ${violations.join("; ")}`);
        break;
      }
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
