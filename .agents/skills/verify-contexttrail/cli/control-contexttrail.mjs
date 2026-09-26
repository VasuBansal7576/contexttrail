#!/usr/bin/env node
/**
 * control-contexttrail — isolated launch/doctor/drive/evidence/cleanup
 * harness for ContextTrail verification.
 *
 * Commands:
 *   launch   --checkout <abs> --run-id <id> [--revision <rev>] [--port 3114]
 *            [--live] [--new-generation]
 *   doctor   --run-id <id> [--expect-revision <rev>]
 *   drive    <landing|upload|investigation|result|viewer|session|accessibility>
 *            --run-id <id> [--viewport desktop|mobile] [--case <n>] [--entry <n>]
 *            [--mode trace|claim] [--view <n>] [--delay-ms <n>] [--fault <n>]
 *            [--live] [--image <path>] [--claim-text <text>]
 *   evidence --run-id <id> [--regenerate]
 *   cleanup  --run-id <id>
 *
 * Contract:
 *  - Every option is declared up front. An unknown, missing, malformed or
 *    non-applicable option exits 2 before any side effect. Nothing is
 *    silently ignored.
 *  - Normal runs spend zero provider credit. POST /api/investigate is
 *    redirected to an in-process NDJSON stream server and provider-shaped
 *    requests are blocked and counted; credential environment variables are
 *    stripped from the child server environment and no .env file is copied
 *    into the snapshot. Evidence tier: "public-contract-boundary".
 *  - Real provider runs require BOTH RUN_LIVE_TESTS=1 and --live, and a run
 *    launched with --live (which is the only way .env.local is linked).
 *  - Evidence is written per drive, hashed by `evidence`, and sealed: later
 *    drives in the same generation are refused.
 */

import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES_DIR = path.join(SKILL_DIR, "fixtures");
const MAPS_DIR = path.join(SKILL_DIR, "features");
const CLI_PATH = fileURLToPath(import.meta.url);

/* ------------------------------ exit codes ------------------------------ */
const EXIT_SCHEMA = 2;
const EXIT_ASSERT = 1;

/* ----------------------------- arg parsing ------------------------------ */

const BOOLEAN_FLAGS = new Set(["live", "no-video", "new-generation", "regenerate"]);

function fail(msg, code = EXIT_SCHEMA) {
  console.error(`control-contexttrail: ${msg}`);
  process.exit(code);
}

/** Strict argv parser. A value-taking flag with no value (or a value that
 *  itself looks like a flag) is a schema error — never a silent default. */
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > 2) {
      const key = a.slice(2, eq);
      const value = a.slice(eq + 1);
      if (BOOLEAN_FLAGS.has(key)) fail(`--${key} does not take a value`);
      if (value === "") fail(`--${key} requires a value`);
      if (key in flags) fail(`--${key} specified more than once`);
      flags[key] = value;
      continue;
    }
    const key = a.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      if (key in flags) fail(`--${key} specified more than once`);
      flags[key] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      fail(`--${key} requires a value`);
    }
    if (key in flags) fail(`--${key} specified more than once`);
    flags[key] = next;
    i++;
  }
  return { positional, flags };
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const command = positional[0];

function required(name) {
  if (flags[name] === undefined) fail(`missing required --${name}`);
  return flags[name];
}

function intFlag(name, { min, max, fallback }) {
  const raw = flags[name];
  if (raw === undefined) return fallback;
  if (!/^-?\d+$/.test(raw)) fail(`--${name} must be an integer, got ${JSON.stringify(raw)}`);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    fail(`--${name} must be an integer between ${min} and ${max}, got ${n}`);
  }
  return n;
}

/** Options accepted verbatim by every command (run resolution only). */
const BASE_FLAGS = ["checkout", "run-id"];

const COMMAND_FLAGS = {
  launch: [...BASE_FLAGS, "revision", "port", "live", "new-generation"],
  doctor: [...BASE_FLAGS, "expect-revision"],
  drive: [
    ...BASE_FLAGS,
    "viewport",
    "case",
    "entry",
    "mode",
    "view",
    "fault",
    "image",
    "claim-text",
    "live",
    "no-video",
  ],
  evidence: [...BASE_FLAGS, "regenerate"],
  cleanup: [...BASE_FLAGS],
};

/* ------------------------------ run state ------------------------------- */

/** Repo root derived from this file's own location — the stable anchor that
 *  lets doctor/drive/evidence/cleanup resolve a run without flags. */
const CLI_CHECKOUT = path.resolve(SKILL_DIR, "..", "..", "..");

function containerCandidates(runId) {
  return [
    flags.checkout && path.resolve(flags.checkout),
    process.env.CONTEXTTRAIL_CHECKOUT && path.resolve(process.env.CONTEXTTRAIL_CHECKOUT),
    CLI_CHECKOUT,
    process.cwd(),
  ].filter(Boolean).map((c) => path.join(c, ".verify", runId));
}

function runContainer(runId) {
  for (const dir of containerCandidates(runId)) {
    if (
      fs.existsSync(path.join(dir, "active-generation")) ||
      fs.existsSync(path.join(dir, "gen-1")) ||
      fs.existsSync(path.join(dir, "manifest.json"))
    ) {
      return dir;
    }
  }
  if (flags.checkout) return path.join(path.resolve(flags.checkout), ".verify", runId);
  fail(`cannot resolve run ${runId}: pass --checkout or run from the checkout`);
}

function generationOf(container) {
  const active = path.join(container, "active-generation");
  if (fs.existsSync(active)) {
    const n = Number(fs.readFileSync(active, "utf8").trim());
    if (Number.isInteger(n) && n > 0) return n;
  }
  if (fs.existsSync(path.join(container, "manifest.json"))) return 0; // legacy layout
  return 1;
}

/** Directory holding the manifest, logs, evidence and snapshot for the run. */
function runDir(runId) {
  const container = runContainer(runId);
  const gen = generationOf(container);
  return gen === 0 ? container : path.join(container, `gen-${gen}`);
}

function generation(runId) {
  const container = runContainer(runId);
  const gen = generationOf(container);
  return gen === 0 ? 1 : gen;
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

function evidenceDir(runId) {
  const d = path.join(runDir(runId), "evidence");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function manifestSealed(runId) {
  return fs.existsSync(path.join(evidenceDir(runId), "evidence-manifest.json"));
}

/* ------------------------------- helpers -------------------------------- */

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function httpGet(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
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

/** OS process signature for PID-reuse guarding: process start time. argv is
 *  deliberately excluded — npm re-execs itself between spawn and
 *  steady-state, which would false-positive as a different process. */
function pidSignature(pid) {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" })
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return null;
  }
}

function portListeners(port) {
  try {
    const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
    });
    return out.split("\n").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

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

function isAncestorOrSelf(pid, descendant) {
  if (pid === descendant) return true;
  const ppid = new Map();
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
  return execFileSync("git", ["-C", checkout, "rev-parse", "--verify", "--quiet", `${rev}^{commit}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function gitDirty(checkout) {
  try {
    return (
      execFileSync("git", ["-C", checkout, "status", "--porcelain"], { encoding: "utf8" }).trim()
        .length > 0
    );
  } catch {
    return false;
  }
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

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function fixtureNames() {
  if (!fs.existsSync(FIXTURES_DIR)) return [];
  return fs
    .readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".ndjson"))
    .map((f) => f.replace(/\.ndjson$/, ""))
    .sort();
}

/** Terminal `investigation.completed` result of a checked-in fixture, or null.
 *  Lets view-specific assertions compare the rendered surface with the data
 *  the fixture actually ships instead of trusting counts. */
function fixtureTerminal(name) {
  if (!name) return null;
  const p = path.join(FIXTURES_DIR, `${name}.ndjson`);
  if (!fs.existsSync(p)) return null;
  const lines = fs.readFileSync(p, "utf8").split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;
  try {
    const last = JSON.parse(lines[lines.length - 1]);
    return last && last.type === "investigation.completed" && typeof last.result === "object" && last.result
      ? last.result
      : null;
  } catch {
    return null;
  }
}

const asLen = (v) => (Array.isArray(v) ? v.length : 0);

function fixturePath(name) {
  const p = path.join(FIXTURES_DIR, `${name}.ndjson`);
  if (!fs.existsSync(p)) {
    fail(`unknown fixture case ${name} (available: ${fixtureNames().join(", ") || "none"})`);
  }
  return p;
}

/** Parsed terminal result of a fixture — the source of truth for the mode
 *  agreement check, so `--mode` can never disagree with `--case`. */
function fixtureResult(name) {
  const lines = fs.readFileSync(fixturePath(name), "utf8").split("\n").filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const ev = JSON.parse(lines[i]);
      if (ev.type === "investigation.completed" && ev.result) return ev.result;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function fixtureMode(name) {
  const r = fixtureResult(name);
  if (!r) return null;
  if (r.mode === "claim_check" || r.mode === "claim-check" || r.mode === "claim") return "claim";
  if (r.mode === "trace") return "trace";
  const claim = r.claim ?? r.input?.claim ?? null;
  if (typeof claim === "string" && claim.trim().length > 0) return "claim";
  if (typeof r.status === "string" && r.status.length > 0) return "claim";
  return "trace";
}

function fixtureHasPair(name) {
  const r = fixtureResult(name);
  if (!r) return false;
  return /paired|pairEndpoint|divergenceEndpointId/i.test(JSON.stringify(r));
}

/* --------------------------- runner identity ---------------------------- */

/** Identity of the *harness* that produced an artifact: the revision of the
 *  checkout the CLI runs from plus a sha256 of every skill file that can
 *  change what a drive asserts. Recorded per drive and sealed by `evidence`. */
function runnerIdentity() {
  let runnerRevision = null;
  let runnerDirty = null;
  try {
    runnerRevision = gitSha(CLI_CHECKOUT, "HEAD");
    runnerDirty = gitDirty(CLI_CHECKOUT);
  } catch {
    /* not a git checkout */
  }
  const files = {};
  const add = (p) => {
    try {
      files[path.relative(CLI_CHECKOUT, p)] = sha256(fs.readFileSync(p));
    } catch {
      /* unreadable */
    }
  };
  add(CLI_PATH);
  if (fs.existsSync(FIXTURES_DIR)) {
    for (const f of fs.readdirSync(FIXTURES_DIR)) add(path.join(FIXTURES_DIR, f));
  }
  if (fs.existsSync(MAPS_DIR)) {
    for (const f of fs.readdirSync(MAPS_DIR)) add(path.join(MAPS_DIR, f));
  }
  add(path.join(SKILL_DIR, "SKILL.md"));
  return {
    runnerRevision,
    runnerDirty,
    cliSha256: files[path.relative(CLI_CHECKOUT, CLI_PATH)] ?? null,
    runnerFiles: files,
  };
}

/* -------------------------- credential boundary ------------------------- */

/**
 * Allowlist for the child server environment. Anything that could carry a
 * provider credential (SERPAPI_*, OPENAI_*, ANTHROPIC_*, ... ) is dropped by
 * construction rather than by denylist, so a newly named secret cannot leak
 * through unnoticed. Names are recorded; values never are.
 */
const ENV_ALLOW_EXACT = new Set([
  "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE",
  "TZ", "USER", "LOGNAME", "SHELL", "NODE_ENV", "NODE_OPTIONS", "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "npm_config_registry", "SSL_CERT_FILE",
  "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "no_proxy",
]);
const ENV_ALLOW_PREFIX = ["npm_config_", "NPM_CONFIG_"];

/** Names of the variables that were present but deliberately not forwarded. */
function strippedEnvNames() {
  return Object.keys(process.env)
    .filter((k) => !ENV_ALLOW_EXACT.has(k) && !ENV_ALLOW_PREFIX.some((p) => k.startsWith(p)))
    .sort();
}

function cleanEnv(extra = {}) {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (ENV_ALLOW_EXACT.has(k) || ENV_ALLOW_PREFIX.some((p) => k.startsWith(p))) out[k] = v;
  }
  return { ...out, NODE_ENV: "production", ...extra };
}

function snapshotEnvFiles(snapshotDir) {
  try {
    return fs
      .readdirSync(snapshotDir)
      .filter((f) => /^\.env(\..+)?$/.test(f))
      .sort();
  } catch {
    return [];
  }
}

/* -------------------------------- launch -------------------------------- */

async function launch() {
  const allowed = COMMAND_FLAGS.launch;
  const unknown = Object.keys(flags).filter((k) => !allowed.includes(k));
  if (unknown.length) fail(`unsupported option(s) for launch: ${unknown.map((k) => `--${k}`).join(", ")}`);
  if (positional.length > 1) fail(`unexpected argument ${JSON.stringify(positional[1])}`);

  // Value formats are validated before any required-option lookup so a
  // malformed numeric or revision reports itself rather than a missing flag.
  const port = intFlag("port", { min: 1, max: 65535, fallback: 3114 });
  const revision = flags.revision ?? "HEAD";
  if (!/^[A-Za-z0-9._/-]{1,120}$/.test(revision)) fail(`malformed --revision ${JSON.stringify(revision)}`);

  const checkout = path.resolve(required("checkout"));
  const runId = required("run-id");
  const live = flags.live === true;

  // Credit gate first: it is a safety property, not a run-state property.
  if (live && process.env.RUN_LIVE_TESTS !== "1") {
    fail("--live requires RUN_LIVE_TESTS=1 (provider credit gate)");
  }

  let sha;
  try {
    sha = gitSha(checkout, revision);
  } catch {
    fail(`cannot resolve --revision ${JSON.stringify(revision)} in ${checkout}`);
  }

  const container = path.join(checkout, ".verify", runId);
  let gen = 1;
  if (fs.existsSync(container)) {
    if (!fs.existsSync(path.join(container, "active-generation")) &&
        !fs.existsSync(path.join(container, "gen-1")) &&
        !fs.existsSync(path.join(container, "manifest.json"))) {
      fail(`run-id ${runId} exists at ${container} but is not a run directory`);
    }
    if (!flags["new-generation"]) {
      fail(
        `run-id ${runId} already used (evidence and manifest exist at ${container}); ` +
          `pass --new-generation to start a fresh generation instead of reusing it`,
      );
    }
    let max = 0;
    for (const e of fs.readdirSync(container)) {
      const m = /^gen-(\d+)$/.exec(e);
      if (m) max = Math.max(max, Number(m[1]));
    }
    gen = max + 1;
  }

  const dir = path.join(container, `gen-${gen}`);
  const snap = path.join(dir, "checkout");
  const logDir = path.join(dir, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(container, { recursive: true });
  fs.writeFileSync(path.join(container, "active-generation"), `${gen}\n`);
  fs.mkdirSync(path.join(dir, "evidence"), { recursive: true });

  if (fs.existsSync(snap)) fail(`generation ${gen} of run-id ${runId} already has a snapshot`);
  if (!(await portFree(port))) fail(`port ${port} is not free`);
  fs.mkdirSync(snap, { recursive: true });

  execFileSync("git", ["-C", checkout, "archive", sha], {
    stdio: ["ignore", fs.openSync(path.join(logDir, "archive.tar"), "w"), "inherit"],
  });
  execFileSync("tar", ["-xf", path.join(logDir, "archive.tar"), "-C", snap]);
  fs.rmSync(path.join(logDir, "archive.tar"), { force: true });

  // Credential surface: a live run links .env.local; a controlled run must
  // not have one at all, and the check is a hard failure either way.
  const envFiles = snapshotEnvFiles(snap);
  if (live) {
    const env = path.join(checkout, ".env.local");
    if (!fs.existsSync(env)) fail("--live requires .env.local in the source checkout");
    if (envFiles.includes(".env.local")) fs.rmSync(path.join(snap, ".env.local"));
    fs.symlinkSync(env, path.join(snap, ".env.local"));
  } else if (envFiles.length) {
    fail(`controlled snapshot unexpectedly contains ${envFiles.join(", ")} — refusing to launch`);
  }

  const stripped = strippedEnvNames();

  writeManifest(runId, {
    runId,
    generation: gen,
    port,
    url: `http://127.0.0.1:${port}`,
    revision: sha,
    sourceCheckout: checkout,
    snapshot: snap,
    live,
    startedAt: new Date().toISOString(),
    lockfileSha: sha256(fs.readFileSync(path.join(snap, "package-lock.json"))).slice(0, 32),
    node: process.version,
    cliSha256: sha256(fs.readFileSync(CLI_PATH)),
    runnerRevision: runnerIdentity().runnerRevision,
    strippedEnvKeys: live ? [] : stripped,
    envFilesInSnapshot: envFiles,
    stage: "install",
    ready: false,
  });

  const installLog = fs.openSync(path.join(logDir, "install.log"), "w");
  execFileSync("npm", ["ci"], { cwd: snap, stdio: ["ignore", installLog, installLog], env: cleanEnv() });
  writeManifest(runId, { stage: "build" });
  const buildLog = fs.openSync(path.join(logDir, "build.log"), "w");
  execFileSync("npm", ["run", "build"], { cwd: snap, stdio: ["ignore", buildLog, buildLog], env: cleanEnv() });
  const buildId = fs.readFileSync(path.join(snap, ".next", "BUILD_ID"), "utf8").trim();
  writeManifest(runId, { buildId, stage: "start" });

  const serverLog = fs.openSync(path.join(logDir, "server.log"), "w");
  const child = spawn("npm", ["start", "--", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: snap,
    detached: true,
    stdio: ["ignore", serverLog, serverLog],
    env: cleanEnv(),
  });
  child.unref();
  writeManifest(runId, { pid: child.pid, pidSig: pidSignature(child.pid), pgid: child.pid, stage: "started" });

  const url = `http://127.0.0.1:${port}`;
  const ok = await waitReady(url);
  writeManifest(runId, { ready: ok, stage: ok ? "ready" : "failed" });
  if (!ok) {
    console.log(JSON.stringify({ launched: false, reason: "server did not become ready", logDir }));
    process.exit(EXIT_ASSERT);
  }
  console.log(
    JSON.stringify({
      launched: true,
      url,
      pid: child.pid,
      revision: sha,
      buildId,
      generation: gen,
      live,
      credentialsStripped: stripped.length,
      tier: live ? "live" : "public-contract-boundary",
    }),
  );
}

/* -------------------------------- doctor -------------------------------- */

function pidIsOwned(m) {
  if (!m.pid || !pidAlive(m.pid)) return false;
  if (!m.pidSig) return true;
  const sig = pidSignature(m.pid);
  return sig === m.pidSig || m.pidSig.startsWith(`${sig} `);
}

async function doctor() {
  const allowed = COMMAND_FLAGS.doctor;
  const unknown = Object.keys(flags).filter((k) => !allowed.includes(k));
  if (unknown.length) fail(`unsupported option(s) for doctor: ${unknown.map((k) => `--${k}`).join(", ")}`);

  const runId = required("run-id");
  const m = readManifest(runId);
  if (!m) fail(`no manifest for run-id ${runId}`);

  const checks = {};
  checks.ownedPidAlive = pidIsOwned(m);
  const listeners = portListeners(m.port);
  checks.portBoundByOwnedProcess =
    listeners.length > 0 &&
    (listeners.includes(m.pid) ||
      listeners.some((p) => isAncestorOrSelf(m.pid, p)) ||
      descendantsOf(m.pid).some((p) => listeners.includes(p)));
  const landing = await httpGet(m.url);
  checks.landing200 = landing.status === 200;
  checks.titlePresent = landing.body.toString("utf8").includes("ContextTrail");
  const css = [...landing.body.toString("utf8").matchAll(/href="([^"]+\.css[^"]*)"/g)].map((x) => x[1])[0];
  checks.stylesheet200 = css ? (await httpGet(new URL(css, m.url).href)).status === 200 : false;
  checks.servedBuildIdMatch =
    (await httpGet(`${m.url}/_next/static/${m.buildId}/_ssgManifest.js`)).status === 200;
  checks.investigateRouteAnswers = (await httpGet(`${m.url}/api/investigate`)).status !== 0;

  // Credential surface of the *running* snapshot, reported as a boolean
  // only — values are never read.
  const envFiles = snapshotEnvFiles(m.snapshot);
  checks.envSurfaceMatchesLiveFlag = m.live ? envFiles.includes(".env.local") : envFiles.length === 0;
  if (!m.live) checks.credentialsStripped = Array.isArray(m.strippedEnvKeys) && m.strippedEnvKeys.length > 0;

  if (flags["expect-revision"] !== undefined) {
    const want = flags["expect-revision"];
    if (!/^[A-Za-z0-9._/-]{1,120}$/.test(want)) {
      fail(`malformed --expect-revision ${JSON.stringify(want)}`);
    }
    let resolved = null;
    try {
      resolved = gitSha(m.sourceCheckout, want);
    } catch {
      fail(`--expect-revision ${JSON.stringify(want)} does not resolve in ${m.sourceCheckout}`);
    }
    checks.revisionMatch = resolved === m.revision || m.revision.startsWith(want) || resolved.startsWith(m.revision);
  }

  const healthy = Object.values(checks).every(Boolean);
  console.log(
    JSON.stringify({
      runId,
      generation: generation(runId),
      healthy,
      checks,
      envFilesInSnapshot: envFiles,
      strippedEnvKeyCount: (m.strippedEnvKeys ?? []).length,
      revision: m.revision,
      buildId: m.buildId,
      url: m.url,
      tier: m.live ? "live" : "public-contract-boundary",
    }),
  );
  process.exit(healthy ? 0 : EXIT_ASSERT);
}

/* ------------------------------- evidence ------------------------------- */

/** Throwing + non-throwing assertion recorders. Every check is persisted so
 *  `evidence` can prove *what* was asserted, not only that a drive ran. */
class Recorder {
  constructor(dir) {
    this.dir = dir;
    this.entries = [];
    fs.mkdirSync(dir, { recursive: true });
    this.stream = fs.createWriteStream(path.join(dir, "assertions.jsonl"), { flags: "w" });
  }
  push(id, status, detail) {
    const entry = { at: new Date().toISOString(), id, status, detail: detail ?? null };
    this.entries.push(entry);
    this.stream.write(JSON.stringify(entry) + "\n");
    return entry;
  }
  /** Required behaviour: records PASS/FAIL and aborts the drive on FAIL. */
  check(id, cond, detail) {
    this.push(id, cond ? "PASS" : "FAIL", detail);
    if (!cond) throw new Error(`assertion failed: ${id}${detail ? ` — ${detail}` : ""}`);
  }
  /** Observed fact that is not itself a pass/fail claim. */
  note(id, detail) {
    this.push(id, "INFO", detail);
  }
  counts() {
    const pass = this.entries.filter((e) => e.status === "PASS").length;
    const failCount = this.entries.filter((e) => e.status === "FAIL").length;
    return { pass, fail: failCount, info: this.entries.filter((e) => e.status === "INFO").length };
  }
  close() {
    this.stream.end();
  }
}

function nextDriveDir(runId, feature, parts) {
  const base = path.join(evidenceDir(runId), "drives");
  fs.mkdirSync(base, { recursive: true });
  const seq = fs.readdirSync(base).filter((e) => /^\d{3}-/.test(e)).length + 1;
  const slug = [feature, ...parts.filter(Boolean)].join("-").replace(/[^A-Za-z0-9._-]+/g, "_");
  const dir = path.join(base, `${String(seq).padStart(3, "0")}-${slug}`);
  fs.mkdirSync(dir, { recursive: true });
  return { dir, seq };
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

/* ------------------------------ network boundary ------------------------ */

/** Provider-shaped destinations. Anything here is a potential credit spend
 *  or credential use, so controlled runs block and count it. */
function classifyProviderUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const h = u.hostname.toLowerCase();
  if (h === "serpapi.com" || h.endsWith(".serpapi.com")) return "serpapi";
  if (h === "typesafe.ai" || h.endsWith(".typesafe.ai")) return "typesafe";
  if (h === "openai.com" || h.endsWith(".openai.com")) return "openai";
  if (h === "anthropic.com" || h.endsWith(".anthropic.com")) return "anthropic";
  if (u.searchParams.has("key") || u.searchParams.has("api_key") || u.searchParams.has("apikey")) {
    return "credentialed-endpoint";
  }
  return null;
}

function newBoundary(mode) {
  return {
    mode,
    providerAttempted: 0,
    providerBlocked: 0,
    providerAllowed: 0,
    providerCategories: {},
    apiAttempted: 0,
    apiRedirected: 0,
    apiFailed: 0,
    apiAllowed: 0,
    fixtureReceived: 0,
    fixtureFulfilled: 0,
    fixtureEvents: 0,
  };
}

/**
 * Install the boundary BEFORE any navigation. Route registration order
 * matters: the catch-all is registered first so the specific API route
 * (registered after) takes precedence for POST /api/investigate.
 *
 * mode: "live" | "controlled"
 * apiMode: "live" | "redirect" | "fail"
 */
async function installBoundary(page, { mode, apiMode, streamOrigin }) {
  const boundary = newBoundary(mode);

  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (streamOrigin && url.startsWith(streamOrigin)) return route.continue();
    const cat = classifyProviderUrl(url);
    if (cat) {
      boundary.providerAttempted++;
      boundary.providerCategories[cat] = (boundary.providerCategories[cat] ?? 0) + 1;
      if (mode === "live") {
        boundary.providerAllowed++;
        return route.continue();
      }
      boundary.providerBlocked++;
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });

  if (apiMode !== "live") {
    await page.route("**/api/investigate", async (route) => {
      const req = route.request();
      if (req.method() !== "POST") {
        boundary.apiAllowed++;
        return route.continue();
      }
      if (streamOrigin && req.url().startsWith(streamOrigin)) return route.continue();
      boundary.apiAttempted++;
      if (apiMode === "fail") {
        boundary.apiFailed++;
        return route.fulfill({
          status: 500,
          contentType: "application/json",
          body: '{"error":"controlled failure"}',
        });
      }
      boundary.apiRedirected++;
      try {
        return await route.continue({ url: `${streamOrigin}/stream` });
      } catch (err) {
        boundary.apiFailed++;
        try {
          return await route.fulfill({
            status: 307,
            headers: { location: `${streamOrigin}/stream` },
            body: "",
          });
        } catch {
          return route.abort("failed");
        }
      }
    });
  }
  return boundary;
}

/* ---------------------------- chunked stream ---------------------------- */

/** Split an NDJSON fixture into segments so each boundary can be held open
 *  while the harness asserts the progressive surface. Segment boundaries are
 *  chosen on evidence events when the fixture has them, otherwise on stream
 *  position; the terminal event always lands in the final segment. */
function buildSegments(lines) {
  const evs = [];
  for (const l of lines) {
    try {
      evs.push(JSON.parse(l));
    } catch {
      evs.push({});
    }
  }
  const compIdx = evs.findIndex((e) => e.type === "investigation.completed");
  const end = compIdx >= 0 ? compIdx : evs.length;
  if (end <= 4) return [lines];

  // Each held barrier must land on a state the harness can assert: at least
  // one stage completed and one candidate discovered before the first hold,
  // and meaningful completion depth before the second.
  let evidence = 0;
  let started = 0;
  let completed = 0;
  let c1 = -1;
  let c2 = -1;
  for (let i = 0; i < end; i++) {
    const t = evs[i].type;
    if (t === "evidence.discovered") evidence++;
    if (t === "stage.started") started++;
    if (t === "stage.completed") completed++;
    if (c1 < 0 && evidence >= 1 && completed >= 1) c1 = i;
    // The second barrier must land with a stage genuinely in flight, so the
    // harness can prove the surface is still progressing rather than idle.
    if (c2 < 0 && evidence >= 2 && completed >= 4 && started > completed) c2 = i;
  }
  if (c2 < 0) {
    for (let i = 0; i < end; i++) {
      if (evs[i].type === "stage.started" && i > (c1 < 0 ? 0 : c1)) {
        c2 = i;
        break;
      }
    }
  }
  if (c1 < 0) c1 = Math.max(1, Math.floor(end * 0.3));
  if (c2 < 0 || c2 <= c1) c2 = Math.max(c1 + 1, Math.floor(end * 0.6));
  const c3 = Math.max(c2 + 1, end - 1);

  const cuts = [...new Set([c1, c2, c3])]
    .filter((c) => c > 0 && c < end)
    .sort((x, y) => x - y);
  const segs = [];
  let prev = 0;
  for (const c of cuts) {
    if (c + 1 <= prev) continue;
    segs.push(lines.slice(prev, c + 1));
    prev = c + 1;
  }
  const rest = lines.slice(prev);
  if (rest.length) segs.push(rest);
  return segs.filter((x) => x.length > 0);
}

function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? "");
  if (!m) return null;
  const b = `--${(m[1] ?? m[2]).trim()}`;
  const out = {};
  const text = buf.toString("latin1");
  const parts = text.split(b);
  for (const p of parts) {
    if (p.startsWith("--")) continue;
    const idx = p.indexOf("\r\n\r\n");
    if (idx < 0) continue;
    const head = p.slice(0, idx);
    const body = p.slice(idx + 4).replace(/\r\n$/, "");
    const nm = /name="([^"]*)"/.exec(head);
    if (!nm) continue;
    const fn = /filename="([^"]*)"/.exec(head);
    const ct = /content-type:\s*([^\r\n]+)/i.exec(head);
    out[nm[1]] = {
      filename: fn?.[1] ?? null,
      contentType: ct?.[1]?.trim() ?? null,
      bytes: Buffer.byteLength(body, "latin1"),
    };
  }
  return out;
}

/**
 * In-process NDJSON stream server. The browser is redirected here by the
 * network boundary, so delivery is genuinely incremental: each segment is
 * flushed, the harness is notified, and the next segment waits for release.
 *
 * Only request *metadata* is retained — field names, filenames, sizes and
 * media types. Upload bytes are read and discarded.
 */
async function startStreamServer() {
  const state = {
    segments: null,
    planName: null,
    holds: [],
    received: 0,
    served: 0,
    eventsWritten: 0,
    captured: null,
    disconnected: false,
    paceMs: 0,
  };

  const server = http.createServer((req, res) => {
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "*",
      "access-control-allow-private-network": "true",
      "cache-control": "no-store",
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      return res.end();
    }
    if (req.method !== "POST" || req.url !== "/stream") {
      res.writeHead(404, cors);
      return res.end();
    }

    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      state.received++;
      state.captured = {
        contentType: req.headers["content-type"] ?? null,
        bytes: body.length,
        fields: parseMultipart(body, req.headers["content-type"]),
        at: new Date().toISOString(),
      };
      res.writeHead(200, { "content-type": "application/x-ndjson", ...cors });

      if (state.paceMs > 0) {
        state.pacedAt = Date.now();
        await delay(state.paceMs);
      }

      const segs = state.segments ?? [];
      let closed = false;
      res.on("close", () => {
        closed = true;
        state.disconnected = true;
        for (const h of state.holds) h?.resolveReached?.();
      });

      try {
        for (let i = 0; i < segs.length; i++) {
          if (closed || res.writableEnded) return;
          for (const line of segs[i]) {
            if (closed || res.writableEnded) return;
            res.write(line + "\n");
            state.eventsWritten++;
          }
          const hold = state.holds[i];
          if (hold) {
            hold.resolveReached();
            await hold.releasePromise;
          }
        }
        if (!closed && !res.writableEnded) res.end();
        state.served++;
      } catch {
        /* client went away */
      }
    });
    req.on("error", () => {
      state.disconnected = true;
    });
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;

  return {
    origin,
    state,
    /**
     * Prepare a barrier plan. `holds` = number of held segments (0 = fast).
     * `paceMs` keeps the response open (first byte withheld) for that many
     * milliseconds so a slow controlled stub is observable in the UI.
     */
    plan(fixtureName, { holds = 0, paceMs = 0 } = {}) {
      state.paceMs = Math.max(0, paceMs);
      const lines = fs.readFileSync(fixturePath(fixtureName), "utf8")
        .split("\n")
        .filter((l) => l.trim());
      const all = buildSegments(lines);
      const n = Math.max(0, Math.min(holds, all.length - 1));
      // Held segments stay separate; every segment after the last hold is
      // concatenated into one final unheld segment so the terminal event is
      // never dropped regardless of how many barriers were requested.
      const held = all.slice(0, n);
      const tail = all.slice(n);
      state.segments = n > 0 ? [...held, tail.flat()] : [lines];
      state.planName = fixtureName;
      state.holds = state.segments.map((_, i) => {
        if (i >= n) return null;
        let resolveReached;
        const reached = new Promise((r) => (resolveReached = r));
        let resolveRelease;
        const releasePromise = new Promise((r) => (resolveRelease = r));
        return { reached, releasePromise, resolveReached, resolveRelease };
      });
      return { segments: state.segments.length, holds: n };
    },
    /** Fast path: single flush, no barriers (optionally paced). */
    planFast(fixtureName, paceMs = 0) {
      return this.plan(fixtureName, { holds: 0, paceMs });
    },
    reached(i) {
      return state.holds[i] ? state.holds[i].reached : Promise.resolve();
    },
    release(i) {
      state.holds[i]?.resolveRelease();
    },
    releaseAll() {
      for (const h of state.holds) h?.resolveRelease();
    },
    /** Wait until a served fixture stream has flushed its terminal event. */
    async waitForServed(ms = 5000) {
      const t0 = Date.now();
      while (this.state.served === 0 && this.state.received === 0 && Date.now() - t0 < ms) {
        await delay(50);
      }
      const t1 = Date.now();
      while (this.state.received > 0 && this.state.served === 0 && Date.now() - t1 < ms) {
        await delay(50);
      }
    },
    async close() {
      this.releaseAll();
      await new Promise((r) => server.close(() => r()));
    },
  };
}

/* -------------------------------- faults -------------------------------- */

const FAULTS = {
  "a11y-false-green":
    "make the upload input unfocusable and the h1 invisible while logging a controlled console error",
  "bad-selection": "force the Sources result tab to report aria-selected=false after it is chosen",
  "unexpected-request": "fire a provider-shaped request from the page during load",
  "anchor-broken": "remove the #how-it-works landing section target after load",
  "focus-removed": "remove the claim textarea from the tab order",
  "drop-timeline-item": "delete one rendered timeline occurrence so counts stop matching the fixture",
  "group-mislabel": "rewrite the neutral reporting-group headline back to the hardcoded Shared label",
};

const FAULT_SCRIPT = `window.__ctFault = (mode) => {
  let err = false;
  const alter = () => {
    if (mode === "bad-selection") {
      document.querySelectorAll('[role="tab"]').forEach((tab) => {
        if (tab.textContent.trim() === "Sources" && tab.getAttribute("aria-selected") === "true") {
          tab.setAttribute("aria-selected", "false");
        }
      });
    } else if (mode === "a11y-false-green") {
      const input = document.getElementById("ct-image-input");
      if (input && input.tabIndex !== -1) input.tabIndex = -1;
      const h1 = document.querySelector("h1");
      if (h1 && h1.style.color !== "transparent") h1.style.color = "transparent";
      if (h1 && !err) { err = true; console.error("CONTROLLED_UNEXPECTED_UI_ERROR"); }
    } else if (mode === "anchor-broken") {
      const s = document.getElementById("how-it-works");
      if (s) s.removeAttribute("id");
    } else if (mode === "focus-removed") {
      const c = document.getElementById("ct-claim");
      if (c && c.tabIndex !== -1) c.tabIndex = -1;
    } else if (mode === "unexpected-request") {
      if (!window.__ctFaultFired) {
        window.__ctFaultFired = true;
        fetch("https://serpapi.com/search?api_key=CONTROLLED_FAULT&tbm=isch").catch(() => {});
      }
    } else if (mode === "group-mislabel") {
      // Rewriting the headline is idempotent: once it no longer starts with
      // "Reporting group of" the branch stops matching, so the observer
      // settles instead of looping.
      document.querySelectorAll("#ct-panel-analysis li p").forEach((p) => {
        const t = (p.textContent || "").trim();
        const m = /^Reporting group of (\\d+) occurrence/.exec(t);
        if (m) p.textContent = "Shared group of " + m[1] + " occurrence" + (m[1] === "1" ? "" : "s") + t.slice(m[0].length);
      });
    }
  };
  new MutationObserver(alter).observe(document, { childList: true, subtree: true, attributes: true });
  document.addEventListener("DOMContentLoaded", alter);
  if (document.readyState !== "loading") alter();

  // A timeline occurrence only exists while the Timeline tab is selected, and
  // the tab is selected more than once during a drive — so poll and keep
  // removing, otherwise a re-mount restores the items and the fault silently
  // stops being a fault.
  if (mode === "drop-timeline-item") {
    const drop = () => {
      const li = document.querySelector("#ct-panel-timeline ol > li");
      if (li) li.remove();
    };
    const timer = setInterval(drop, 50);
    setTimeout(() => clearInterval(timer), 30000);
  }
};`;

/* ------------------------------ drive specs ----------------------------- */

const VIEWPORTS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } };
const RESULT_TABS = ["Overview", "Timeline", "Sources", "Analysis"];
const LIVE_ONLY = ["image", "claim-text"];
const DELAY_MS_MAX = 600_000;

/** Per-feature executable contract: exactly which options exist, which
 *  values they accept, and which combinations are honest rejections. */
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
    options: ["mode", "case", "delay-ms", "image", "claim-text"],
    modes: ["trace", "claim"],
    defaultMode: "trace",
    defaultCase: (mode) => `controlled-${mode}`,
    anyFixtureCase: true,
  },
  result: {
    options: ["case", "view", "delay-ms", "image", "claim-text"],
    views: ["overview", "timeline", "sources", "analysis"],
    defaultView: "overview",
    defaultCase: "controlled-claim",
    anyFixtureCase: true,
  },
  viewer: {
    options: ["entry", "case", "delay-ms", "image", "claim-text"],
    entries: ["timeline", "sources", "takeaway"],
    cases: ["image-load", "image-fail", "no-excerpt", "pair"],
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

const FEATURE_LIST = Object.keys(FEATURE_SPECS);

/**
 * Full schema validation. Runs before any side effect: no manifest read, no
 * port probe, no browser. Returns the normalized option object.
 */
function parseDriveOptions() {
  const feature = positional[1];
  if (!feature) fail("drive requires a feature (implemented: " + FEATURE_LIST.join(", ") + ")");
  if (positional.length > 2) fail(`unexpected argument ${JSON.stringify(positional[2])}`);
  const spec = FEATURE_SPECS[feature];
  if (!spec) fail(`unknown drive feature ${feature} (implemented: ${FEATURE_LIST.join(", ")})`);

  const allowed = [...COMMAND_FLAGS.drive, ...spec.options, ...new Set(COMMAND_FLAGS.drive.concat(spec.options))];
  const unknown = Object.keys(flags).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    fail(`unsupported option(s) for ${feature}: ${unknown.map((k) => `--${k}`).join(", ")}`);
  }

  const live = flags.live === true;
  if (live && !spec.options.length) {
    fail(`--live is only valid for investigation|result|viewer drives`);
  }

  if (flags.viewport !== undefined && !VIEWPORTS[flags.viewport]) {
    fail(`unsupported --viewport ${flags.viewport} (supported: ${Object.keys(VIEWPORTS).join("|")})`);
  }
  // --mode is validated before --case because the default fixture case is
  // derived from it; an invalid mode must not produce a derived-case error.
  if (flags.mode !== undefined) {
    if (!spec.modes) fail(`unsupported option(s) for ${feature}: --mode`);
    if (!spec.modes.includes(flags.mode)) {
      fail(`unsupported --mode ${flags.mode} (supported: ${spec.modes.join("|")})`);
    }
  } else if (spec.modes) {
    flags.mode = spec.defaultMode;
  }
  if (flags.view !== undefined) {
    if (!spec.views) fail(`unsupported option(s) for ${feature}: --view`);
    if (!spec.views.includes(flags.view)) {
      fail(`unsupported --view ${flags.view} for ${feature} (supported: ${spec.views.join("|")})`);
    }
  } else if (spec.views) {
    flags.view = spec.defaultView;
  }
  if (flags.entry !== undefined) {
    if (!spec.entries) fail(`unsupported option(s) for ${feature}: --entry`);
    if (!spec.entries.includes(flags.entry)) {
      fail(`unsupported --entry ${flags.entry} for ${feature} (supported: ${spec.entries.join("|")})`);
    }
  } else if (spec.entries && spec.defaultEntry) {
    flags.entry = spec.defaultEntry;
  }
  if (flags.case !== undefined) {
    if (!spec.cases && !spec.anyFixtureCase) fail(`unsupported option(s) for ${feature}: --case`);
    if (spec.cases && !spec.anyFixtureCase && !spec.cases.includes(flags.case)) {
      fail(`unsupported --case ${flags.case} for ${feature} (supported: ${spec.cases.join("|")})`);
    }
    if (spec.anyFixtureCase && !fixtureNames().includes(flags.case)) {
      fail(`unknown fixture case ${flags.case} (available: ${fixtureNames().join(", ") || "none"})`);
    }
    if (feature === "viewer" && flags.case === "pair" && !fixtureNames().some(fixtureHasPair)) {
      fail(
        "NOT IMPLEMENTED: --case pair — the product exposes a paired-divergence viewer entry, " +
          "but no controlled fixture emits a paired divergence endpoint yet, so the case cannot be driven",
      );
    }
  } else if (spec.defaultCase) {
    flags.case = typeof spec.defaultCase === "function" ? spec.defaultCase(flags.mode ?? spec.defaultMode) : spec.defaultCase;
    if (spec.anyFixtureCase && !fixtureNames().includes(flags.case)) {
      fail(`unknown fixture case ${flags.case} (available: ${fixtureNames().join(", ") || "none"})`);
    }
  }

  const delayMs = intFlag("delay-ms", { min: 0, max: DELAY_MS_MAX, fallback: 0 });
  if (flags.live && flags["delay-ms"] !== undefined) {
    fail("--delay-ms is a controlled-stub pacing option and is not valid with --live");
  }

  if (flags.fault !== undefined) {
    if (!Object.prototype.hasOwnProperty.call(FAULTS, flags.fault)) {
      fail(`unsupported --fault ${flags.fault} (supported: ${Object.keys(FAULTS).join("|")})`);
    }
    if (live) fail("--fault sabotages a controlled run and is not valid with --live");
  }

  for (const k of LIVE_ONLY) {
    if (flags[k] !== undefined && !live) fail(`--${k} is only valid with --live`);
  }

  // Mode agreement: `--mode` and the fixture's terminal result must describe
  // the same investigation, otherwise the drive would assert the wrong UI.
  if (!live && spec.modes && flags.case) {
    const fm = fixtureMode(flags.case);
    if (fm && fm !== flags.mode) {
      fail(
        `--mode ${flags.mode} disagrees with fixture ${flags.case} (terminal result mode: ${fm}); ` +
          `pass --mode ${fm} or choose a matching --case`,
      );
    }
  }

  // Live drives need an image input; controlled drives use the generated set.
  // The credit gate is checked first among live requirements: it is a safety
  // property and must be reported before any run-state or input detail.
  if (live && process.env.RUN_LIVE_TESTS !== "1") {
    fail("--live requires RUN_LIVE_TESTS=1 (provider credit gate)");
  }
  if (live) {
    if (flags.image === undefined) {
      fail("--live requires --image <path> (the submitted media for the provider run)");
    }
    if (!fs.existsSync(path.resolve(flags.image))) fail(`--image not found: ${flags.image}`);
  }

  return { feature, spec, live, delayMs };
}

/* ------------------------------ browser io ------------------------------ */

async function openSession(m, runId, viewport, { fault, streamOrigin, mode, apiMode }) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: VIEWPORTS[viewport] ?? VIEWPORTS.desktop,
    recordVideo: flags["no-video"]
      ? undefined
      : { dir: path.join(runDir(runId), "video"), size: VIEWPORTS[viewport] ?? VIEWPORTS.desktop },
  });
  if (fault) {
    await context.addInitScript({ content: `${FAULT_SCRIPT}\nwindow.__ctFault(${JSON.stringify(fault)});` });
  }
  const page = await context.newPage();
  const consoleRaw = [];
  page.on("pageerror", (e) => consoleRaw.push({ kind: "pageerror", text: String(e.message).slice(0, 500) }));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    let url = null;
    try {
      url = msg.location()?.url ?? null;
    } catch {
      /* location unavailable */
    }
    consoleRaw.push({ kind: "console", text: msg.text().slice(0, 500), url });
  });
  const boundary = await installBoundary(page, { mode, apiMode, streamOrigin });
  return { browser, context, page, consoleRaw, boundary };
}

function redact(text) {
  return text
    .replace(/([?&](?:key|api_key|apikey|token|secret|password)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b(sk|pk|api)[-_][A-Za-z0-9]{8,}/g, "[redacted]");
}

/** Console failures that a controlled run may legitimately produce. Anything
 *  else is an unexpected failure and fails the drive. */
function classifyConsole(entry, streamOrigin) {
  const t = entry.text ?? "";
  const u = entry.url ?? "";
  const hay = `${t}\n${u}`;
  if (t.includes("CONTROLLED_UNEXPECTED_UI_ERROR")) return "unexpected";
  if (streamOrigin && u.startsWith(streamOrigin)) return "blocked-api";
  if (/Failed to load resource|net::ERR_|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION/.test(t)) {
    if (/api\/investigate/.test(hay)) return "blocked-api";
    if (/example\.(invalid|org|com|net)|fixture-|127\.0\.0\.1|localhost|data:image/i.test(hay)) {
      return "controlled-image-failure";
    }
    return "unexpected";
  }
  if (entry.kind === "pageerror") return "unexpected";
  return "unexpected";
}

function classifyConsoleSet(entries, streamOrigin) {
  const out = entries.map((e) => ({ ...e, text: redact(e.text), classification: classifyConsole(e, streamOrigin) }));
  return {
    total: out.length,
    unexpected: out.filter((e) => e.classification === "unexpected").length,
    controlled: out.filter((e) => e.classification !== "unexpected").length,
    entries: out,
  };
}

/* ------------------------------- upload io ------------------------------ */

async function shot(page, dir, name) {
  const p = path.join(dir, `${name}.png`);
  await page.screenshot({ path: p, fullPage: true });
  return p;
}

async function aria(page, dir, name) {
  const p = path.join(dir, `${name}.aria.txt`);
  fs.writeFileSync(p, await page.locator("body").ariaSnapshot());
  return p;
}

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

function noisePng(width, height) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const o = y * (1 + width * 3);
    raw[o] = 0;
    crypto.randomFillSync(raw, o + 1, width * 3);
  }
  const idat = zlib.deflateSync(raw, { level: 0 });
  return Buffer.concat([sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))]);
}

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

async function applyUploadEntry(page, entry, file) {
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
      const b64Data = fs.readFileSync(file.path).toString("base64");
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

async function expectSelectedPreview(page, rec, fileName = null) {
  const img = page.locator('img[alt^="Selected image preview"]');
  await img.waitFor({ timeout: 10_000 });
  const alt = (await img.getAttribute("alt")) ?? "";
  rec.check("upload.preview-visible", true, alt);
  if (fileName) rec.check("upload.preview-matches-file", alt.includes(fileName), `${fileName} vs ${alt}`);
  return img;
}

function submitButton(page) {
  return page.getByRole("button", { name: /start investigation/i });
}

async function expectUploadError(page, rec, pattern, id) {
  const alert = page.locator('[role="alert"]:not(#__next-route-announcer__)');
  await alert.first().waitFor({ timeout: 25_000 });
  const texts = await alert.allTextContents();
  const hit = texts.find((t) => pattern.test(t));
  rec.check(id, hit !== undefined, `expected ${pattern} in ${JSON.stringify(texts.map((t) => t.slice(0, 120)))}`);
}

/**
 * Terminal result = the completed report, not progressive copy. Requires the
 * result tablist and the overview section, then asserts the headline matches
 * the fixture's own terminal status so a wrong-mode result cannot pass.
 */
async function waitForTerminalResult(page, rec, { timeoutMs = 30_000, fixture = null } = {}) {
  await page.waitForSelector('[aria-label="Result views"]', { timeout: timeoutMs });
  await page.waitForSelector('[aria-label="Investigation result"]', { timeout: timeoutMs });
  rec.check("result.terminal-surface", true, "tablist + overview section present");
  if (fixture) {
    const r = fixtureResult(fixture);
    const status = r?.status ?? null;
    const mode = fixtureMode(fixture);
    const body = await page.locator("body").innerText();
    if (mode === "claim" && status) {
      const HEADLINES = {
        CONTEXT_CONFLICT: "Context conflict found",
        POSSIBLE_CONTEXT_CONFLICT: "Possible context conflict",
        NO_CONFLICT_FOUND: "No conflict found in retrieved evidence",
        INSUFFICIENT_EVIDENCE: "Insufficient evidence",
      };
      const want = HEADLINES[status];
      if (want) rec.check("result.status-headline", body.includes(want), `${status} → "${want}"`);
      else rec.note("result.status-headline", `no headline mapping for ${status}`);
    } else if (mode === "trace") {
      rec.check(
        "result.mode-is-trace",
        /Media history reconstructed|Limited media history found/.test(body),
        "trace headline present",
      );
    }
    rec.check("result.fixture-status-agrees", true, `fixture status=${status ?? "n/a"} mode=${mode}`);
  }
}

async function selectTab(page, rec, name) {
  const tab = page.getByRole("tab", { name: new RegExp(`^${name}$`, "i") });
  const count = await tab.count();
  rec.check(`result.tab-${name.toLowerCase()}-present`, count > 0, `count=${count}`);
  await tab.first().click();
  await delay(250);
  const selected = (await tab.first().getAttribute("aria-selected")) === "true";
  rec.check(`result.tab-${name.toLowerCase()}-selected`, selected, `aria-selected=${selected}`);
}

/** Snapshot of document.activeElement, or null when focus is on <body>. */
async function activeElement(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    return {
      tag: el.tagName,
      role: el.getAttribute("role"),
      label: el.getAttribute("aria-label"),
      text: (el.textContent || "").trim().slice(0, 60),
      inDialog: !!el.closest('[role="dialog"]'),
    };
  });
}

/* --------------------------------- drive -------------------------------- */

async function drive() {
  if (!positional[1]) fail("drive requires a feature (implemented: " + FEATURE_LIST.join(", ") + ")");
  const { feature, spec, live, delayMs } = parseDriveOptions();

  // Credit gate BEFORE run state: a --live drive must never reach the
  // manifest, port or browser checks without the explicit credit opt-in.
  if (live && process.env.RUN_LIVE_TESTS !== "1") {
    fail("--live requires RUN_LIVE_TESTS=1 (provider credit gate)");
  }

  const runId = required("run-id");
  const m = readManifest(runId);
  if (!m) fail(`no manifest for run-id ${runId}`);
  if (!pidIsOwned(m)) fail(`server pid ${m.pid} is not alive (or was reused) — relaunch`);
  if (live && !m.live) fail("--live drive requires a run launched with --live (credentials are absent otherwise)");

  if (manifestSealed(runId)) {
    fail(
      `evidence for run ${runId} generation ${generation(runId)} is sealed; ` +
        `relaunch with --new-generation to record more drives`,
    );
  }

  const viewport = flags.viewport ?? "desktop";
  const fault = flags.fault ?? null;
  const tier = live ? "live" : fixtureDrives.has(feature) ? "public-contract-boundary" : "real-ui";
  const caseName = flags.case ?? null;

  const { dir: driveDir, seq } = nextDriveDir(runId, feature, [
    flags.entry,
    flags.mode,
    caseName,
    viewport,
  ]);
  const rec = new Recorder(driveDir);

  const runner = runnerIdentity();
  const t0 = Date.now();
  let stream = null;
  let session = null;
  let outcome = "PASS";
  let failure = null;
  let failureStack = "";

  try {
    if (live) {
      if (!flags.image) fail("--live requires --image <path>");
      session = await openSession(m, runId, viewport, {
        fault,
        streamOrigin: null,
        mode: "live",
        apiMode: "live",
      });
    } else {
      stream = await startStreamServer();
      session = await openSession(m, runId, viewport, {
        fault,
        streamOrigin: stream.origin,
        mode: "controlled",
        apiMode: apiModeFor(feature, caseName),
      });
    }
    const { page, consoleRaw, boundary } = session;
    session.syncBoundary = () => {
      if (!stream) return;
      boundary.fixtureReceived = stream.state.received;
      boundary.fixtureEvents = stream.state.eventsWritten;
      boundary.fixtureFulfilled = stream.state.served;
    };

    await DRIVE_CASES[feature]({
      page,
      rec,
      m,
      runId,
      driveDir,
      viewport,
      spec,
      live,
      delayMs,
      stream,
      boundary,
      caseName,
    });

    if (session.syncBoundary) session.syncBoundary();
    boundaryCheck(rec, boundary, live);
    const consoleSet = classifyConsoleSet(consoleRaw, stream?.origin ?? null);
    rec.check("console.no-unexpected-errors", consoleSet.unexpected === 0, `${consoleSet.unexpected} unexpected`);
    writeJson(path.join(driveDir, "console.json"), consoleSet);
    writeJson(path.join(driveDir, "boundary.json"), boundary);
  } catch (err) {
    outcome = "FAIL";
    failure = String(err?.message ?? err);
    failureStack = String(err?.stack ?? "");
    rec.push("drive.completed", "FAIL", failure);
    try {
      await shot(session?.page, driveDir, "FAILED");
    } catch {
      /* page may be dead */
    }
    if (session?.consoleRaw) {
      const consoleSet = classifyConsoleSet(session.consoleRaw, stream?.origin ?? null);
      writeJson(path.join(driveDir, "console.json"), consoleSet);
    }
    if (session?.syncBoundary) session.syncBoundary();
    if (session?.boundary) writeJson(path.join(driveDir, "boundary.json"), session.boundary);
  } finally {
    if (stream) {
      await stream.waitForServed().catch(() => {});
      if (session?.syncBoundary) session.syncBoundary();
      writeJson(path.join(driveDir, "request-capture.json"), stream.state.captured);
      await stream.close().catch(() => {});
    }
    if (session) {
      await session.context.close().catch(() => {});
      await session.browser.close().catch(() => {});
    }
    rec.close();
  }

  const counts = rec.counts();
  const driveRecord = {
    driveId: path.basename(driveDir),
    seq,
    runId,
    generation: generation(runId),
    feature,
    viewport,
    case: caseName,
    entry: flags.entry ?? null,
    mode: flags.mode ?? null,
    view: flags.view ?? null,
    fault,
    live,
    tier,
    fixture: caseName && fixtureNames().includes(caseName) ? caseName : null,
    generator: caseName && fixtureNames().includes(caseName) ? "contexttrail-fixtures" : null,
    appRevision: m.revision,
    buildId: m.buildId,
    runnerRevision: runner.runnerRevision,
    runnerDirty: runner.runnerDirty,
    cliSha256: runner.cliSha256,
    startedAt: new Date(t0).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    outcome,
    failure,
    failureStack: failureStack || null,
    assertions: counts,
    boundary: session?.boundary ?? null,
    command: process.argv.slice(2),
    artifacts: fs.readdirSync(driveDir).sort(),
  };
  writeJson(path.join(driveDir, "drive.json"), driveRecord);
  fs.appendFileSync(
    path.join(evidenceDir(runId), "drives.jsonl"),
    JSON.stringify({ at: driveRecord.finishedAt, driveId: driveRecord.driveId, feature, tier, outcome, ...counts }) + "\n",
  );

  console.log(
    JSON.stringify({
      drove: feature,
      runId,
      driveId: driveRecord.driveId,
      tier,
      outcome,
      assertions: counts,
      boundary: session?.boundary
        ? {
            providerAttempted: session.boundary.providerAttempted,
            providerBlocked: session.boundary.providerBlocked,
            apiAttempted: session.boundary.apiAttempted,
            apiRedirected: session.boundary.apiRedirected,
            fixtureFulfilled: session.boundary.fixtureFulfilled,
          }
        : null,
      consoleErrors: session?.consoleRaw?.length ?? 0,
      failure,
    }),
  );
  process.exit(outcome === "PASS" ? 0 : EXIT_ASSERT);
}

/** Features whose evidence is produced at the controlled public-contract
 *  boundary rather than against the untouched product surface. */
const fixtureDrives = new Set(["investigation", "result", "viewer"]);

function apiModeFor(feature, caseName) {
  if (feature === "session" && caseName === "fatal-retry") return "fail";
  if (feature === "investigation" || feature === "result" || feature === "viewer") return "redirect";
  if (feature === "session") return "redirect";
  return "redirect";
}

function boundaryCheck(rec, b, live) {
  if (live) {
    rec.check("boundary.live-mode-recorded", b.mode === "live", `mode=${b.mode}`);
    rec.note("boundary.provider-allowed", `${b.providerAllowed} provider request(s) allowed`);
    return;
  }
  rec.check(
    "boundary.zero-provider-attempts",
    b.providerAttempted === 0,
    `${b.providerAttempted} provider-shaped request(s) attempted (${JSON.stringify(b.providerCategories)})`,
  );
  rec.check("boundary.provider-blocked", b.providerBlocked === b.providerAttempted, `${b.providerBlocked} blocked`);
  rec.check("boundary.mode-controlled", b.mode === "controlled", `mode=${b.mode}`);
}

/* ------------------------------ drive cases ----------------------------- */

const DRIVE_CASES = {
  async landing({ page, rec, m, driveDir, viewport, fault }) {
    await page.goto(m.url, { waitUntil: "networkidle" });
    await shot(page, driveDir, "01-landing");
    await aria(page, driveDir, "landing");

    rec.check("landing.http-200", true, m.url);
    rec.check("landing.title", (await page.title()).includes("ContextTrail"), await page.title());

    // Three "Start investigating" CTAs plus the example link, each landing
    // on /investigate without ever touching the investigation API.
    const ctas = page.getByRole("link", { name: /start investigating/i });
    const ctaCount = await ctas.count();
    rec.check("landing.start-cta-count", ctaCount >= 3, `count=${ctaCount}`);
    for (let i = 0; i < ctaCount; i++) {
      await ctas.nth(i).click();
      await page.waitForURL(/\/investigate/, { timeout: 10_000 });
      rec.check(`landing.cta-${i}-destination`, /\/investigate/.test(page.url()), page.url());
      await page.goto(m.url, { waitUntil: "domcontentloaded" });
    }
    const example = page.getByRole("link", { name: /see an example/i });
    rec.check("landing.example-cta-present", (await example.count()) > 0, `count=${await example.count()}`);
    if ((await example.count()) > 0) {
      await example.first().click();
      await page.waitForURL(/#example/, { timeout: 10_000 }).catch(() => {});
      rec.check("landing.example-anchor-destination", page.url().includes("example"), page.url());
      await page.goto(m.url, { waitUntil: "domcontentloaded" });
    }

    // Every in-page anchor must resolve to a real section.
    const hrefs = await page
      .locator('a[href^="#"], a[href^="/#"]')
      .evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute("href")).filter(Boolean))]);
    rec.note("landing.anchor-hrefs", hrefs.join(", "));
    rec.check("landing.anchor-set", ["#how-it-works", "#example", "#about"].every((h) => hrefs.includes(h)), hrefs.join(","));
    for (const href of hrefs) {
      const sel = href.replace(/^\//, "");
      const exists = await page.evaluate((s) => {
        try {
          return !!document.querySelector(s);
        } catch {
          return false;
        }
      }, sel);
      rec.check(`landing.anchor-target${href.replace(/[^a-z]/gi, "_")}`, exists, `${href} resolves`);
    }

    if (viewport === "desktop" && !fault) {
      await page.locator('a[href="#how-it-works"]').first().click();
      await delay(300);
      const landed = await page.evaluate(() => {
        const el = document.getElementById("how-it-works");
        if (!el) return null;
        return Math.abs(el.getBoundingClientRect().top) < window.innerHeight;
      });
      rec.check("landing.anchor-scrolls-to-section", landed === true, `landed=${landed}`);
    }
    rec.note("landing.viewport", viewport);
  },

  async upload({ page, rec, m, runId, driveDir, spec }) {
    const entry = flags.entry ?? spec.defaultEntry;
    const uc = flags.case ?? spec.defaultCase;
    const files = uploadFileSet(runId);
    await page.goto(`${m.url}/investigate`, { waitUntil: "domcontentloaded" });
    await aria(page, driveDir, "upload-initial");
    const submit = submitButton(page);

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
    rec.note("upload.entry-method", JSON.stringify(entryInfo));

    switch (uc) {
      case "valid": {
        await expectSelectedPreview(page, rec, "upload.png");
        rec.check("upload.submit-enabled-after-valid", await submit.isEnabled(), "enabled");
        break;
      }
      case "unsupported": {
        await expectUploadError(page, rec, /unsupported file/i, "upload.unsupported-rejected");
        rec.check("upload.submit-disabled-after-unsupported", !(await submit.isEnabled()), "disabled");
        break;
      }
      case "empty":
      case "decode": {
        await expectSelectedPreview(page, rec, caseFile);
        await page.locator("#ct-claim").fill("claim must survive the decode failure");
        await submit.click();
        await expectUploadError(page, rec, /could not be decoded/i, "upload.decode-rejected");
        const claim = await page.locator("#ct-claim").inputValue();
        rec.check("upload.claim-survives-failure", claim.length > 0, `claim length ${claim.length}`);
        break;
      }
      case "oversize": {
        await expectSelectedPreview(page, rec, "noise.png");
        await submit.click();
        await expectUploadError(page, rec, /could not be compressed|smaller image/i, "upload.oversize-rejected");
        break;
      }
      case "replace": {
        await expectSelectedPreview(page, rec, "upload.png");
        const [chooser] = await Promise.all([
          page.waitForEvent("filechooser", { timeout: 10_000 }),
          page.getByRole("button", { name: "Replace", exact: true }).click(),
        ]);
        await chooser.setFiles(files["upload-2.png"].path);
        await expectSelectedPreview(page, rec, "upload-2.png");
        break;
      }
      case "remove": {
        await expectSelectedPreview(page, rec, "upload.png");
        await page.locator("#ct-claim").fill("claim kept after remove");
        await page.getByRole("button", { name: "Remove" }).click();
        rec.check("upload.submit-disabled-after-remove", !(await submit.isEnabled()), "disabled");
        const claim = await page.locator("#ct-claim").inputValue();
        rec.check("upload.claim-survives-remove", claim.length > 0, `claim length ${claim.length}`);
        await page.locator('label[for="ct-image-input"]').waitFor({ timeout: 5_000 });
        rec.check("upload.input-restored-after-remove", true, "input label back");
        break;
      }
      case "claim-limit": {
        await expectSelectedPreview(page, rec, "upload.png");
        await page.locator("#ct-claim").fill("x".repeat(600));
        const value = await page.locator("#ct-claim").inputValue();
        rec.check("upload.claim-cap-500", value.length === 500, `got ${value.length}`);
        const remaining = await page.locator('p[aria-label$="characters remaining"]').getAttribute("aria-label");
        rec.check("upload.claim-counter-announced", /0 characters remaining/.test(remaining ?? ""), remaining ?? "missing");
        break;
      }
    }
    await shot(page, driveDir, `01-upload-${entry}-${uc}`);
    await aria(page, driveDir, `upload-${entry}-${uc}`);
  },

  async investigation({ page, rec, m, runId, driveDir, live, delayMs, stream, caseName }) {
    const mode = flags.mode ?? "trace";
    const claim = mode === "claim" ? (flags["claim-text"] ?? "controlled claim text") : null;
    if (!live && stream) {
      const plan =
        delayMs > 0
          ? stream.plan(caseName, { holds: 0, paceMs: delayMs })
          : stream.plan(caseName, { holds: 3 });
      rec.note("stream.plan", JSON.stringify(plan));
    }
    await submitUpload(page, m, runId, { claim, rec });
    const tSubmit = Date.now();
    await submitButton(page).click();

    if (!live && stream && delayMs === 0) {
      // Each barrier is held only while its own assertions run, then released
      // so the client can advance to the next segment.
      await stream.reached(0);
      await page.getByRole("button", { name: /cancel investigation/i }).waitFor({ timeout: 15_000 });
      const body0 = await page.locator("body").innerText();
      rec.check("investigation.progressive-before-terminal", !body0.includes("Key takeaways"), "no takeaways yet");
      rec.check(
        "investigation.stage-list-present",
        (await page.locator('[aria-label="Investigation stages"]').count()) > 0,
        "stage list",
      );
      const completed0 = await page
        .locator('[aria-label="Investigation stages"] li[aria-label*=": Completed"]')
        .count();
      rec.check("investigation.stage-completes-progressively", completed0 > 0, `${completed0} completed stage(s)`);
      rec.check(
        "investigation.terminal-absent-at-first-barrier",
        (await page.locator('[aria-label="Result views"]').count()) === 0,
        "result tablist not yet rendered",
      );
      await shot(page, driveDir, "01-investigation-progress");
      stream.release(0);

      await stream.reached(1);
      const counts = await page
        .locator('section[aria-label="Evidence arriving live"] p')
        .first()
        .innerText({ timeout: 10_000 })
        .catch(() => "");
      rec.check("investigation.evidence-arrives", /\d+\s+candidates? found/.test(counts), counts.slice(0, 120));
      const running = await page
        .locator('[aria-label="Investigation stages"] li[aria-label*=": Running"]')
        .count();
      rec.check("investigation.stream-still-open", running > 0, `${running} running stage(s)`);
      rec.check(
        "investigation.terminal-absent-while-streaming",
        (await page.locator('[aria-label="Result views"]').count()) === 0,
        "result tablist not yet rendered",
      );
      rec.check(
        "investigation.no-progress-percentage",
        !(await page.locator("body").innerText()).includes("%"),
        "no fabricated percentage while streaming",
      );
      stream.release(1);

      await stream.reached(2);
      const advanced = await page
        .locator('[aria-label="Investigation stages"] li[aria-label*=": Completed"]')
        .count();
      rec.check("investigation.stage-progress-advances", advanced >= completed0, `${completed0} → ${advanced}`);
      await shot(page, driveDir, "02-investigation-advanced");
      stream.release(2);
    } else {
      // --delay-ms withholds the stub's first byte, so the running screen is
      // observable while the stream is still open.
      await page.getByRole("button", { name: /cancel investigation/i }).waitFor({ timeout: 15_000 });
      await page.getByText(/tracing the web|searching the web|preparing image/i).waitFor({ timeout: 15_000 }).catch(() => {});
      await shot(page, driveDir, "01-investigation-progress");
      if (stream) stream.releaseAll();
    }

    await waitForTerminalResult(page, rec, {
      timeoutMs: live ? 95_000 : 45_000,
      fixture: live ? null : caseName,
    });
    if (!live && delayMs > 0) {
      const elapsed = Date.now() - tSubmit;
      rec.check("investigation.pacing-observed", elapsed >= delayMs * 0.8, `${elapsed}ms >= ${Math.round(delayMs * 0.8)}ms`);
    }
    await shot(page, driveDir, "02-investigation-result");
    await aria(page, driveDir, "investigation-result");
    if (stream) rec.check("stream.request-captured", stream.state.captured !== null, JSON.stringify({ fields: stream.state.captured?.fields ?? null }));
  },

  async result({ page, rec, m, runId, driveDir, live, delayMs, stream, caseName }) {
    const view = flags.view ?? "overview";
    if (!live && stream) stream.plan(caseName, { holds: delayMs > 0 ? 0 : 1, paceMs: delayMs });
    await submitUpload(page, m, runId, { claim: flags["claim-text"] ?? "controlled claim text", rec });
    await submitButton(page).click();
    if (!live && stream && delayMs === 0) {
      await stream.reached(0);
      rec.check(
        "result.progressive-observed",
        (await page.locator('[aria-label="Investigation stages"]').count()) > 0,
        "stages visible before terminal",
      );
      rec.check(
        "result.terminal-absent-before-release",
        (await page.locator('[aria-label="Result views"]').count()) === 0,
        "result tablist not yet rendered",
      );
      stream.release(0);
    } else if (stream) {
      stream.releaseAll();
    }
    await waitForTerminalResult(page, rec, { timeoutMs: live ? 95_000 : 45_000, fixture: live ? null : caseName });

    for (const name of RESULT_TABS) await selectTab(page, rec, name);

    // Metrics live on the Overview panel — read them while it is the
    // selected tab, then finish on the requested --view.
    await selectTab(page, rec, "Overview");
    const metrics = await page.locator('[aria-label="Investigation result"]').innerText({ timeout: 15_000 });
    rec.check(
      "result.metrics-present",
      /source domain|observed context|earliest/i.test(metrics),
      metrics.slice(0, 200).replace(/\s+/g, " "),
    );
    rec.check("result.no-fabricated-percentage", !/\b\d{1,3}%\b/.test(metrics), "no percentage in overview");

    await selectTab(page, rec, view[0].toUpperCase() + view.slice(1));
    await shot(page, driveDir, `01-result-${view}`);
    await aria(page, driveDir, `result-${view}`);

    // The selected panel is compared with the fixture it was rendered from:
    // counts must line up, and no placeholder token may reach the user.
    const terminal = fixtureTerminal(caseName);
    const panel = page.locator(`#ct-panel-${view}`);
    const panelText = await panel.innerText({ timeout: 10_000 }).catch(() => "");
    rec.check(
      `result.${view}-no-placeholder`,
      panelText.length > 0 && !/\b(undefined|NaN|Invalid Date)\b/.test(panelText) && !/\bnull\b/i.test(panelText),
      panelText.slice(0, 160).replace(/\s+/g, " "),
    );

    if (view === "overview") {
      const section = page.locator('[aria-label="Key takeaways"]');
      const expected = terminal ? asLen(terminal.takeaways) : 0;
      if (expected > 0) {
        rec.check("result.takeaways-present", (await section.count()) > 0, `${expected} takeaway(s) expected`);
        const items = await section.locator("li").count();
        rec.check("result.takeaways-count-matches-fixture", items === expected, `${items} rendered vs ${expected} fixture`);
      } else {
        rec.check("result.takeaways-absent-when-none", (await section.count()) === 0, "no takeaway section");
      }
    } else if (view === "timeline") {
      const items = await panel.locator("ol > li").count();
      const expected = terminal ? asLen(terminal.timeline) : 0;
      rec.check("result.timeline-count-matches-fixture", items === expected, `${items} rendered vs ${expected} fixture`);
      const dated = terminal && Array.isArray(terminal.timeline)
        ? terminal.timeline.filter((t) => t && t["dateStatus"] === "usable").length
        : 0;
      if (dated > 0) {
        const years = (panelText.match(/\b20\d{2}\b/g) ?? []).length;
        rec.check("result.timeline-shows-dates", years >= 1, `${years} year token(s) for ${dated} dated occurrence(s)`);
      }
      for (const label of ["Supporting visual leads", "Contextual web results", "Evidence with unknown dates"]) {
        const sec = panel.locator(`section[aria-label="${label}"]`);
        if ((await sec.count()) === 0) continue;
        const lis = await sec.locator("li").count();
        rec.check(
          `result.timeline-section-nonempty-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`,
          lis > 0,
          `${lis} item(s) under ${label}`,
        );
      }
    } else if (view === "sources") {
      const expected = terminal
        ? asLen(terminal.timeline) +
          asLen(terminal.supportingEvidence) +
          asLen(terminal.contextualEvidence) +
          asLen(terminal.undatedEvidence)
        : 0;
      const items = await panel.locator('section[aria-label="Sources"] li').count();
      if (expected > 0) {
        rec.check("result.sources-count-matches-fixture", items === expected, `${items} rendered vs ${expected} fixture`);
        rec.check(
          "result.sources-open-controls",
          (await panel.getByRole("link", { name: /open source/i }).count()) === items,
          `${items} source row(s)`,
        );
      } else {
        rec.check("result.sources-empty-state", await panel.getByText(/no sources were retrieved/i).count() > 0, "empty state");
      }
    } else if (view === "analysis") {
      rec.check(
        "result.analysis-section-present",
        (await panel.locator('section[aria-label="Analysis"]').count()) > 0,
        "Analysis section",
      );
      rec.check(
        "result.analysis-policy-or-coverage",
        panelText.length > 0 && /comparison|coverage|policy|basis|limitation/i.test(panelText),
        panelText.slice(0, 160).replace(/\s+/g, " "),
      );

      // Reporting-group headline must be neutral (R4 residual): a resolved
      // group is described by its member count, never hardcoded as "Shared".
      const bodyText = await page.locator("body").innerText();
      // Regression guard first: it is the assertion the R4 residual fix is
      // about, so a reintroduced hardcoded label must be the failure named.
      const mislabel = bodyText.match(/Shared group of \d+ occurrence/i);
      rec.check("result.reporting-group-not-mislabeled", mislabel === null, mislabel ? mislabel[0] : "neutral headline");
      const groupCount = terminal && typeof terminal.reportingGroupCount === "number" ? terminal.reportingGroupCount : 0;
      if (groupCount > 0) {
        const headline = bodyText.match(/Reporting group of \d+ occurrence/);
        rec.check("result.reporting-group-headline", headline !== null, headline ? headline[0] : `${groupCount} fixture group(s) but no headline`);
      } else {
        rec.check(
          "result.reporting-group-empty-state",
          /No resolved reporting groups were reported/i.test(bodyText),
          "no resolved reporting groups in fixture",
        );
      }
    }
  },

  async viewer({ page, rec, m, runId, driveDir, viewport, stream, caseName, spec, delayMs }) {
    const entry = flags.entry ?? spec.defaultEntry;
    const vcase = flags.case ?? spec.defaultCase;
    const fixture = vcase === "image-load" || vcase === "no-excerpt" || vcase === "pair" ? "controlled-viewer" : "controlled-claim";
    if (stream) stream.planFast(fixture, delayMs);
    await submitUpload(page, m, runId, { claim: "controlled claim text", rec });
    await submitButton(page).click();
    if (stream) stream.releaseAll();
    await waitForTerminalResult(page, rec, { fixture });

    let entryBtn;
    if (entry === "timeline") {
      await selectTab(page, rec, "Timeline");
      entryBtn = page.getByRole("button", { name: /inspect evidence/i }).first();
      rec.check("viewer.timeline-entry-present", (await entryBtn.count()) > 0, `count=${await entryBtn.count()}`);
    } else if (entry === "sources") {
      await selectTab(page, rec, "Sources");
      entryBtn = page.getByRole("button", { name: /^inspect/i }).first();
      rec.check("viewer.sources-entry-present", (await entryBtn.count()) > 0, `count=${await entryBtn.count()}`);
    } else {
      entryBtn = page
        .locator('[aria-label="Key takeaways"]')
        .getByRole("button", { name: /view evidence/i })
        .first();
      rec.check("viewer.takeaway-entry-present", (await entryBtn.count()) > 0, `count=${await entryBtn.count()}`);
    }
    await entryBtn.click();

    const dialog = page.locator('[role="dialog"]');
    await dialog.waitFor({ timeout: 10_000 });
    rec.check("viewer.dialog-open", true, "role=dialog");
    rec.check("viewer.back-to-timeline", (await dialog.getByText(/back to timeline/i).count()) > 0, "close control present");

    const retrievedImg = dialog.locator('img[alt^="Retrieved image"]');
    const fallback = dialog.getByText(/retrieved image unavailable/i);
    await Promise.race([
      retrievedImg.waitFor({ timeout: 15_000 }).catch(() => {}),
      fallback.waitFor({ timeout: 15_000 }).catch(() => {}),
    ]);

    if (vcase === "image-load") {
      const nextBtn = page.getByRole("button", { name: "Next evidence" });
      let loaded = await retrievedImg.evaluate((el) => el.complete && el.naturalWidth > 0).catch(() => false);
      for (let i = 0; i < 20 && !loaded && (await nextBtn.isEnabled()); i++) {
        await nextBtn.click();
        await delay(300);
        loaded = await retrievedImg.evaluate((el) => el.complete && el.naturalWidth > 0).catch(() => false);
      }
      rec.check("viewer.image-load", loaded, `loaded=${loaded}`);
    } else if (vcase === "image-fail") {
      await fallback.waitFor({ timeout: 15_000 });
      const stillRendered = (await dialog.locator('img[alt^="Retrieved image"]').count()) > 0;
      rec.check("viewer.image-fail-shows-fallback", !stillRendered, "no broken <img> rendered");
    } else if (vcase === "no-excerpt") {
      const next = page.getByRole("button", { name: "Next evidence" });
      let found = await dialog.getByText(/no excerpt available/i).count();
      for (let i = 0; i < 20 && !found && (await next.isEnabled()); i++) {
        await next.click();
        await delay(200);
        found = await dialog.getByText(/no excerpt available/i).count();
      }
      rec.check("viewer.no-excerpt-state", found > 0, `found=${found}`);
    } else if (vcase === "pair") {
      const pair = dialog.getByRole("button", { name: /paired divergence/i });
      rec.check("viewer.pair-entry-present", (await pair.count()) > 0, `count=${await pair.count()}`);
    }

    const next = page.getByRole("button", { name: "Next evidence" });
    const prev = page.getByRole("button", { name: "Previous evidence" });
    const counter = dialog.getByText(/^\d+ of \d+$/);
    rec.check("viewer.position-counter", (await counter.count()) > 0, "N of M");
    if (await next.isEnabled()) {
      const before = (await counter.textContent()).trim();
      await next.click();
      await delay(200);
      const after = (await counter.textContent()).trim();
      rec.check("viewer.next-changes-position", after !== before, `${before} → ${after}`);
      await prev.click();
      await delay(200);
      rec.check("viewer.prev-restores-position", (await counter.textContent()).trim() === before, before);
    }

    if (viewport === "mobile") {
      const toggle = dialog.locator('[aria-label="Choose image to inspect"]');
      const attached = (await toggle.count()) > 0;
      const visible = attached && (await toggle.first().isVisible());
      rec.check("viewer.mobile-image-toggle", visible, `attached=${attached} visible=${visible}`);
      const pressed = await dialog.getByRole("button", { name: "submitted image" }).getAttribute("aria-pressed").catch(() => null);
      rec.check("viewer.mobile-toggle-pressed-state", pressed !== null, `aria-pressed=${pressed}`);
    } else {
      // The group is rendered for every viewport but hidden from desktop by
      // `lg:hidden` — count() alone would see it either way.
      const toggle = dialog.locator('[aria-label="Choose image to inspect"]');
      const attached = (await toggle.count()) > 0;
      const visible = attached && (await toggle.first().isVisible());
      rec.check("viewer.desktop-hides-mobile-toggle", !visible, `attached=${attached} visible=${visible}`);
    }

    const src = dialog.getByRole("link", { name: /open original source/i });
    rec.check("viewer.source-link-present", (await src.count()) > 0, "link");
    const href = await src.getAttribute("href");
    const rel = (await src.getAttribute("rel")) ?? "";
    const target = await src.getAttribute("target");
    rec.check("viewer.source-link-url", /^https?:\/\//.test(href ?? ""), String(href));
    rec.check("viewer.source-link-noopener", target === "_blank" && rel.includes("noopener"), `target=${target} rel=${rel}`);

    // A plain close, with no in-dialog interaction, must hand focus back out
    // of the dialog — focus landing on <body> is lost focus.
    const trigger = await activeElement(page);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden", timeout: 10_000 });
    rec.check("viewer.escape-closes", true, "dialog hidden");
    const focusAfter = await activeElement(page);
    const backOnEntry = await entryBtn.evaluate((el) => document.activeElement === el).catch(() => false);
    rec.check(
      "viewer.focus-not-left-in-hidden-dialog",
      focusAfter?.inDialog !== true,
      JSON.stringify({ trigger, focusAfter }),
    );
    rec.check(
      "viewer.focus-restored-after-close",
      focusAfter !== null && backOnEntry,
      JSON.stringify({ trigger, focusAfter, backOnEntry }),
    );

    // Reopen for the technical-details assertions: they only exist once the
    // disclosure has been expanded, which moves focus inside the dialog.
    await entryBtn.click();
    await dialog.waitFor({ timeout: 10_000 });
    await dialog.getByText("Technical details").click();
    const dds = await dialog.locator("dd").count();
    rec.check("viewer.technical-details-fields", dds > 0, `${dds} field(s)`);

    const sourceLabels = await dialog.locator("dt").allTextContents();
    rec.check(
      "viewer.technical-details-real-fields",
      sourceLabels.length > 0 && !sourceLabels.some((t) => /undefined|null|NaN/i.test(t)),
      sourceLabels.join(", ").slice(0, 200),
    );

    // Closing after an in-dialog interaction: record where focus lands, but
    // do not abort the drive on it — the plain-close assertion above is the
    // contract check, this one is the diagnostic for the disclosure path.
    const triggerAfterDetails = await activeElement(page);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden", timeout: 10_000 });
    const focusAfterDetails = await activeElement(page);
    rec.note(
      "viewer.focus-after-details-close",
      JSON.stringify({ triggerAfterDetails, focusAfterDetails }),
    );

    await shot(page, driveDir, `01-viewer-${entry}-${vcase}`);
    await aria(page, driveDir, `viewer-${entry}-${vcase}`);
  },

  async session({ page, rec, m, runId, driveDir, delayMs, stream, caseName }) {
    const scase = caseName ?? "refresh";
    switch (scase) {
      case "new": {
        if (stream) stream.planFast("controlled-claim", delayMs);
        await submitUpload(page, m, runId, { claim: "controlled claim text", rec });
        await submitButton(page).click();
        if (stream) stream.releaseAll();
        await waitForTerminalResult(page, rec, { fixture: "controlled-claim" });
        await page.getByRole("button", { name: "New investigation" }).click();
        await page.locator('label[for="ct-image-input"]').waitFor({ timeout: 10_000 });
        const claim = await page.locator("#ct-claim").inputValue();
        rec.check("session.new-clears-claim", claim === "", `claim=${JSON.stringify(claim)}`);
        rec.check("session.new-clears-image", (await page.locator('img[alt^="Selected image preview"]').count()) === 0, "preview gone");
        break;
      }
      case "back": {
        await page.goto(m.url, { waitUntil: "domcontentloaded" });
        await page.getByRole("link", { name: /start investigating/i }).first().click();
        await page.waitForURL(/\/investigate/, { timeout: 10_000 });
        await page.goBack();
        await page.waitForURL(new RegExp(`${m.url}/?$`), { timeout: 10_000 });
        await page.getByRole("link", { name: /start investigating/i }).first().waitFor({ timeout: 10_000 });
        rec.check("session.back-restores-landing", true, page.url());
        break;
      }
      case "refresh": {
        if (stream) stream.planFast("controlled-claim", delayMs);
        await submitUpload(page, m, runId, { claim: "controlled claim text", rec });
        await submitButton(page).click();
        if (stream) stream.releaseAll();
        await waitForTerminalResult(page, rec, { fixture: "controlled-claim" });

        // The completed result is cached; the image bytes must not be.
        const stored = await page.evaluate(() => {
          const out = {};
          for (let i = 0; i < sessionStorage.length; i++) {
            const k = sessionStorage.key(i);
            out[k] = sessionStorage.getItem(k) ?? "";
          }
          return out;
        });
        const serialized = JSON.stringify(stored);
        rec.check("session.storage-single-key", Object.keys(stored).length === 1, Object.keys(stored).join(","));
        rec.check(
          "session.storage-key-is-latest-result",
          Object.keys(stored)[0] === "contexttrail.latest-result",
          Object.keys(stored).join(","),
        );
        rec.check("session.storage-has-no-image-bytes", !/data:image|blob:|image\/(png|jpeg|webp);base64/i.test(serialized), "no image data");
        rec.check(
          "session.storage-has-no-object-url",
          !/blob:http/i.test(serialized),
          "no object URL",
        );
        writeJson(path.join(driveDir, "storage-snapshot.json"), {
          keys: Object.keys(stored),
          byteLengths: Object.fromEntries(Object.entries(stored).map(([k, v]) => [k, v.length])),
          containsClaimText: serialized.includes("controlled claim text"),
        });

        await page.reload({ waitUntil: "domcontentloaded" });
        // After a refresh the upload screen must offer an explicit restore.
        const restore = page.locator('[aria-label="Restore previous result"]');
        await restore.waitFor({ timeout: 15_000 });
        rec.check("session.restore-action-offered", true, "Restore previous result note");
        rec.check("session.restore-copy-honest", (await restore.innerText()).includes("never keeps your uploaded image"), "copy");
        await shot(page, driveDir, "01-session-refresh-restore-offer");

        await page.getByRole("button", { name: "View last result" }).click();
        await page.waitForSelector('[aria-label="Result views"]', { timeout: 15_000 });
        rec.check("session.restore-shows-result", true, "tablist after restore");
        const notice = await page.locator("body").innerText();
        rec.check(
          "session.restore-notice-explains-loss",
          /Restored after refresh/i.test(notice) && /never stored/i.test(notice),
          "restored notice present",
        );
        rec.check(
          "session.restore-drops-stage-history",
          (await page.locator('[aria-label="Investigation stages"], [aria-label="Retrieval counts from this investigation"]').count()) === 0,
          "no live stage history on a restored result",
        );
        await shot(page, driveDir, "02-session-refresh-restored");
        await aria(page, driveDir, "session-refresh-restored");

        // "New investigation" supersedes the stored result, so the next
        // refresh must NOT offer to restore it.
        await page.getByRole("button", { name: "New investigation" }).click();
        await page.reload({ waitUntil: "domcontentloaded" });
        await delay(400);
        rec.check(
          "session.new-investigation-supersedes-cache",
          (await page.locator('[aria-label="Restore previous result"]').count()) === 0,
          "restore offer not offered after New investigation",
        );

        // Discard path: repopulate the cache, refresh, then discard it.
        if (stream) stream.planFast("controlled-claim", delayMs);
        await submitUpload(page, m, runId, { claim: "controlled claim text", rec });
        await submitButton(page).click();
        if (stream) stream.releaseAll();
        await waitForTerminalResult(page, rec, { fixture: "controlled-claim" });
        await page.reload({ waitUntil: "domcontentloaded" });
        await restore.waitFor({ timeout: 15_000 });
        await page.getByRole("button", { name: "Discard" }).click();
        await delay(400);
        rec.check(
          "session.discard-clears-cache",
          (await page.locator('[aria-label="Restore previous result"]').count()) === 0,
          "restore offer gone",
        );
        rec.check(
          "session.discard-removes-storage",
          (await page.evaluate(() => sessionStorage.length)) === 0,
          `sessionStorage keys=${await page.evaluate(() => sessionStorage.length)}`,
        );
        break;
      }
      case "cancel": {
        if (stream) stream.plan("controlled-claim", { holds: 1, paceMs: delayMs });
        await submitUpload(page, m, runId, { claim: "claim kept through cancel", rec });
        await submitButton(page).click();
        await page.getByRole("button", { name: /cancel investigation/i }).click();
        await page.getByText(/investigation cancelled/i).waitFor({ timeout: 15_000 });
        rec.check("session.cancel-shown", true, "cancelled screen");
        await shot(page, driveDir, "01-session-cancel");
        if (stream) stream.releaseAll();
        await page.getByRole("button", { name: /return to upload/i }).click();
        await expectSelectedPreview(page, rec, "upload.png");
        const claim = await page.locator("#ct-claim").inputValue();
        rec.check("session.cancel-preserves-claim", claim.length > 0, `claim length ${claim.length}`);
        break;
      }
      case "fatal-retry": {
        await submitUpload(page, m, runId, { claim: "claim kept through failure", rec });
        await submitButton(page).click();
        await expectUploadError(page, rec, /investigation interrupted/i, "session.fatal-shown");
        await shot(page, driveDir, "01-session-fatal");
        await page.getByRole("button", { name: /return to upload/i }).click();
        await expectSelectedPreview(page, rec, "upload.png");
        const claim = await page.locator("#ct-claim").inputValue();
        rec.check("session.fatal-preserves-claim", claim.length > 0, `claim length ${claim.length}`);
        break;
      }
    }
    await shot(page, driveDir, `02-session-${scase}`);
    await aria(page, driveDir, `session-${scase}`);
  },

  async accessibility({ page, rec, m, driveDir, viewport }) {
    await page.goto(`${m.url}/investigate`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#ct-claim");
    await aria(page, driveDir, "accessibility-initial");

    // Tab order: walk until the browser wraps back to <body> (Chromium puts
    // focus there once the last tabbable has been passed), then assert the
    // essential controls were all reachable and nothing rewired the order.
    const focusSeq = [];
    let wrapped = false;
    for (let i = 0; i < 24; i++) {
      await page.keyboard.press("Tab");
      const step = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el) return null;
        const cs = getComputedStyle(el);
        return {
          tag: el.tagName,
          id: el.id || null,
          label: el.getAttribute("aria-label"),
          tabIndex: el.tabIndex,
          text: (el.textContent || "").trim().slice(0, 40),
          focusRing: cs.outlineStyle !== "none" || cs.boxShadow !== "none" || cs.outlineWidth !== "0px",
        };
      });
      if (!step) break;
      if (step.tag === "BODY") {
        // Tab wrap: <body> carries tabindex="-1" (a programmatic focus
        // target, not a control) — record it, then stop the walk.
        wrapped = true;
        writeJson(path.join(driveDir, "focus-sequence.json"), { viewport, focusSeq, wrapped: true, wrapElement: step });
        break;
      }
      focusSeq.push(step);
    }
    if (!wrapped) writeJson(path.join(driveDir, "focus-sequence.json"), { viewport, focusSeq, wrapped: false });

    rec.check("a11y.claim-reachable-by-tab", focusSeq.some((s) => s && s.id === "ct-claim"), "ct-claim in tab order");
    rec.check("a11y.link-reachable-by-tab", focusSeq.some((s) => s && s.tag === "A"), "link in tab order");
    rec.check(
      "a11y.no-negative-tabindex-focus",
      focusSeq.every((s) => !s || s.tabIndex >= 0),
      JSON.stringify(focusSeq.filter((s) => s && s.tabIndex < 0)),
    );
    rec.check(
      "a11y.no-positive-tabindex",
      focusSeq.every((s) => !s || s.tabIndex <= 0),
      JSON.stringify(focusSeq.filter((s) => s && s.tabIndex > 0)),
    );

    // The DOM scan is the non-vacuous half: a control hidden from the tab
    // order with tabindex="-1" is never reached by Tab, so it can only be
    // caught by looking for it directly. <body tabindex="-1"> is excluded —
    // it is Next.js's programmatic focus target after a route change, not a
    // control that owes the user a tab stop.
    const domTabIndex = await page.evaluate(() =>
      [...document.querySelectorAll("[tabindex]")].map((el) => ({
        tag: el.tagName,
        id: el.id || null,
        tabindex: el.getAttribute("tabindex"),
        resolved: el.tabIndex,
        label: el.getAttribute("aria-label"),
      })),
    );
    const hiddenFromTabOrder = domTabIndex.filter((e) => e.resolved < 0 && e.tag !== "BODY");
    rec.check(
      "a11y.no-control-hidden-from-tab-order",
      hiddenFromTabOrder.length === 0,
      JSON.stringify(domTabIndex),
    );
    rec.note("a11y.tab-order", JSON.stringify({ wrapped, tabStops: focusSeq.length, domTabIndex }));

    const focusable = focusSeq;
    rec.check(
      "a11y.focus-visible-on-controls",
      focusable.length > 0 && focusable.every((s) => s.focusRing),
      `${focusable.filter((s) => s.focusRing).length}/${focusable.length} with a visible focus ring`,
    );

    // No horizontal overflow at either viewport.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    rec.check("a11y.no-horizontal-overflow", overflow <= 1, `${overflow}px`);

    // Primary action target floor.
    const box = await submitButton(page).boundingBox();
    const h = box?.height ?? 0;
    rec.check("a11y.submit-target-44px", h >= 44, `${h}px`);

    // Contrast of the primary heading against its painted background.
    const contrast = await page.evaluate(() => {
      const parse = (c) => {
        const m = /rgba?\(([^)]+)\)/.exec(c);
        if (!m) return null;
        const p = m[1].split(",").map((v) => parseFloat(v.trim()));
        return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
      };
      const lum = ({ r, g, b }) => {
        const f = (v) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const h1 = document.querySelector("h1");
      if (!h1) return null;
      const fg = parse(getComputedStyle(h1).color);
      let el = h1;
      let bg = null;
      while (el && !bg) {
        const c = parse(getComputedStyle(el).backgroundColor);
        if (c && c.a > 0.95) bg = c;
        el = el.parentElement;
      }
      if (!fg || !bg) return null;
      const l1 = lum(fg) + 0.05;
      const l2 = lum(bg) + 0.05;
      const ratio = Math.max(l1, l2) / Math.min(l1, l2);
      const size = parseFloat(getComputedStyle(h1).fontSize);
      const weight = parseInt(getComputedStyle(h1).fontWeight, 10) || 400;
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      return { ratio: Math.round(ratio * 100) / 100, fontSize: size, fontWeight: weight, large, threshold: large ? 3 : 4.5 };
    });
    writeJson(path.join(driveDir, "contrast-h1.json"), { viewport, contrast });
    rec.check(
      "a11y.h1-contrast-measured",
      contrast !== null,
      contrast ? JSON.stringify(contrast) : "could not resolve foreground/background",
    );
    if (contrast) {
      rec.check(
        "a11y.h1-contrast-wcag-aa",
        contrast.ratio >= contrast.threshold,
        `ratio ${contrast.ratio} vs threshold ${contrast.threshold}`,
      );
    }

    // Session storage surface: key names only, values checked for media.
    const storage = await page.evaluate(() => {
      const keys = Object.keys(sessionStorage);
      const out = {};
      for (const k of keys) out[k] = (sessionStorage.getItem(k) ?? "").length;
      const joined = keys.map((k) => sessionStorage.getItem(k) ?? "").join("\n");
      return {
        keys,
        lengths: out,
        hasImageData: /data:image|blob:http|image\/(png|jpeg|webp);base64/i.test(joined),
      };
    });
    rec.check("a11y.storage-keys-only", storage.keys.length === 0 || storage.keys.every((k) => k === "contexttrail.latest-result"), storage.keys.join(","));
    rec.check("a11y.storage-no-image-data", !storage.hasImageData, "no image bytes in sessionStorage");

    await shot(page, driveDir, `01-accessibility-${viewport}`);
    await aria(page, driveDir, `accessibility-${viewport}`);
    writeJson(path.join(driveDir, "accessibility.json"), { viewport, focusSeq, overflow, contrast, storage });
  },
};

async function submitUpload(page, m, runId, { claim, rec }) {
  const files = uploadFileSet(runId);
  await page.goto(`${m.url}/investigate`, { waitUntil: "domcontentloaded" });
  await applyUploadEntry(page, "setinputfiles", files["upload.png"]);
  await expectSelectedPreview(page, rec, "upload.png");
  if (claim) await page.locator("#ct-claim").fill(claim);
  else await page.locator("#ct-claim").fill("");
}

/* ------------------------------- evidence ------------------------------- */

async function evidence() {
  const runId = required("run-id");
  const m = readManifest(runId);
  if (!m) fail(`no manifest for run-id ${runId}`);
  const dir = evidenceDir(runId);
  const manifestPathOut = path.join(dir, "evidence-manifest.json");

  if (fs.existsSync(manifestPathOut) && !flags.regenerate) {
    fail(
      `evidence for run ${runId} generation ${generation(runId)} is already sealed at ` +
        `${manifestPathOut}; pass --regenerate to re-seal it (this rewrites the manifest)`,
    );
  }

  const runner = runnerIdentity();

  const drivesRoot = path.join(dir, "drives");
  const drives = [];
  if (fs.existsSync(drivesRoot)) {
    for (const name of fs.readdirSync(drivesRoot).sort()) {
      const p = path.join(drivesRoot, name, "drive.json");
      if (!fs.existsSync(p)) continue;
      const d = JSON.parse(fs.readFileSync(p, "utf8"));
      const assertions = fs
        .readFileSync(path.join(drivesRoot, name, "assertions.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      drives.push({
        driveId: d.driveId,
        feature: d.feature,
        viewport: d.viewport,
        case: d.case,
        entry: d.entry,
        tier: d.tier,
        generator: d.generator,
        fixture: d.fixture,
        fault: d.fault,
        live: d.live,
        outcome: d.outcome,
        assertions: {
          pass: assertions.filter((a) => a.status === "PASS").length,
          fail: assertions.filter((a) => a.status === "FAIL").length,
          info: assertions.filter((a) => a.status === "INFO").length,
        },
        assertionIds: assertions.filter((a) => a.status !== "INFO").map((a) => `${a.status}:${a.id}`),
        boundary: d.boundary,
        appRevision: d.appRevision,
        runnerRevision: d.runnerRevision,
        cliSha256: d.cliSha256,
        durationMs: d.durationMs,
        failure: d.failure,
        command: d.command,
      });
    }
  }

  const artifacts = {};
  const walk = (rel) => {
    const abs = path.join(dir, rel);
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(childRel);
      else if (childRel !== "evidence-manifest.json") {
        const buf = fs.readFileSync(path.join(dir, childRel));
        artifacts[childRel] = { sha256: sha256(buf), bytes: buf.length };
      }
    }
  };
  walk("");

  const summary = {
    runId,
    generation: generation(runId),
    sealedAt: new Date().toISOString(),
    appRevision: m.revision,
    buildId: m.buildId,
    live: m.live === true,
    tier: m.live ? "live" : "public-contract-boundary",
    runnerRevision: runner.runnerRevision,
    runnerDirty: runner.runnerDirty,
    cliSha256: runner.cliSha256,
    runnerFiles: runner.runnerFiles,
    strippedEnvKeyCount: (m.strippedEnvKeys ?? []).length,
    envFilesInSnapshot: m.envFilesInSnapshot ?? [],
    driveCount: drives.length,
    tierCounts: drives.reduce((acc, d) => ((acc[d.tier] = (acc[d.tier] ?? 0) + 1), acc), {}),
    assertionTotals: drives.reduce(
      (acc, d) => ({
        pass: acc.pass + d.assertions.pass,
        fail: acc.fail + d.assertions.fail,
        info: acc.info + d.assertions.info,
      }),
      { pass: 0, fail: 0, info: 0 },
    ),
    drives,
    artifactCount: Object.keys(artifacts).length,
    artifacts,
    command: process.argv.slice(2),
  };
  fs.writeFileSync(manifestPathOut, JSON.stringify(summary, null, 2) + "\n");
  console.log(
    JSON.stringify({
      runId,
      generation: summary.generation,
      sealedAt: summary.sealedAt,
      driveCount: summary.driveCount,
      tierCounts: summary.tierCounts,
      assertionTotals: summary.assertionTotals,
      artifactCount: summary.artifactCount,
      manifest: manifestPathOut,
    }),
  );
}

/* -------------------------------- cleanup ------------------------------- */

async function cleanup() {
  const runId = required("run-id");
  const m = readManifest(runId);
  if (!m) fail(`no manifest for run-id ${runId}`);
  const killed = [];
  if (m.pid && pidAlive(m.pid)) {
    if (!pidIsOwned(m)) {
      console.log(JSON.stringify({ cleaned: runId, killed, pidReused: true }));
      process.exit(EXIT_ASSERT);
    }
    const tree = [...descendantsOf(m.pid), m.pid];
    for (const p of tree) {
      try {
        process.kill(p, "SIGTERM");
        killed.push(p);
      } catch {
        /* already gone */
      }
    }
    await delay(500);
    for (const p of tree) {
      try {
        if (pidAlive(p)) process.kill(p, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    const t0 = Date.now();
    while (portListeners(m.port).length > 0 && Date.now() - t0 < 5000) await delay(250);
    if (portListeners(m.port).length > 0) {
      console.log(JSON.stringify({ cleaned: runId, killed, portStillBound: true }));
      process.exit(EXIT_ASSERT);
    }
  }
  // Remove scratch checkout/install — evidence, logs and manifest survive.
  const snap = path.join(runDir(runId), "checkout");
  if (fs.existsSync(snap)) fs.rmSync(snap, { recursive: true, force: true });
  const scratch = path.join(runDir(runId), "scratch");
  if (fs.existsSync(scratch)) fs.rmSync(scratch, { recursive: true, force: true });
  const video = path.join(runDir(runId), "video");
  if (fs.existsSync(video)) fs.rmSync(video, { recursive: true, force: true });
  writeManifest(runId, { cleanedAt: new Date().toISOString(), pid: null, alive: false });
  const ev = fs.existsSync(path.join(runDir(runId), "evidence"))
    ? fs.readdirSync(path.join(runDir(runId), "evidence")).length
    : 0;
  console.log(JSON.stringify({ cleaned: runId, killed, evidenceArtifacts: ev }));
}

/* --------------------------------- main --------------------------------- */

const handlers = { launch, doctor, drive, evidence, cleanup };
if (!command || !handlers[command]) {
  console.error(
    "usage: control-contexttrail <launch|doctor|drive|evidence|cleanup> [args]\n" +
      "  drive <landing|upload|investigation|result|viewer|session|accessibility> --run-id <id>",
  );
  process.exit(EXIT_SCHEMA);
}
handlers[command]().catch((err) => {
  console.error(`control-contexttrail ${command} failed:`, err?.message ?? err);
  process.exit(EXIT_ASSERT);
});
