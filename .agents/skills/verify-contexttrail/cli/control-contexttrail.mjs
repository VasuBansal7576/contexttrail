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
 *            [--live-manifest <path>]
 *   live-ready --run-id <id> --manifest <path> --image <path> [--mode trace|claim]
 *            [--claim-text <text>]
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
 *    drives in the same generation are refused. Each drive keeps the exact
 *    fixture bytes and the finished, uncut recording it produced, and an
 *    interrupted drive is reported as incomplete instead of being skipped.
 *  - A live drive submits the operator's own --image/--claim-text under a
 *    --live-manifest that names the public source, its sha256, the mode/claim
 *    and the credit acknowledgement. `live-ready` validates that contract with
 *    no provider call, so readiness is provable without spending credit, and
 *    `live-handler` runs the production result/viewer handler against an
 *    intercepted, locally declared result — live semantics, zero provider
 *    calls, and no fixture expectation anywhere in the handler.
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
    "live-manifest",
    "live",
    "no-video",
  ],
  "live-ready": [...BASE_FLAGS, "manifest", "image", "claim-text", "mode"],
  "live-handler": [
    ...BASE_FLAGS,
    "feature",
    "declared-result",
    "manifest",
    "image",
    "claim-text",
    "mode",
    "viewport",
  ],
  evidence: [...BASE_FLAGS, "regenerate"],
  cleanup: [...BASE_FLAGS],
};

/* ----------------------------- run state ------------------------------- */

/**
 * Every command's own schema, validated before ANY side effect: no manifest
 * read, no port probe, no browser, no filesystem write. A command that accepts
 * an option it does not implement is a silent success, so an unknown flag, a
 * duplicated flag, a boolean given a value or an extra positional argument all
 * exit 2 first.
 */
function enforceCommandSchema(command, { requiredOptions = [], positionalMax = 1 } = {}) {
  const allowed = COMMAND_FLAGS[command];
  if (!allowed) fail(`unknown command ${command}`);
  const unknown = Object.keys(flags).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    fail(`unsupported option(s) for ${command}: ${unknown.map((k) => `--${k}`).join(", ")}`);
  }
  if (positional.length > positionalMax) {
    const extra = positional.slice(positionalMax);
    fail(`unexpected argument(s) for ${command}: ${extra.map((a) => JSON.stringify(a)).join(", ")}`);
  }
  for (const opt of requiredOptions) required(opt);
}

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

function retainedControlNames() {
  const dir = path.join(FIXTURES_DIR, "controls", "retained");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".ndjson"))
    .map((f) => f.replace(/\.ndjson$/, ""));
}

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

/** Set when the drive replays a control from Astra's retained manifest, so the
 *  evidence records which bytes proved it rather than only which case name. */
let retainedSha256 = null;

/** Astra's retained C7 controls, with the sha256 of the exact bytes she
 *  captured on app ea1b539. Copied in as a manifest only: the .ndjson files stay
 *  untracked private data, so a replayed control is proven byte-identical rather
 *  than merely named. Any drift fails the run instead of quietly changing what
 *  the opposing control proves. */
function retainedControlDigest(name) {
  const manifest = path.join(FIXTURES_DIR, "controls", "astra-c7-controls.json");
  if (!fs.existsSync(manifest)) return null;
  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(manifest, "utf8"));
  } catch {
    return null;
  }
  const hit = Array.isArray(entries) ? entries.find((e) => e && e.name === name) : null;
  return hit ? { sha256: hit.sha256, mutation: hit.mutation, derivedFrom: hit.derivedFrom } : null;
}

/**
 * Which generator produced the controlled fixtures, for stream provenance. The
 * fixtures carry no generator field, so this is the declared identity from the
 * generator that owns them, not an inference from their contents.
 */
const GENERATOR_IDENTITY = "fixtures/gen-fixtures.test.ts (CONTEXTTRAIL_GEN_FIXTURES=1) via runInvestigation";

function fixturePath(name) {
  // A maintained fixture always wins, so a private stream can never shadow one
  // of ours by name; a retained control is found beside the manifest that pins
  // its digest. Keeping the bytes out of fixtures/ root also keeps the fixture
  // contract suite from treating someone else's control as a maintained case.
  const p = path.join(FIXTURES_DIR, `${name}.ndjson`);
  if (fs.existsSync(p)) return p;
  const retained = path.join(FIXTURES_DIR, "controls", "retained", `${name}.ndjson`);
  if (fs.existsSync(retained)) return retained;
  fail(`unknown fixture case ${name} (available: ${fixtureNames().join(", ") || "none"})`);
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

/**
 * npm configuration that silently changes DEPENDENCY RESOLUTION rather than
 * where packages come from. Inheriting these makes a launch depend on the
 * caller's shell: `npm_config_include=dev` in the parent makes `npm ci` install
 * the TypeScript/build toolchain even under NODE_ENV=production, so a
 * documented minimal keyless launch only works on a machine that happens to
 * export it. They are dropped from every child environment; registry/proxy
 * settings are still inherited because they do not change which packages are
 * installed.
 */
const ENV_DENY_NPM_RESOLUTION = new Set([
  "npm_config_include",
  "npm_config_omit",
  "npm_config_only",
  "npm_config_production",
  "npm_config_dev",
  "npm_config_legacy_peer_deps",
  "npm_config_strict_peer_deps",
  "npm_config_ignore_scripts",
  "NPM_CONFIG_INCLUDE",
  "NPM_CONFIG_OMIT",
  "NPM_CONFIG_ONLY",
  "NPM_CONFIG_PRODUCTION",
  "NPM_CONFIG_DEV",
  "NPM_CONFIG_LEGACY_PEER_DEPS",
  "NPM_CONFIG_STRICT_PEER_DEPS",
  "NPM_CONFIG_IGNORE_SCRIPTS",
]);

/** Names of the variables that were present but deliberately not forwarded. */
function strippedEnvNames() {
  return Object.keys(process.env)
    .filter(
      (k) =>
        !ENV_ALLOW_EXACT.has(k) &&
        !ENV_ALLOW_PREFIX.some((p) => k.startsWith(p)) &&
        !ENV_DENY_NPM_RESOLUTION.has(k),
    )
    .sort();
}

/** Names of resolution-changing npm config present in THIS process. */
function inheritedNpmResolutionKeys() {
  return Object.keys(process.env)
    .filter((k) => ENV_DENY_NPM_RESOLUTION.has(k))
    .sort();
}

function inheritedEnv(extra = {}) {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (ENV_DENY_NPM_RESOLUTION.has(k)) continue;
    if (ENV_ALLOW_EXACT.has(k) || ENV_ALLOW_PREFIX.some((p) => k.startsWith(p))) out[k] = v;
  }
  return { ...out, ...extra };
}

/**
 * The three child environments are deliberately different.
 *
 *  - install: NO NODE_ENV at all. npm derives `omit=dev` from
 *    NODE_ENV=production, so an install under it silently drops the TypeScript
 *    and build toolchain and the build that follows cannot run. The install
 *    also passes `--include=dev` explicitly, so the dependency set is a
 *    property of the command rather than of an inherited variable.
 *  - build:   NODE_ENV=production, the mode the bundle is compiled for.
 *  - runtime: NODE_ENV=production, no dev dependencies loaded.
 *
 * Credential stripping is unchanged and applies to all three.
 */
function installEnv() {
  const out = inheritedEnv();
  delete out.NODE_ENV;
  return out;
}

function buildEnv() {
  return inheritedEnv({ NODE_ENV: "production" });
}

function runtimeEnv() {
  return inheritedEnv({ NODE_ENV: "production" });
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

/** Packages the production build cannot run without. Their absence is the
 *  failure a production-mode `npm ci` causes, so it is checked explicitly. */
const BUILD_DEPS = ["typescript", "next", "react", "react-dom"];
const BUILD_DEPS_OPTIONAL = ["tailwindcss", "vitest"];

function buildDependencyReport(snapshotDir) {
  const mods = path.join(snapshotDir, "node_modules");
  const present = (name) => fs.existsSync(path.join(mods, name, "package.json"));
  const required = BUILD_DEPS.filter(present);
  const missing = BUILD_DEPS.filter((n) => !present(n));
  return {
    complete: missing.length === 0,
    required: BUILD_DEPS,
    present: required,
    missing,
    optionalPresent: BUILD_DEPS_OPTIONAL.filter(present),
  };
}

/* -------------------------------- launch -------------------------------- */

async function launch() {
  enforceCommandSchema("launch", { requiredOptions: ["checkout", "run-id"] });

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
    // Names only — these were in the caller's environment and are dropped so
    // the install does not depend on the caller's shell.
    droppedNpmResolutionKeys: inheritedNpmResolutionKeys(),
    envFilesInSnapshot: envFiles,
    stage: "install",
    ready: false,
  });

  const installLog = fs.openSync(path.join(logDir, "install.log"), "w");
  // `--include=dev` is explicit: the build toolchain is required by the build
  // step and must not depend on NODE_ENV or on an inherited npm variable.
  execFileSync("npm", ["ci", "--include=dev"], {
    cwd: snap,
    stdio: ["ignore", installLog, installLog],
    env: installEnv(),
  });
  // A missing build dependency is otherwise discovered as an inscrutable
  // "next build" failure; record the fact that the toolchain is present.
  const buildDeps = buildDependencyReport(snap);
  if (!buildDeps.complete) {
    console.log(
      JSON.stringify({
        launched: false,
        reason: "build dependencies missing after install",
        buildDeps,
        logDir,
      }),
    );
    process.exit(EXIT_ASSERT);
  }
  writeManifest(runId, { buildDeps });
  writeManifest(runId, { stage: "build" });
  const buildLog = fs.openSync(path.join(logDir, "build.log"), "w");
  execFileSync("npm", ["run", "build"], {
    cwd: snap,
    stdio: ["ignore", buildLog, buildLog],
    env: buildEnv(),
  });
  const buildId = fs.readFileSync(path.join(snap, ".next", "BUILD_ID"), "utf8").trim();
  writeManifest(runId, { buildId, stage: "start" });

  const serverLog = fs.openSync(path.join(logDir, "server.log"), "w");
  const child = spawn("npm", ["start", "--", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: snap,
    detached: true,
    stdio: ["ignore", serverLog, serverLog],
    env: runtimeEnv(),
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
  // Schema first: `doctor extra-positional` and `doctor --nonsense` must be
  // rejected before the run is inspected, not reported healthy.
  enforceCommandSchema("doctor", { requiredOptions: ["run-id"] });

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

  // The build toolchain must be in the snapshot: an install that ran with
  // NODE_ENV=production produces a served bundle from a missing-dependency
  // build, and this is the check that would have caught it.
  const buildDeps = fs.existsSync(m.snapshot) ? buildDependencyReport(m.snapshot) : null;
  checks.buildDependenciesPresent = buildDeps ? buildDeps.complete : true;
  if (buildDeps) {
    checks.buildDepsMatchManifest =
      m.buildDeps === undefined || m.buildDeps.complete === buildDeps.complete;
  }

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
      droppedNpmResolutionKeys: m.droppedNpmResolutionKeys ?? [],
      buildDeps,
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

/** Videos retained inside per-drive evidence, counted from evidence itself. */
function countEvidenceVideos(dir) {
  const drives = path.join(dir, "drives");
  let n = 0;
  try {
    for (const d of fs.readdirSync(drives)) {
      const v = path.join(drives, d, "video");
      if (!fs.existsSync(v)) continue;
      n += fs.readdirSync(v).filter((f) => f.endsWith(".webm")).length;
    }
  } catch {
    return n;
  }
  return n;
}

/**
 * Playwright finalizes a context recording asynchronously *after* the context
 * closes, so the file may not exist — or may still be growing — while the drive
 * is running. Snapshot what exists now so a finished file can be recognised
 * afterwards.
 */
function snapshotVideos(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".webm"))
      .sort()
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { file: f, bytes: st.size };
      });
  } catch {
    return [];
  }
}

/**
 * Copy the ORIGINAL, uncut recordings into the drive's own evidence directory
 * and index each with its exact provenance. Nothing is trimmed, re-encoded or
 * synthesised: the bytes are the browser's own output, copied once it is
 * complete. Videos that never finished are reported as missing rather than
 * passed over silently.
 */
function collectVideos(staged, videoDir, driveDir) {
  const final = snapshotVideos(videoDir);
  const stagedByName = new Map(staged.map((s) => [s.file, s]));
  const outDir = path.join(driveDir, "video");
  const collected = [];
  const missing = [];
  for (const v of final) {
    const before = stagedByName.get(v.file);
    if (before && before.bytes === v.bytes) continue; // never grew: a stale partial
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const dest = path.join(outDir, v.file);
    fs.copyFileSync(path.join(videoDir, v.file), dest);
    const buf = fs.readFileSync(dest);
    collected.push({
      file: `video/${v.file}`,
      bytes: buf.length,
      sha256: sha256(buf),
      source: "playwright-context-recording",
      copied: true,
    });
  }
  for (const s of staged) {
    if (!final.some((v) => v.file === s.file)) {
      missing.push({ file: s.file, bytesAtSnapshot: s.bytes, reason: "discarded by the browser" });
    }
  }
  return { collected, missing, staged: staged.length, finalized: collected.length };
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
      // A hash, never the value: the submitted claim can be compared with what
      // the drive intended without the request body entering the evidence.
      sha256: fn?.[1] ? null : sha256(Buffer.from(body, "latin1")),
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
    /** Per-request plans for a two-stream run: [{fixture, holds}]. */
    sequence: null,
    /** Live response handles by request index, for an explicit late-write attempt. */
    responses: {},
    /** The request handler resolves a per-request plan through these. */
    segmentsFor(plan) {
      return plan.segments;
    },
    holdsFor(plan) {
      return plan.holds;
    },
    /** One row per served request; the honest record of what was and was not
     *  deliverable, so an undelivered late packet is never implied to have been
     *  processed by the client. */
    ledger: [],
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
      // Captured BEFORE the counter moves, so request 0 is index 0. Reading it
      // after the increment labelled the first request 1 and the second 2, which
      // would hand A's stream to B's plan and misattribute every ownership
      // assertion that follows.
      const reqIndex = state.received;
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

      // A two-stream run needs the SECOND request to get a DIFFERENT fixture, so
      // the plan is per request rather than one shared plan. Everything about a
      // request is recorded in a ledger, including a late write the client could
      // not possibly receive.
      const sentFields = parseMultipart(body, req.headers["content-type"] ?? "");
      const entry = {
        index: reqIndex,
        fixture: state.sequence?.[reqIndex]?.fixture ?? state.planName ?? null,
        // What THIS request actually carried, as HASHES ONLY. parseMultipart
        // deliberately never returns field values — the submitted claim can be
        // compared with what the drive intended without the request body entering
        // the evidence — and that rule is kept here rather than worked around.
        sentClaimSha256: sentFields?.claim?.sha256 ?? null,
        sentClaimBytes: sentFields?.claim?.bytes ?? null,
        sentMediaName: sentFields?.media?.filename ?? null,
        sentMediaBytes: sentFields?.media?.bytes ?? null,
        // How the harness put the image in: a real file input via setInputFiles,
        // not a native file-chooser interaction and not a React setter.
        imageEntryMethod: "setInputFiles",
        eventsWritten: 0,
        firstBytesAt: Date.now(),
        clientClosed: false,
        clientClosedAt: null,
        endedByServer: false,
        lateAttempts: [],
      };
      state.ledger.push(entry);
      state.responses[reqIndex] = res;
      const active = state.sequence?.[reqIndex];
      const segs = active ? state.segmentsFor(active) : (state.segments ?? []);
      const holds = active ? state.holdsFor(active) : state.holds;
      let closed = false;
      res.on("close", () => {
        closed = true;
        state.disconnected = true;
        entry.clientClosed = true;
        entry.clientClosedAt = Date.now();
        for (const h of holds) h?.resolveReached?.();
      });

      try {
        for (let i = 0; i < segs.length; i++) {
          if (closed || res.writableEnded) return;
          for (const line of segs[i]) {
            if (closed || res.writableEnded) return;
            res.write(line + "\n");
            state.eventsWritten++;
            entry.eventsWritten++;
          }
          const hold = holds[i];
          if (hold) {
            hold.resolveReached();
            await hold.releasePromise;
          }
        }
        if (!closed && !res.writableEnded) {
          res.end();
          entry.endedByServer = true;
        }
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
    /**
     * Two-stream plan: request N gets plans[N]. Without this every request gets
     * the same stream, so two consecutive investigations are indistinguishable and
     * ownership between them cannot be observed at all.
     */
    planSequence(plans) {
      state.sequence = plans.map((p) => {
        const lines = fs.readFileSync(fixturePath(p.fixture), "utf8").split("\n").filter((l) => l.trim());
        const all = buildSegments(lines);
        const n = Math.max(0, Math.min(p.holds ?? 0, all.length - 1));
        const held = all.slice(0, n);
        const tail = all.slice(n);
        const segments = n > 0 ? [...held, tail.flat()] : [lines];
        const holds = segments.map((_, i) => {
          if (i >= n) return null;
          let resolveReached;
          const reachedP = new Promise((r) => (resolveReached = r));
          let resolveRelease;
          const releasePromise = new Promise((r) => (resolveRelease = r));
          return { reached: reachedP, releasePromise, resolveReached, resolveRelease };
        });
        // The EXACT bytes this stream will be served from, retained and hashed at
        // the point the sequence reads them, plus the generator identity, so a
        // replay can be tied to the bytes rather than to a fixture name.
        const raw = fs.readFileSync(fixturePath(p.fixture));
        const bytes = raw.length;
        const sha256 = crypto.createHash("sha256").update(raw).digest("hex");
        // The EXACT buffer, kept for the life of the run: the titles and the
        // retained per-drive copy are both derived from these bytes, so neither can
        // drift from what the stream was actually served from.
        const buffer = raw;
        const id = (() => {
          for (const l of lines) {
            try {
              const ev = JSON.parse(l);
              if (ev.investigationId) return ev.investigationId;
            } catch { /* keep looking */ }
          }
          return null;
        })();
        return { fixture: p.fixture, segments, holds, id, bytes, sha256, buffer, generator: GENERATOR_IDENTITY };
      });
      state.paceMs = Math.max(0, plans[0]?.paceMs ?? 0);
      return { plans: state.sequence.map((p) => ({ fixture: p.fixture, id: p.id, segments: p.segments.length })) };
    },
    segmentsFor(plan) {
      return plan.segments;
    },
    holdsFor(plan) {
      return plan.holds;
    },
    /** Wait for request `index`'s segment `i` to be reached. */
    async reachedFor(index, i, ms = 8000) {
      const plan = state.sequence?.[index];
      if (!plan) return false;
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const entry = state.ledger.find((e) => e.index === index);
        if (entry && entry.eventsWritten >= plan.segments.slice(0, i + 1).flat().length) return true;
        await delay(50);
      }
      return false;
    },
    releaseFor(index, i) {
      state.sequence?.[index]?.holds[i]?.resolveRelease?.();
    },
    releaseAllFor(index) {
      for (const h of state.sequence?.[index]?.holds ?? []) h?.resolveRelease?.();
    },
    /**
     * Attempt to deliver a late event to a stream the client has already aborted.
     * The outcome is recorded either way: `delivered: false` with the reason is the
     * honest result, and the ledger exists so an undeliverable packet is never
     * reported as if the client had processed a late event.
     */
    attemptLate(index, line) {
      const entry = state.ledger.find((e) => e.index === index);
      const res = state.responses[index];
      const attempt = {
        at: Date.now(),
        bytes: Buffer.byteLength(line),
        delivered: false,
        reason: null,
      };
      if (!entry) attempt.reason = "no such request reached the transport";
      else if (!res) attempt.reason = "response handle released";
      else if (entry.clientClosed) attempt.reason = "client aborted and closed the response before the write";
      else if (res.writableEnded) attempt.reason = "response already ended";
      else {
        try {
          res.write(line + "\n");
          entry.eventsWritten++;
          attempt.delivered = true;
          attempt.reason = "written to an open response";
        } catch (err) {
          attempt.reason = `write failed: ${err.message}`;
        }
      }
      entry?.lateAttempts.push(attempt);
      return attempt;
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

/* ---------------------------- live readiness ---------------------------- */

/**
 * A live run must name the public input it is about to submit. Nothing about
 * a provider outcome is predicted here — this contract is entirely about
 * INPUTS: which image, from which public source, with which hash, under which
 * mode and claim, with provider credit explicitly acknowledged.
 *
 * It is validated locally, with no browser, no provider request and no
 * credential read, so it can be exercised in a zero-provider run.
 */
const LIVE_MANIFEST_SCHEMA = "contexttrail-live-readiness.v1";

function readLiveManifest(manifestPath) {
  const p = path.resolve(manifestPath);
  if (!fs.existsSync(p)) fail(`--live-manifest not found: ${manifestPath}`);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (err) {
    fail(`--live-manifest is not valid JSON: ${err.message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail("--live-manifest must be a JSON object");
  }
  return { path: p, raw, sha256: sha256(fs.readFileSync(p)) };
}

function liveManifestValue(key) {
  // `drive --live` and `live-handler` name the manifest with different flags.
  const which = flags["live-manifest"] ?? flags.manifest;
  if (which === undefined) return null;
  const { raw } = readLiveManifest(which);
  return typeof raw[key] === "string" ? raw[key] : null;
}

/** A public input source: a real absolute http(s) URL, never a local path or
 *  a loopback/private address standing in for "public". */
function isPublicHttpUrl(value) {
  let u;
  try {
    u = new URL(String(value));
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const h = u.hostname.toLowerCase();
  if (!h || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return false;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
  if (h === "[::1]" || h === "::1") return false;
  return true;
}

/**
 * Per-rule readiness verdicts for one candidate live input set. Each entry is
 * a claim about the INPUT contract only.
 */
function liveReadinessChecks({ manifest, imagePath, mode, claimText }) {
  const raw = manifest.raw;
  const checks = [];
  const add = (id, cond, detail) => checks.push({ id, status: cond ? "PASS" : "FAIL", detail });

  add("live-ready.schema", raw.schema === LIVE_MANIFEST_SCHEMA, `schema=${String(raw.schema)}`);
  add(
    "live-ready.image-source-public",
    isPublicHttpUrl(raw.imageSource),
    `imageSource=${String(raw.imageSource)}`,
  );
  add(
    "live-ready.image-source-is-not-a-provider-call",
    !/serpapi|typesafe\.ai|openai\.com|anthropic\.com/i.test(String(raw.imageSource)),
    "the input source is a public page, not a provider endpoint",
  );

  const abs = path.resolve(imagePath);
  if (!fs.existsSync(abs)) {
    add("live-ready.image-exists", false, `image not found: ${imagePath}`);
    add("live-ready.image-hash-matches", false, "no image to hash");
    add("live-ready.image-bytes-match", false, "no image to measure");
  } else {
    add("live-ready.image-exists", true, path.basename(abs));
    const bytes = fs.readFileSync(abs);
    add("live-ready.image-hash-matches", raw.imageSha256 === sha256(bytes), `sha256=${sha256(bytes)}`);
    add(
      "live-ready.image-bytes-match",
      typeof raw.imageBytes === "number" ? raw.imageBytes === bytes.length : false,
      `bytes=${bytes.length} manifest=${String(raw.imageBytes)}`,
    );
    add(
      "live-ready.image-is-a-real-image",
      isRenderableImage(bytes),
      `type=${mediaType(abs)} bytes=${bytes.length}`,
    );
  }

  add("live-ready.mode-matches", raw.mode === mode, `manifest=${String(raw.mode)} requested=${mode}`);
  if (mode === "claim") {
    add("live-ready.claim-matches", typeof raw.claim === "string" && raw.claim === claimText,
      `manifest claim length=${String(raw.claim ?? "").length} requested length=${String(claimText ?? "").length}`);
  } else {
    add(
      "live-ready.claim-absent-in-trace-mode",
      raw.claim === undefined || raw.claim === null || raw.claim === "",
      "a trace run must not carry a claim",
    );
    // And the harness must not be about to submit one either.
    add(
      "live-ready.claim-not-submitted-in-trace-mode",
      claimText === null || claimText === "",
      `claimText length=${String(claimText ?? "").length}`,
    );
  }
  add(
    "live-ready.credit-acknowledged",
    raw.acknowledgedProviderCredit === true,
    `acknowledgedProviderCredit=${String(raw.acknowledgedProviderCredit)}`,
  );
  // A readiness manifest must not smuggle credential material into evidence.
  const serialised = JSON.stringify(raw);
  add(
    "live-ready.no-credential-material",
    !/[?&](?:key|api_key|apikey|token|secret)=/i.test(serialised) &&
      !/\b(?:sk|pk|api)[-_][A-Za-z0-9]{8,}/.test(serialised) &&
      !/Bearer\s+[A-Za-z0-9._-]{16,}/.test(serialised),
    "manifest carries no key name=value or bearer material",
  );
  return checks;
}

/** Magic-number check — a "public image" that is not an image proves nothing. */
function isRenderableImage(bytes) {
  return (
    (bytes.length > 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47) ||
    (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
    (bytes.length > 12 &&
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP") ||
    (bytes.length > 3 && bytes.subarray(0, 3).toString("ascii") === "GIF")
  );
}

/**
 * Zero-provider control for the live INPUT contract. Never launches a
 * browser, never contacts a provider, never reads a credential.
 */
async function liveReady() {
  enforceCommandSchema("live-ready", { requiredOptions: ["run-id", "manifest", "image"] });

  const runId = required("run-id");
  // A sealed generation is immutable: writing a readiness record after the seal
  // would leave artifacts the manifest does not list.
  if (manifestSealed(runId)) {
    fail(
      `evidence for run ${runId} generation ${generation(runId)} is sealed; ` +
        "a readiness control would add unlisted artifacts — relaunch with --new-generation",
    );
  }
  const manifest = readLiveManifest(required("manifest"));
  const imagePath = required("image");
  const mode = flags.mode ?? "trace";
  if (mode !== "trace" && mode !== "claim") {
    fail(`unsupported --mode ${mode} (supported: trace|claim)`);
  }
  const claimText = flags["claim-text"] ?? null;
  if (mode === "claim" && (claimText === null || claimText.trim() === "")) {
    fail("--mode claim requires --claim-text (the claim actually under test)");
  }

  const checks = liveReadinessChecks({ manifest, imagePath, mode, claimText });
  const base = path.join(evidenceDir(runId), "readiness");
  fs.mkdirSync(base, { recursive: true });
  const seq = fs.readdirSync(base).filter((e) => /^\d{3}-/.test(e)).length + 1;
  const dir = path.join(base, `${String(seq).padStart(3, "0")}-live-ready`);
  const rec = new Recorder(dir);
  for (const c of checks) rec.push(c.id, c.status, c.detail);
  rec.close();

  const record = {
    control: "live-ready",
    // Truthful label: this proves the live INPUT contract only. No provider
    // call was made and no provider outcome is claimed.
    tier: "public-contract-boundary",
    providerAttempted: 0,
    note: "validates live input manifest; performs no provider call and makes no live claim",
    manifestPath: manifest.path,
    manifestSha256: manifest.sha256,
    imagePath: path.resolve(imagePath),
    imageSha256: fs.existsSync(path.resolve(imagePath))
      ? sha256(fs.readFileSync(path.resolve(imagePath)))
      : null,
    mode,
    claimProvided: typeof claimText === "string" && claimText.trim().length > 0,
    checks,
    pass: checks.filter((c) => c.status === "PASS").length,
    fail: checks.filter((c) => c.status === "FAIL").length,
    command: process.argv.slice(2),
    at: new Date().toISOString(),
  };
  writeJson(path.join(dir, "readiness.json"), record);
  console.log(JSON.stringify({ runId, ...record, dir }));
  process.exit(record.fail === 0 ? 0 : EXIT_ASSERT);
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
  "pair-endpoint-wrong": "render a wrong evidence id in the open viewer while a paired-divergence note is shown",
  "pair-note-wrong": "rewrite the paired-divergence note into a same-context claim",
  "focus-return-broken": "drop focus to <body> as soon as the viewer dialog closes",
  "focus-ring-hidden": "remove every focus indicator, so real keyboard focus paints nothing",
  "contrast-lowered": "lower the body text colour until the composited ratio falls under its floor",
  "tab-map-broken": "make ArrowRight/Home move focus without selecting the matching tab or panel",
  "long-value-truncated": "clip long values to one line with overflow:hidden, so they are cut instead of wrapped",
  "reading-order-reversed": "reverse the visual order of the Sources list with column-reverse, DOM order untouched",
  "reading-order-restored": "apply that reversal, then remove it, so the same assertion can be seen recovering",
  "stale-a-inserted": "append a plainly visible old-A-only title to B's completed result",
};

const FAULT_SCRIPT = `window.__ctFault = (mode) => {
  let err = false;
  // A fault that never fires must not be reported green: each branch counts the
  // mutations it actually performed, and the drive reads the count afterwards.
  window.__ctFaultHits = 0;
  const hit = () => { window.__ctFaultHits++; };
  const alter = () => {
    if (mode === "stale-a-inserted") {
      // A native DOM control, not a product mutation: once a completed result is
      // on screen, append a VISIBLE block carrying a title that belongs only to A.
      // A stale-content guard that cannot see this proves nothing, so this is the
      // opposing control for ownership.no-stale-a-content-on-completed-overview.
      if (document.getElementById("ct-stale-a")) return;
      const heading = document.querySelector("h1");
      if (!heading || !/insufficient evidence|possible context conflict|no corroborating/i.test(document.body.innerText || "")) {
        return; // not on a completed result yet; the poll retries
      }
      const stale = document.createElement("section");
      stale.id = "ct-stale-a";
      stale.setAttribute("aria-label", "Earlier investigation");
      stale.className = "mx-auto max-w-3xl px-5 py-6";
      stale.innerHTML =
        "<h2>Earlier investigation</h2><p>CONTROLLED FIXTURE contextual article</p>";
      heading.parentElement.insertBefore(stale, heading.nextSibling);
      hit();
    } else if (mode === "bad-selection") {
      document.querySelectorAll('[role="tab"]').forEach((tab) => {
        if (tab.textContent.trim() === "Sources" && tab.getAttribute("aria-selected") === "true") {
          tab.setAttribute("aria-selected", "false");
          hit();
        }
      });
    } else if (mode === "a11y-false-green") {
      const input = document.getElementById("ct-image-input");
      if (input && input.tabIndex !== -1) { input.tabIndex = -1; hit(); }
      const h1 = document.querySelector("h1");
      if (h1 && h1.style.color !== "transparent") { h1.style.color = "transparent"; hit(); }
      if (h1 && !err) { err = true; console.error("CONTROLLED_UNEXPECTED_UI_ERROR"); hit(); }
    } else if (mode === "anchor-broken") {
      const s = document.getElementById("how-it-works");
      if (s && s.id) { s.removeAttribute("id"); hit(); }
    } else if (mode === "focus-removed") {
      const c = document.getElementById("ct-claim");
      if (c && c.tabIndex !== -1) { c.tabIndex = -1; hit(); }
    } else if (mode === "unexpected-request") {
      if (!window.__ctFaultFired) {
        window.__ctFaultFired = true;
        hit();
        fetch("https://serpapi.com/search?api_key=CONTROLLED_FAULT&tbm=isch").catch(() => {});
      }
    } else if (mode === "group-mislabel") {
      // Rewriting the headline is idempotent: once it no longer starts with
      // "Reporting group of" the branch stops matching, so the observer
      // settles instead of looping.
      document.querySelectorAll("#ct-panel-analysis li p").forEach((p) => {
        const t = (p.textContent || "").trim();
        const m = /^Reporting group of (\\d+) occurrence/.exec(t);
        if (m) { p.textContent = "Shared group of " + m[1] + " occurrence" + (m[1] === "1" ? "" : "s") + t.slice(m[0].length); hit(); }
      });
    } else if (mode === "long-value-truncated") {
      // The real defect: a long value clipped to a single line. Layout-only, so the
      // text is still in the DOM and still "present" to a text scan.
      const st = document.createElement("style");
      st.id = "ct-long-value-truncated";
      st.textContent =
        "li,dd,p,span,a,td{max-height:1.4em;overflow:hidden;white-space:nowrap !important;text-overflow:clip !important;}";
      if (document.head) { document.head.appendChild(st); hit(); }
    } else if (mode === "reading-order-reversed" || mode === "reading-order-restored") {
      // The EXPLICIT target: the selected tab's own aria-controls panel, its
      // Sources section, its list, and the DIRECT visible li children. Guessing an
      // ancestor is what made earlier attempts change nothing — the rows are
      // nested below the panel.
      if (window.__ctLayoutFault) return;
      const tab = [...document.querySelectorAll('[role="tab"]')].find(
        (t) => t.getAttribute("aria-selected") === "true",
      );
      const panelId = tab?.getAttribute("aria-controls");
      const panel = panelId ? document.getElementById(panelId) : null;
      const list = panel ? panel.querySelector('section[aria-label="Sources"] > ul') : null;
      if (!panel || !list) return; // the surface is not ready; the poll retries
      const rows = [...list.children].filter(
        (el) => el.tagName === "LI" && el.getBoundingClientRect().height > 1,
      );
      if (rows.length < 2) return;
      // CSS only: the DOM order is never touched, so any inversion the assertion
      // sees is purely visual and the markup stays exactly as shipped.
      const st = document.createElement("style");
      st.id = "ct-reading-order";
      st.textContent =
        "#" + panelId + ' section[aria-label="Sources"] > ul{display:flex !important;flex-direction:column-reverse !important;}';
      if (!document.head) return;
      document.head.appendChild(st);
      // Latched only now, after the mutation is actually in the document.
      window.__ctLayoutFault = true;
      hit();
      window.__ctReadingOrderTarget = {
        panelId: panelId,
        tab: (tab?.textContent || "").trim(),
        selector: "#" + panelId + ' section[aria-label="Sources"] > ul',
        directRows: rows.length,
        applied: true,
      };
      if (mode === "reading-order-restored") {
        // Remove the mutation again so the SAME assertion can be seen returning to
        // green: a control that only ever goes red proves nothing about recovery.
        setTimeout(() => {
          st.remove();
          window.__ctReadingOrderTarget.restored = true;
        }, 1500);
      }
        } else if (mode === "focus-ring-hidden" || mode === "contrast-lowered" || mode === "tab-map-broken") {
      // Applied once the target surface exists, then left in place: these faults
      // must survive re-renders or the assertion would be measuring nothing.
      if (mode === "focus-ring-hidden") {
        if (!window.__ctRingFault) {
          window.__ctRingFault = true;
          const st = document.createElement("style");
          st.textContent = "*{outline:none !important;box-shadow:none !important;}";
          document.head.appendChild(st);
          hit();
        }
      } else if (mode === "contrast-lowered") {
        if (!window.__ctContrastFault) {
          window.__ctContrastFault = true;
          const st = document.createElement("style");
          st.textContent = "body,body *{color:rgba(120,120,120,0.55) !important;}";
          document.head.appendChild(st);
          hit();
        }
      } else {
        if (!window.__ctTabFault) {
          window.__ctTabFault = true;
          // Broken keyboard mapping: on a tab-list key press the reported
          // selection is moved to the PREVIOUS tab, so focus, aria-selected and
          // the panel no longer agree. Applied from a capture listener on the
          // document, because the tabs themselves are re-created by the view.
          document.addEventListener(
            "keydown",
            (ev) => {
              if (!/^(ArrowLeft|ArrowRight|Home|End)$/.test(ev.key)) return;
              const selected = [...document.querySelectorAll('[role="tab"]')].find(
                (t) => t.getAttribute("aria-selected") === "true",
              );
              if (!selected) return;
              const tabs = [...document.querySelectorAll('[role="tab"]')];
              const i = tabs.indexOf(selected);
              const other = tabs[i - 1] ?? tabs[tabs.length - 1];
              if (!other) return;
              setTimeout(() => {
                const nowSelected = [...document.querySelectorAll('[role="tab"]')].find(
                  (t) => t.getAttribute("aria-selected") === "true",
                );
                if (!nowSelected || nowSelected === other) return;
                nowSelected.setAttribute("aria-selected", "false");
                other.setAttribute("aria-selected", "true");
                hit();
              }, 0);
            },
            true,
          );
        }
      }
    } else if (mode === "pair-endpoint-wrong" || mode === "pair-note-wrong") {
      // Both faults only apply while a paired-divergence note is on screen, so
      // they are a no-op on an ordinary occurrence and cannot silently corrupt
      // an unrelated assertion.
      document.querySelectorAll('[role="dialog"] p').forEach((p) => {
        const t = (p.textContent || "").trim();
        if (!/^Observed divergence pair/.test(t)) return;
        if (mode === "pair-note-wrong") {
          if (!/same context as previous/.test(t)) {
            p.textContent = "Observed divergence pair \\u2014 same context as previous occurrence.";
            hit();
          }
          return;
        }
        document.querySelectorAll('[role="dialog"] p').forEach((q) => {
          const u = (q.textContent || "").trim();
          const m = /^Evidence ID:\\s*(\\S+)/.exec(u);
          if (m && m[1] !== "ev-wrong-endpoint") { q.textContent = "Evidence ID: ev-wrong-endpoint"; hit(); }
        });
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
      if (li) { li.remove(); hit(); }
    };
    const timer = setInterval(drop, 50);
    setTimeout(() => clearInterval(timer), 30000);
  }

  // The stale-A insertion only has a target once a COMPLETED result is rendered,
  // which is after the observer has settled, so it polls until then.
  if (mode === "stale-a-inserted") {
    const timer = setInterval(() => {
      if (document.getElementById("ct-stale-a")) return clearInterval(timer);
      if (!document.head) return;
      try {
        alter();
      } catch {
        /* the result surface is not ready; retry */
      }
    }, 150);
    setTimeout(() => clearInterval(timer), 40000);
  }

  // The reading-order target only exists once the requested panel is rendered,
  // which is after the observer has settled, so it polls until then.
  if (mode === "reading-order-reversed" || mode === "reading-order-restored") {
    const timer = setInterval(() => {
      if (window.__ctLayoutFault) return clearInterval(timer);
      if (!document.head) return;
      try {
        alter();
      } catch {
        /* the result surface is not ready; retry */
      }
    }, 120);
    setTimeout(() => clearInterval(timer), 40000);
  }

  // Focus return is not a DOM mutation, so it cannot ride the observer: poll
  // for the dialog's disappearance and then blur whatever holds focus, which is
  // exactly the lost-focus state a keyboard user lands in.
  if (mode === "focus-return-broken") {
    let seenDialog = false;
    const steal = () => {
      if (document.querySelector('[role="dialog"]')) {
        seenDialog = true;
        return;
      }
      // Never before the viewer has been open: stealing focus during the
      // upload phase would fail an unrelated assertion.
      if (!seenDialog) return;
      const el = document.activeElement;
      if (el && el !== document.body) { el.blur(); hit(); window.__ctFaultDone = true; }
    };
    const timer = setInterval(steal, 20);
    setTimeout(() => clearInterval(timer), 30000);
  }
};`;

/* ------------------------- fault script syntax gate --------------------- */

/**
 * The injected fault script is a TEMPLATE LITERAL, so a brace imbalance inside it
 * still parses as this module: `node --check` and the whole vitest suite pass
 * while `window.__ctFault` is never installed and every fault silently becomes a
 * no-op that reports zero mutations. That happened here, and it is invisible from
 * the outside — the only symptom was a stray console error and a fault that never
 * fired.
 *
 * So the fault script is compiled for real before it is used, every time. A broken
 * script is a hard failure with the real syntax error, not a quiet green.
 */
function assertFaultScriptParses() {
  // FAULT_SCRIPT is the ALREADY EVALUATED string, not the source literal. Slicing
  // between backticks on that value yields 0/-1 and drops the final character, so
  // a gate built that way accepted a script with an extra closing brace. Compile
  // the value itself.
  const compile = (src) => {
    try {
      // eslint-disable-next-line no-new-func
      new Function(src);
      return null;
    } catch (err) {
      return err.message;
    }
  };
  const actual = compile(FAULT_SCRIPT);
  if (actual) {
    fail(`the injected fault script does not parse: ${actual}. It is injected as a string, so this ` +
      `module still parses and every fault would silently become a no-op.`);
  }
  // Offline canaries, no browser: the gate must REJECT a script with a missing and
  // with an extra closing brace, or it is not actually discriminating and a green
  // here would mean nothing.
  const lastBrace = FAULT_SCRIPT.lastIndexOf("}");
  if (lastBrace < 0) fail("fault script gate: cannot locate a closing brace to build canaries");
  const withExtra = FAULT_SCRIPT.slice(0, lastBrace + 1) + "}";
  const withMissing = FAULT_SCRIPT.slice(0, lastBrace) + FAULT_SCRIPT.slice(lastBrace + 1);
  for (const [label, mutated] of [
    ["extra closing brace", withExtra],
    ["missing closing brace", withMissing],
  ]) {
    if (compile(mutated) === null) {
      fail(
        `fault script gate is not discriminating: a script with a ${label} still compiles, so a green from ` +
          `this gate would not prove the real script is valid.`,
      );
    }
  }
}

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
  "stream-ownership": { options: [] },
  accessibility: { options: [] },
};

const FEATURE_LIST = Object.keys(FEATURE_SPECS);

/**
 * Which drive — and which case/view of it — each fault can actually sabotage.
 * A fault outside that scope is rejected with exit 2 instead of being accepted
 * and silently inert: an accepted fault that cannot fire is a false green, and
 * feature-level scope alone is not enough. `drop-timeline-item` fires against
 * the Timeline panel, so on `--view overview` it would remove nothing and the
 * drive would pass; `group-mislabel` only has an assertion in the Analysis
 * branch; the pair faults only run inside `--case pair`.
 */
const FAULT_SCOPE = {
  "a11y-false-green": { features: ["accessibility"] },
  "focus-removed": { features: ["accessibility"] },
  "focus-ring-hidden": { features: ["accessibility"] },
  "contrast-lowered": { features: ["accessibility", "result"] },
  "tab-map-broken": { features: ["result"] },
  "long-value-truncated": { features: ["result"] },
  "reading-order-reversed": { features: ["result"] },
  "reading-order-restored": { features: ["result"] },
  "stale-a-inserted": { features: ["stream-ownership"] },
  "anchor-broken": { features: ["landing"] },
  "bad-selection": { features: ["result"] },
  "drop-timeline-item": { features: ["result"], views: ["timeline"] },
  "group-mislabel": { features: ["result"], views: ["analysis"] },
  "pair-endpoint-wrong": { features: ["viewer"], cases: ["pair"] },
  "pair-note-wrong": { features: ["viewer"], cases: ["pair"] },
  "focus-return-broken": { features: ["viewer"] },
  // Fires a provider-shaped request from any loaded page; the boundary
  // counters are what turn it into a red.
  "unexpected-request": { features: FEATURE_LIST },
};

/**
 * Some faults need a target that the chosen fixture actually contains. This is
 * knowable before any side effect, so an un-sabotageable run is refused rather
 * than accepted and reported green. Returns the reason, or null.
 */
function faultTargetIsEmpty(fault, feature, { caseName, view } = {}) {
  const fixture = fixtureDrives.has(feature) || feature === "result" ? driveFixture(feature, caseName) : null;
  if (!fixture) return null;
  const terminal = fixtureTerminal(fixture);
  if (!terminal) return null;
  if (fault === "drop-timeline-item") {
    const rows = asLen(terminal.timeline);
    return rows > 0 ? null : `fixture ${fixture} has ${rows} timeline occurrence(s) to drop`;
  }
  if (fault === "group-mislabel") {
    const groups = asLen(terminal.reportingGroups);
    return groups > 0 ? null : `fixture ${fixture} reports ${groups} reporting group(s) to relabel`;
  }
  if (fault === "bad-selection") {
    // The Sources tab is rendered for every result; nothing to know up front.
    return null;
  }
  if (fault === "pair-endpoint-wrong" || fault === "pair-note-wrong") {
    const div = fixtureDivergence(fixture);
    return div ? null : `fixture ${fixture} has no paired divergence to corrupt`;
  }
  return null;
}

/** Why a fault does not apply, or null when it does. */
function faultScopeViolation(fault, feature, { caseName, view } = {}) {
  const scope = FAULT_SCOPE[fault];
  if (!scope) return `unknown fault ${fault}`;
  if (!scope.features.includes(feature)) {
    return `it sabotages: ${scope.features.join(", ")}`;
  }
  if (scope.cases && !scope.cases.includes(caseName ?? "")) {
    return `for ${feature} it only applies to --case ${scope.cases.join("|")} (this run is --case ${caseName ?? "(default)"})`;
  }
  if (scope.views && !scope.views.includes(view ?? "")) {
    return `for ${feature} it only applies to --view ${scope.views.join("|")} (this run is --view ${view ?? "(default)"})`;
  }
  return null;
}

/**
 * Full schema validation. Runs before any side effect: no manifest read, no
 * port probe, no browser. Returns the normalized option object.
 */
function parseDriveOptions(opts = {}) {
  // A fixture DEFAULT is not a user choice: `drive result --live` legitimately
  // has no --case, and the default must not be mistaken for one. The rejection
  // below therefore looks at what the caller actually supplied.
  const userSuppliedCase = flags.case !== undefined;
  const handlerLive = opts.handlerLive === true;
  const feature = positional[1];
  if (!feature) fail("drive requires a feature (implemented: " + FEATURE_LIST.join(", ") + ")");
  if (positional.length > 2) fail(`unexpected argument ${JSON.stringify(positional[2])}`);
  const spec = FEATURE_SPECS[feature];
  if (!spec) fail(`unknown drive feature ${feature} (implemented: ${FEATURE_LIST.join(", ")})`);

  // `live-handler` is governed by its own command allow-list, which already
  // carries the live surface (`--manifest`, `--image`, `--claim-text`,
  // `--viewport`, `--declared-result`) and deliberately omits the
  // controlled-only options (`--case`, `--fault`, `--delay-ms`).
  const allowed = handlerLive
    ? [...COMMAND_FLAGS["live-handler"]]
    : [...COMMAND_FLAGS.drive, ...spec.options, ...new Set(COMMAND_FLAGS.drive.concat(spec.options))];
  const unknown = Object.keys(flags).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    fail(`unsupported option(s) for ${feature}: ${unknown.map((k) => `--${k}`).join(", ")}`);
  }

  // `live-handler` is a live-semantics invocation by construction, so it enters
  // the live branches without needing (or allowing) a --live boolean.
  const live = flags.live === true || handlerLive;
  if (live && !handlerLive && !spec.options.length) {
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
    if (feature === "viewer" && flags.case === "pair") {
      // The case is drivable only when a controlled fixture really emits a
      // paired divergence with two existing endpoints. Anything less is
      // reported as a missing fixture, never silently skipped.
      if (!fixtureNames().some((f) => fixtureDivergence(f) !== null)) {
        fail(
          "no controlled fixture emits a paired divergence: the pair viewer case needs a fixture " +
            "whose terminal result carries firstObservedContextDivergence with two displayed endpoints",
        );
      }
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
    // Case and view are resolved before this point (they default above), so an
    // inapplicable combination is refused before any side effect.
    const violation = faultScopeViolation(flags.fault, feature, {
      caseName: flags.case,
      view: flags.view,
    });
    if (violation) {
      fail(
        `--fault ${flags.fault} cannot be applied to this ${feature} drive — ${violation}. ` +
          "An inert fault is a false green, so it is refused instead of accepted.",
      );
    }
  }

  for (const k of LIVE_ONLY) {
    if (flags[k] !== undefined && !live) fail(`--${k} is only valid with --live`);
  }
  if (flags["live-manifest"] !== undefined && !live) {
    fail("--live-manifest is only valid with --live");
  }
  // An explicit fixture/case option is a controlled-run concept: a live
  // investigation is whatever the backend returns, so comparing against (or
  // selecting for) a controlled case would silently make the drive a lie. Only
  // a case the caller actually supplied counts.
  if (live && userSuppliedCase) {
    fail(
      `--case ${flags.case} is a controlled-fixture option and is not valid with --live; ` +
        "a live run asserts the real response it receives, with no expected case to select",
    );
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

  // Live drives need an explicit public input, an explicit claim for claim
  // mode, and a live-readiness manifest that names the source and hash of the
  // image about to be submitted. Fixture pacing is a controlled-stub concept
  // and is refused here.
  if (live && !handlerLive && process.env.RUN_LIVE_TESTS !== "1") {
    fail("--live requires RUN_LIVE_TESTS=1 (provider credit gate)");
  }
  if (live) {
    if (flags.image === undefined) {
      fail("--live requires --image <path> (the submitted media for the provider run)");
    }
    if (!fs.existsSync(path.resolve(flags.image))) fail(`--image not found: ${flags.image}`);
    // `live-handler` names the same readiness manifest with `--manifest`.
    const manifestFlag = handlerLive ? "manifest" : "live-manifest";
    if (flags[manifestFlag] === undefined) {
      fail(
        `--live requires --${manifestFlag} <path> (a readiness manifest naming the public ` +
          "imageSource, its sha256, the mode/claim under test and the credit acknowledgement)",
      );
    }
    const manifest = readLiveManifest(flags[manifestFlag]);
    const mode = liveMode(spec);
    const claimText = flags["claim-text"] ?? null;
    const readiness = liveReadinessChecks({
      manifest,
      imagePath: flags.image,
      mode,
      claimText,
    });
    const failed = readiness.filter((c) => c.status === "FAIL");
    if (failed.length) {
      fail(
        `--${manifestFlag} failed the live input contract: ` +
          failed.map((c) => `${c.id} (${c.detail})`).join("; "),
      );
    }
  }

  // A fault whose target does not exist in the fixture it will replay cannot
  // fire, and an inert fault that passes is worse than a refusal.
  if (flags.fault !== undefined) {
    const empty = faultTargetIsEmpty(flags.fault, feature, { caseName: flags.case, view: flags.view });
    if (empty) {
      fail(
        `--fault ${flags.fault} has nothing to sabotage in this run: ${empty}. ` +
          "Pick a fixture/case whose surface it can actually alter.",
      );
    }
  }

  return { feature, spec, live, delayMs, userSuppliedCase };
}

/* ------------------------------ browser io ------------------------------ */

async function openSession(m, runId, viewport, { fault, streamOrigin, mode, apiMode }) {
  assertFaultScriptParses();
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

/* --------------------------- measured a11y helpers ----------------------- */

/**
 * Actual composited contrast for every visible text node on the current screen.
 *
 * Nothing here is a hardcoded colour: the effective background is found by
 * climbing ancestors until a non-transparent one is reached, alpha is composited
 * over it, and the WCAG ratio is computed from the rendered values. Large text
 * (>=24px, or >=18.66px bold) is held to 3:1 and everything else to 4.5:1, so a
 * CSS regression that lowers a foreground turns the assertion red instead of
 * being masked by a recorded constant.
 */
async function contrastSurvey(page, { limit = 400 } = {}) {
  return page.evaluate((max) => {
    // Any CSS colour syntax has to resolve to sRGB + alpha, because the browser
    // now hands back `oklab()`/`color()` for relative and mixed colours — a
    // `::placeholder` styled with color-mix comes back as oklab. Regex-parsing
    // only rgb()/rgba() and then falling back to a *different* colour is how a
    // 2.58:1 placeholder was measured as 16.83:1 in an earlier version of this
    // survey, so anything unrecognised is resolved by the engine itself (canvas
    // paint) and reported as unresolved rather than substituted.
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const cx = canvas.getContext("2d", { willReadFrequently: true });
    const viaCanvas = (str) => {
      try {
        cx.clearRect(0, 0, 1, 1);
        cx.fillStyle = "#000000";
        cx.fillStyle = str;
        const normalized = cx.fillStyle;
        cx.clearRect(0, 0, 1, 1);
        cx.fillStyle = normalized;
        cx.fillRect(0, 0, 1, 1);
        const d = cx.getImageData(0, 0, 1, 1).data;
        if (!d || (d[0] === 0 && d[1] === 0 && d[2] === 0 && d[3] === 0)) return null;
        return { r: d[0], g: d[1], b: d[2], a: d[3] / 255, resolvedFrom: normalized };
      } catch {
        return null;
      }
    };
    const parse = (c) => {
      const m = /rgba?\(([^)]+)\)/.exec(c || "");
      if (m) {
        const parts = m[1].split(/[,\s/]+/).filter((x) => x !== "").map((x) => parseFloat(x));
        return { r: parts[0] ?? 0, g: parts[1] ?? 0, b: parts[2] ?? 0, a: parts.length > 3 ? parts[3] : 1 };
      }
      if (!c) return null;
      return viaCanvas(c);
    };
    const over = (fg, bg) => ({
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a),
      a: 1,
    });
    const lum = (c) => {
      const f = (v) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const ratio = (a, b) => {
      const la = lum(a);
      const lb = lum(b);
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    };
    // A group `opacity` fades its text AND its own background together, so the
    // accumulated product multiplies whatever alpha each layer carries. This is
    // the difference between "grey text" and "grey text inside a 40% group".
    const groupOpacity = (el) => {
      let o = 1;
      for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
        const v = Number(getComputedStyle(n).opacity);
        if (Number.isFinite(v)) o *= v;
      }
      return o;
    };
    const effectiveBg = (el) => {
      const stack = [];
      let node = el;
      while (node && node.nodeType === 1) {
        const bg = parse(getComputedStyle(node).backgroundColor);
        if (bg && bg.a > 0) {
          stack.push({ ...bg, a: bg.a * groupOpacity(node) });
          if (bg.a * groupOpacity(node) >= 0.999) break;
        }
        node = node.parentElement;
      }
      let base = { r: 255, g: 255, b: 255, a: 1 };
      for (let i = stack.length - 1; i >= 0; i--) base = over(stack[i], base);
      return base;
    };
    const floorsFor = (st) => {
      const size = parseFloat(st.fontSize) || 0;
      const weight = Number(st.fontWeight) || 400;
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      return { size, weight, large, floor: large ? 3 : 4.5 };
    };
    const visible = (el) => {
      const st = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        st.visibility !== "hidden" &&
        st.display !== "none" &&
        Number(st.opacity) > 0.01 &&
        rect.width > 1 &&
        rect.height > 1
      );
    };
    const row = (kind, label, el, color, extra) => {
      const st = getComputedStyle(el);
      const bg = effectiveBg(el);
      // The colour under test is the one supplied (a pseudo-element's own), and
      // only if it cannot be resolved at all do we say so.
      const fg = parse(color);
      if (!fg) {
        return {
          kind,
          label: String(label || "").slice(0, 60),
          unresolved: true,
          color: color || "(none)",
          floor: 4.5,
          ratio: 0,
        };
      }
      const composited = over({ ...fg, a: fg.a * groupOpacity(el) }, bg);
      const { size, large, floor } = floorsFor(st);
      return {
        kind,
        label: String(label || "").slice(0, 60),
        ratio: Number(ratio(composited, bg).toFixed(2)),
        fontSize: size,
        large,
        floor,
        color: color || st.color,
        groupOpacity: Number(groupOpacity(el).toFixed(3)),
        ...extra,
      };
    };
    const out = [];
    const skipped = [];
    // 1. every visible text node, as before
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node && out.length < max; ) {
      const text = (node.textContent || "").trim();
      const parent = node.parentElement;
      if (text && parent && visible(parent) && !parent.closest("[aria-hidden=\'true\']")) {
        // The same exemption the control pass applies, or one surface would be
        // reported twice: a label inside a disabled control is exempt under WCAG
        // 1.4.3 as a text node too, and calling it a finding would be wrong.
        const inactive = parent.closest(
          "button[disabled], [aria-disabled=\'true\'], fieldset[disabled], option[disabled]",
        );
        if (inactive) {
          skipped.push({
            kind: "text-node",
            label: text.slice(0, 40),
            reason: `inside an inactive control (${inactive.tagName.toLowerCase()}${inactive.id ? "#" + inactive.id : ""}): WCAG 1.4.3 exempts inactive components`,
          });
        } else {
          const r = row("text-node", text, parent, getComputedStyle(parent).color, {});
          if (r) out.push(r);
        }
      }
      node = walker.nextNode();
    }
    // 2. form controls: the value text a user can see, and the placeholder an
    //    EMPTY control shows. A placeholder on a filled control is not rendered,
    //    so measuring it there would be a green that proves nothing.
    for (const el of document.querySelectorAll("input,textarea,select,button")) {
      if (!visible(el)) continue;
      const st = getComputedStyle(el);
      const tag = el.tagName.toLowerCase();
      if (el.disabled || el.getAttribute("aria-disabled") === "true") {
        skipped.push({ kind: `${tag}-value`, label: el.id || tag, reason: "disabled: WCAG 1.4.3 exempts inactive components" });
        continue;
      }
      if (el.closest("[aria-hidden=\'true\']")) {
        skipped.push({ kind: `${tag}-value`, label: el.id || tag, reason: "aria-hidden" });
        continue;
      }
      if (tag === "select") {
        skipped.push({ kind: "select-value", label: el.id || "select", reason: "option text is rendered by the UA, not measurable in the light DOM" });
      } else if (tag !== "button") {
        const r = row(`${tag}-value`, el.id || tag, el, st.color, { focused: document.activeElement === el });
        if (r) out.push(r);
      }
      const placeholderText = el.getAttribute("placeholder") || "";
      if (placeholderText) {
        const empty = tag === "input" || tag === "textarea" ? String(el.value ?? "").length === 0 : false;
        if (empty) {
          const ph = getComputedStyle(el, "::placeholder");
          const r = row(
            `${tag}::placeholder`,
            placeholderText,
            el,
            ph.color,
            { pseudo: "::placeholder", placeholderVisible: true },
          );
          if (r) out.push(r);
        } else {
          skipped.push({
            kind: `${tag}::placeholder`,
            label: placeholderText.slice(0, 30),
            reason: "control has a value, so the placeholder is not rendered",
          });
        }
      }
    }
    return {
      rows: out.slice(0, max),
      skipped: skipped.slice(0, 40),
      // Stated so the survey can never be read as a whole-AA claim: these are the
      // things it does NOT measure.
      notCovered: [
        "background images and gradients behind text",
        "canvas, SVG fills and icon strokes",
        "text in shadow DOM or inside a web component",
        "content scrolled out of the measured region",
        "focus/hover/active state colours of controls",
        "anything outside this screen: other viewports and panels are driven separately",
      ],
    };
  }, limit);
}

/**
 * Measured wrapping and reading order for the long-value surfaces.
 *
 * There is no `titleOverflow`/`textOverflow` collector in the product to read:
 * wrapping is plain layout (`flex-wrap`, and `overflow-x-hidden` on the viewer
 * shell as a backstop), so a gate that called a collector of that name would be
 * asserting about something that does not exist. Everything here is measured from
 * the rendered box instead:
 *   - a value longer than its box must WRAP (rendered height grows with the
 *     content) rather than be clipped by an `overflow:hidden` ancestor;
 *   - nothing may overflow horizontally;
 *   - visual order must match DOM order, so a CSS reorder cannot make the reading
 *     order differ from what a screen reader and a keyboard meet.
 */
/**
 * The single comparison the reading-order verdict is derived from. Pure, so the
 * stored verdict and any later recomputation cannot disagree: same rows in, same
 * answer out. Missing, non-finite or vacuous data is REJECTED rather than
 * reported as an ordered layout.
 */
function compareReadingOrder(layout) {
  if (!layout || !Array.isArray(layout.rows) || layout.rows.length === 0) return false;
  for (const r of layout.rows) {
    if (!Number.isFinite(r.top) || !Number.isFinite(r.left) || !Number.isFinite(r.domIndex)) return false;
  }
  return layout.inversions === 0;
}

async function longValueLayout(page, { limit = 60, panelId = null } = {}) {
  return page.evaluate(({ max, panel }) => {
    const isLong = (el) => {
      const t = (el.textContent || "").trim();
      return t.length >= 24;
    };
    const clippingAncestor = (el) => {
      for (let n = el.parentElement; n && n.nodeType === 1; n = n.parentElement) {
        const st = getComputedStyle(n);
        if (/hidden|clip/.test(st.overflowY) && n.scrollHeight > n.clientHeight + 1) return n;
      }
      return null;
    };
    const scope = panel ? document.getElementById(panel) : document.body;
    if (!scope) return { rows: [], visualDomSequence: [], inversions: null, outOfOrder: null, scopeMissing: true };
    const rows = [];
    for (const el of scope.querySelectorAll("li, dd, p, span, a, td, div")) {
      if (rows.length >= max) break;
      if (!isLong(el)) continue;
      // only leaf-ish text elements, not every wrapper
      if (el.children.length > 2) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const clipped = clippingAncestor(el);
      rows.push({
        text: (el.textContent || "").trim().slice(0, 70),
        width: Math.round(r.width),
        height: Math.round(r.height),
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        // wraps if the content needs more than one line's worth of height
        wraps: el.scrollHeight > el.clientHeight + 1 || parseFloat(style.lineHeight) * 1.4 < r.height,
        whiteSpace: style.whiteSpace,
        overflowX: el.scrollWidth - el.clientWidth,
        clippedBy: clipped ? `${clipped.tagName.toLowerCase()}${clipped.className ? "." + String(clipped.className).split(" ")[0] : ""}` : null,
        top: Math.round(r.top + (window.scrollY || 0)),
        left: Math.round(r.left + (window.scrollX || 0)),
        domIndex: Array.prototype.indexOf.call(document.querySelectorAll("*"), el),
      });
    }
    // Reading order is the VISUAL order, so it must be compared against DOM order
    // as a real coordinate comparison. Comparing DOM order with the order the
    // rows were collected in is comparing a thing with itself: it passes under
    // `flex-direction: column-reverse`, where the markup is untouched and the
    // screen reads bottom-to-top.
    const visual = rows
      .map((r, i) => ({ i, top: r.top, left: r.left, domIndex: r.domIndex, text: r.text }))
      .sort((a, b) => a.top - b.top || a.left - b.left);
    let outOfOrder = null;
    for (let k = 1; k < visual.length; k++) {
      if (visual[k].domIndex < visual[k - 1].domIndex) {
        outOfOrder = {
          readsBefore: visual[k - 1].text.slice(0, 30),
          readsAfter: visual[k].text.slice(0, 30),
          visualOrder: visual.map((v) => v.domIndex).slice(0, 8),
        };
        break;
      }
    }
    const inversions = outOfOrder ? 1 + visual.filter((v, k) => k > 0 && v.domIndex < visual[k - 1].domIndex).length : 0;
    return {
      rows,
      visualDomSequence: visual.map((v) => v.domIndex),
      inversions,
      outOfOrder,
      scopeMissing: false,
      scopeTag: scope.id ? `#${scope.id}` : scope.tagName.toLowerCase(),
      checked: rows.length,
    };
  }, { max: limit, panel: panelId });
}

/** Whether the currently focused element paints a visible focus indicator.
 *  Compared against the same element with focus removed, so a plain border
 *  that is always present is not mistaken for a focus ring. */
async function focusIndicator(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return { focused: false };
    const st = getComputedStyle(el);
    const signature = () =>
      [
        st.outlineStyle,
        st.outlineWidth,
        st.outlineColor,
        st.outlineOffset,
        st.boxShadow,
        st.borderColor,
        st.borderWidth,
      ].join("|");
    const focused = signature();
    // An actually-unfocused observation, not a simulated one: blur the element,
    // flush a style recalc, read the signature, then restore keyboard-origin
    // focus. Suppressing inline styles while focus stays put can miss a rule
    // that never had a focus-dependent value in the first place.
    const prevOutline = el.style.outline;
    const prevShadow = el.style.boxShadow;
    el.blur();
    void document.body.offsetHeight;
    const blurred = signature();
    el.style.outline = "none";
    el.style.boxShadow = "none";
    void document.body.offsetHeight;
    const suppressed = signature();
    el.style.outline = prevOutline;
    el.style.boxShadow = prevShadow;
    el.focus();
    void document.body.offsetHeight;
    const unfocused = signature();
    const outline = st.outlineStyle !== "none" && parseFloat(st.outlineWidth) > 0;
    const shadow = st.boxShadow && st.boxShadow !== "none";
    // Which properties actually differed, not merely whether the signature did:
    // a permanent decorative shadow plus a removed focus ring changes nothing,
    // and treating "a shadow exists" as a focus ring is a false green.
    const props = (a) => a.split("|");
    const diff = (a, b) =>
      props(a)
        .map((v, i) => (v !== props(b)[i] ? i : -1))
        .filter((i) => i >= 0);
    const changed = diff(focused, blurred);
    const suppressedChanged = diff(focused, suppressed);
    const INDICATOR_PROPS = ["outlineStyle", "outlineWidth", "outlineColor", "outlineOffset", "boxShadow"];
    // "Paints" is stricter than "differs": an outline-offset or outline-colour
    // change while outline-style stays `none` is invisible, and a box-shadow that
    // is identical focused and blurred is decoration. A focus indicator is a
    // focus-dependent change that PAINTS.
    const paints = (sig) => {
      const [style, width, , , shadow] = sig.split("|");
      const outline = style !== "none" && parseFloat(width) > 0;
      const box = shadow && shadow !== "none";
      return { outline, box };
    };
    const focusedPaint = paints(focused);
    const blurredPaint = paints(blurred);
    const suppressedPaint = paints(suppressed);
    const indicatorPaints =
      (focusedPaint.outline && !blurredPaint.outline && !suppressedPaint.outline) ||
      (focusedPaint.box && !blurredPaint.box && !suppressedPaint.box);
    const changedProps = changed
      .map((i) => INDICATOR_PROPS[i] ?? `border${["borderColor", "borderWidth"][i - 5] ?? i}`)
      .filter((n) => n !== "borderundefined");
    return {
      focused: true,
      tag: el.tagName,
      label: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 40),
      outline,
      shadow,
      changes: focused !== unfocused,
      changedProps,
      // Real blur: a permanent shadow with no focus styling is identical focused
      // or blurred, so this is false for exactly that counterexample.
      realFocusDifference: focused !== blurred,
      // Suppressed inline styles: catches a ring drawn only by inline styles.
      suppressionDifference: focused !== suppressed,
      // A focus indicator is a CHANGE in an indicator property, seen either by a
      // real blur or by suppressing the inline ring. A pre-existing outline or
      // shadow is decoration, not proof that focus is visible.
      indicatorChange: indicatorPaints,
      focusedPaintsOutline: focusedPaint.outline,
      focusedPaintsShadow: focusedPaint.box,
      blurredPaintsOutline: blurredPaint.outline,
      blurredPaintsShadow: blurredPaint.box,
    };
  });
}

/* ------------------------------- upload io ------------------------------ */

/**
 * The mode a LIVE run will actually run in. A feature with an explicit `--mode`
 * uses it; otherwise the mode follows the claim that is really being submitted,
 * because a claim is what selects claim mode in the product.
 */
function liveMode(spec) {
  if (spec.modes) return flags.mode ?? "trace";
  const claimText = flags["claim-text"];
  return typeof claimText === "string" && claimText.trim() !== "" ? "claim" : "trace";
}

/** Media type from the file extension, for the multipart capture record. */
function mediaType(file) {
  const ext = path.extname(file).toLowerCase();
  return (
    {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif",
    }[ext] ?? "application/octet-stream"
  );
}

const CONTROLLED_CLAIM = "controlled claim text";

/**
 * The fixture a drive actually replays, resolved in ONE place so the recorded
 * provenance, the submitted claim and the assertions all agree. `viewer` and
 * `session` cases are names, not fixtures, and used to record no fixture at
 * all.
 */
function driveFixture(feature, caseName) {
  if (feature === "viewer") {
    if (caseName === "pair") return "controlled-pair";
    if (caseName === "image-load" || caseName === "no-excerpt") return "controlled-viewer";
    return "controlled-claim";
  }
  if (feature === "session") return "controlled-claim";
  if (feature === "investigation" || feature === "result") return caseName ?? null;
  return null;
}

/**
 * The exact media and claim a drive submits, resolved once and recorded as
 * evidence.
 *
 * A live run submits the operator's own `--image` and `--claim-text`; the
 * generated 1×1 PNG is never substituted for them, so a live drive cannot
 * quietly re-run the controlled input. A controlled run submits the generated
 * file and the fixed controlled claim, labelled as such.
 */
function resolveInput(runId, { live, mode, fixture, spec = null }) {
  if (live) {
    const image = path.resolve(required("image"));
    const claimText = flags["claim-text"] ?? null;
    mode = spec ? liveMode(spec) : mode === "claim" ? "claim" : "claim";
    if (mode === "claim" && (claimText === null || claimText.trim() === "")) {
      fail("--live with --mode claim requires --claim-text (the claim actually under test)");
    }
    if (mode !== "claim" && typeof claimText === "string" && claimText.trim() !== "") {
      fail(
        `--live --mode ${mode ?? "trace"} must not carry --claim-text: a claim selects claim mode, ` +
          "so submitting one would run a different investigation than requested",
      );
    }
    return {
      kind: "live",
      file: { path: image, mime: mediaType(image), name: path.basename(image) },
      claim: claimText,
      claimProvided: typeof claimText === "string" && claimText.trim().length > 0,
      imageName: path.basename(image),
      imageBytes: fs.statSync(image).size,
      imageSha256: sha256(fs.readFileSync(image)),
      imageSource: liveManifestValue("imageSource"),
      fixtureMode: null,
    };
  }
  const file = uploadFileSet(runId)["upload.png"];
  // The fixture's own terminal mode decides whether a claim is submitted: a
  // Trace fixture is driven with an empty claim, so a Trace result can never be
  // the product of a claim-carrying request.
  const fixtureClaimMode = fixture ? fixtureMode(fixture) === "claim" : mode === "claim";
  return {
    kind: "controlled",
    file,
    claim: fixtureClaimMode ? flags["claim-text"] ?? CONTROLLED_CLAIM : null,
    claimProvided: fixtureClaimMode,
    fixtureMode: fixture ? fixtureMode(fixture) : null,
    imageName: "upload.png",
    imageBytes: fs.statSync(file.path).size,
    imageSha256: sha256(fs.readFileSync(file.path)),
    imageSource: "generated-controlled-1x1-png",
  };
}

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
 * result tablist and the overview section.
 *
 * Controlled: the fixture's own terminal status is compared with the rendered
 * headline, so a wrong-mode result cannot pass.
 *
 * Live: there is no fixture, so nothing is compared with a known value. What is
 * asserted is what the harness itself controls — that the submitted claim
 * decided the mode — plus the absence of credential material and provider query
 * URLs in the rendered page. The observed status is recorded as an observation.
 */
async function waitForTerminalResult(
  page,
  rec,
  { timeoutMs = 30_000, fixture = null, live = false, input = null } = {},
) {
  await page.waitForSelector('[aria-label="Result views"]', { timeout: timeoutMs });
  await page.waitForSelector('[aria-label="Investigation result"]', { timeout: timeoutMs });
  rec.check("result.terminal-surface", true, "tablist + overview section present");
  const body = await page.locator("body").innerText();

  // Applies to every run: the rendered report must never carry a provider key
  // name=value pair, a bearer token, or a provider query URL.
  rec.check(
    "result.no-credential-or-provider-url-leak",
    !/[?&](?:key|api_key|apikey|token|secret)=/i.test(body) &&
      !/\b(?:sk|pk|api)[-_][A-Za-z0-9]{8,}/.test(body) &&
      !/serpapi\.com\/search|typesafe\.ai/i.test(body),
    "no provider credential or query URL in the rendered report",
  );

  if (live) {
    const claimMode = Boolean(input?.claimProvided);
    const CLAIM_HEADLINES =
      /Context conflict found|Possible context conflict|No conflict found in retrieved evidence|Insufficient evidence/;
    const TRACE_HEADLINES = /Media history reconstructed|Limited media history found/;
    const observed = CLAIM_HEADLINES.test(body)
      ? "claim"
      : TRACE_HEADLINES.test(body)
        ? "trace"
        : "unknown";
    rec.note("result.live-observed-mode", `observed=${observed} submittedClaim=${claimMode}`);
    rec.note(
      "result.live-observed-status-headline",
      (body.split("\n").find((l) => CLAIM_HEADLINES.test(l)) ?? "(no claim headline)").slice(0, 160),
    );
    // The only mode claim the harness can make honestly: the claim it submitted
    // is what selected the mode.
    rec.check(
      "result.live-mode-agrees-with-submitted-claim",
      observed !== "unknown" && (claimMode ? observed === "claim" : observed === "trace"),
      `observed=${observed} claimSubmitted=${claimMode}`,
    );
    rec.check("result.live-terminal-recorded", true, "live run recorded, not compared to a fixture");
    return;
  }

  if (fixture) {
    const r = fixtureResult(fixture);
    const status = r?.status ?? null;
    const mode = fixtureMode(fixture);
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
      // The fixture's own terminal headline, not "one of the trace headlines":
      // accepting either would let a different reconstruction pass.
      // The backend sends a headline TOKEN; the view renders the copy that token
      // maps to. Compare the fixture's token against the exact rendered copy, so
      // "either trace headline" can no longer pass.
      const TRACE_TOKEN_COPY = {
        MEDIA_HISTORY_RECONSTRUCTED: "Media history reconstructed",
        LIMITED_MEDIA_HISTORY_FOUND: "Limited media history found",
      };
      const want =
        typeof r?.headline === "string" ? (TRACE_TOKEN_COPY[r.headline] ?? null) : null;
      if (want) {
        rec.check("result.trace-headline-exact", body.includes(want), `fixture headline="${want}"`);
      } else {
        rec.check(
          "result.mode-is-trace",
          /Media history reconstructed|Limited media history found/.test(body),
          "trace headline present (fixture carries no headline to compare)",
        );
      }
      rec.check("result.trace-fixture-carries-no-claim", !r?.claim, `claim=${JSON.stringify(r?.claim ?? null)}`);
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

/** The occurrence the open viewer is showing, read from its rendered
 *  "Evidence ID: <id>" line. Compared with the fixture's own ids, so a viewer
 *  showing the wrong occurrence cannot pass. */
async function viewerEvidenceId(dialog) {
  const text = await dialog.innerText();
  const m = /Evidence ID:\s*(\S+)/.exec(text);
  return m ? m[1] : null;
}

/** Press Tab until an element whose text/label matches `pattern` has focus.
 *  Real sequential navigation — not a programmatic focus() — so "reachable by
 *  keyboard" means reachable by the keyboard. */
async function tabWalkTo(page, pattern, max = 40) {
  const seen = [];
  for (let i = 0; i < max; i++) {
    const el = await activeElement(page);
    const label = el ? `${el.text ?? ""} ${el.label ?? ""}` : "";
    seen.push(el ? `${el.tag}:${label.trim().slice(0, 48)}` : "body");
    if (el && pattern.test(label)) return { matched: true, steps: i + 1, seen };
    await page.keyboard.press("Tab");
    await delay(60);
  }
  return { matched: false, steps: max, seen };
}

/**
 * Focus restoration is applied after the dialog has left the DOM, so reading
 * `document.activeElement` the instant the dialog disappears races the
 * product. Wait for focus to leave <body>, bounded: if it never does, the
 * honest answer is null and the focus-return assertion fails.
 */
async function settledActiveElement(page, timeoutMs = 1500) {
  const t0 = Date.now();
  let last = await activeElement(page);
  while (last === null && Date.now() - t0 < timeoutMs) {
    await delay(50);
    last = await activeElement(page);
  }
  return last;
}

/** The focus-stealing fault is asynchronous; give it a bounded moment to land
 *  so the focus assertion reads the sabotaged state, not a race. */
async function settleFocusFault(page) {
  if (flags.fault !== "focus-return-broken") return;
  await page
    .waitForFunction(() => window.__ctFaultDone === true, undefined, { timeout: 3000 })
    .catch(() => {});
}

/** Divergence endpoints a fixture actually ships, or null. */
function fixtureDivergence(name) {
  const r = fixtureResult(name);
  if (!r) return null;
  const d = r.firstObservedContextDivergence ?? r.divergence ?? null;
  if (!d || typeof d !== "object") return null;
  const fromId = d.fromOccurrenceId;
  const toId = d.toOccurrenceId;
  if (typeof fromId !== "string" || typeof toId !== "string") return null;
  return {
    fromId,
    toId,
    observedAt: d.observedAt ?? null,
    earlierTransitionsUnresolved: d.earlierTransitionsUnresolved === true,
  };
}

/** Flat viewer order the product must expose: dated, supporting, contextual,
 *  undated — the same order the result view groups them in. */
function fixtureViewerOrder(name) {
  const r = fixtureResult(name);
  if (!r) return [];
  return [...(r.timeline ?? []), ...(r.supportingEvidence ?? []), ...(r.contextualEvidence ?? []), ...(
    r.undatedEvidence ?? []
  )].map((o) => o.evidenceId ?? o.occurrenceId ?? null);
}

/**
 * The Analysis view's two comparison surfaces, read in one pass: the
 * "Comparison coverage" summary paragraph and the "Comparisons performed" list
 * (or its explicit "none" sentence). Structure-tolerant: it reads whatever
 * element follows each heading rather than assuming a tag.
 *
 * Each performed comparison renders its own nested probability list, so a plain
 * `li` count would report cards *and* their option rows. Only the DIRECT rows
 * are comparisons; the nested ones are read separately so probability values
 * keep their own assertion.
 */
async function analysisCoverageSurface(page) {
  return page.evaluate(() => {
    const panel = document.querySelector("#ct-panel-analysis");
    if (!panel) return { panel: false };
    const heads = [...panel.querySelectorAll("h3")];
    const after = (title) => {
      const h = heads.find((x) => (x.textContent || "").trim() === title);
      if (!h) return null;
      const sib = h.nextElementSibling;
      if (!sib) return { tag: null, text: "", items: [], nested: [], nestedTotal: 0 };
      const direct = sib.tagName.toLowerCase() === "ul" ? [...sib.children].filter((el) => el.tagName.toLowerCase() === "li") : [];
      const all = [...sib.querySelectorAll("li")];
      const nested = all
        .filter((li) => !direct.includes(li))
        .map((li) => (li.textContent || "").trim());
      return {
        tag: sib.tagName.toLowerCase(),
        text: (sib.textContent || "").trim(),
        items: direct.map((li) => (li.textContent || "").trim()),
        nested,
        nestedTotal: nested.length,
        allRows: all.length,
      };
    };
    return { panel: true, coverage: after("Comparison coverage"), performed: after("Comparisons performed") };
  });
}

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Title a terminal result gives an evidence id, for member-link assertions. */
function titleOf(terminal, id) {
  const all = [
    ...(terminal.timeline ?? []),
    ...(terminal.supportingEvidence ?? []),
    ...(terminal.contextualEvidence ?? []),
    ...(terminal.undatedEvidence ?? []),
  ];
  const row = all.find((o) => (o.evidenceId ?? o.occurrenceId) === id);
  return typeof row?.title === "string" ? row.title : String(id);
}

/** Retrieved image URL the viewer should render for each occurrence, in the
 *  same flat order as {@link fixtureViewerOrder}. */
function fixtureViewerImages(name) {
  const r = fixtureResult(name);
  if (!r) return [];
  return [...(r.timeline ?? []), ...(r.supportingEvidence ?? []), ...(r.contextualEvidence ?? []), ...(
    r.undatedEvidence ?? []
  )].map((o) => o.imageUrl ?? o.thumbnailUrl ?? null);
}

/**
 * Live/observed result assertions. Every check here is about the response the
 * app actually rendered, and every count is recorded as an observation with
 * its real value — nothing is compared with a fixture, and no expected status
 * is invented.
 */
/** An entry control is a requirement for a controlled run (the fixture ships the
 *  occurrence) and an observation for a live one (the response decides). */
async function recordEntry(rec, id, locator, live) {
  const count = await locator.count();
  if (live) rec.note(id, `${count} entry control(s) in the returned result`);
  else rec.check(id, count > 0, `count=${count}`);
  return count;
}

async function observeResultView(page, rec, view, panel, panelText) {
  rec.check(`result.observed-${view}-has-content`, panelText.trim().length > 0, `${panelText.trim().length} chars`);
  rec.check(
    `result.observed-${view}-no-placeholder`,
    !/\b(undefined|NaN|Invalid Date|null)\b/i.test(panelText),
    panelText.slice(0, 160).replace(/\s+/g, " "),
  );
  if (view === "overview") {
    const takeaways = await page.locator('[aria-label="Key takeaways"] li').count();
    const metrics = await page.locator('[aria-label="Investigation result"]').innerText({ timeout: 10_000 }).catch(() => "");
    rec.note("result.observed-takeaways", `${takeaways} takeaway row(s)`);
    rec.note("result.observed-metrics", metrics.slice(0, 200).replace(/\s+/g, " "));
    rec.check("result.observed-no-percentage", !/\b\d{1,3}%\b/.test(metrics), "no fabricated percentage");
  } else if (view === "timeline") {
    const rows = await panel.locator("ol > li").allInnerTexts();
    rec.note("result.observed-timeline-rows", `${rows.length} row(s)`);
    rec.note(
      "result.observed-timeline-dates",
      JSON.stringify(rows.map((r) => (/(20\d{2}-\d{2}-\d{2})/.exec(r) ?? [])[1] ?? null)),
    );
    for (const [pattern, kind] of [
      [/same context as previous · compared/i, "same_context"],
      [/different context from previous · compared/i, "different_context"],
      [/comparison inconclusive — performed but not established/i, "uncertain"],
      [/not compared in this investigation/i, "unexamined"],
    ]) {
      rec.note(`result.observed-timeline-connector-${kind}`, pattern.test(panelText) ? "present" : "absent");
    }
    // The connector copy must be the one the product defines, whatever the
    // real investigation contained.
    rec.check(
      "result.observed-connector-copy-is-product-copy",
      !/connector|kind|incomingConnector/i.test(panelText),
      "no wire tokens in the rendered chronology",
    );
  } else if (view === "sources") {
    const rows = await panel.locator('section[aria-label="Sources"] li').count();
    rec.note("result.observed-source-rows", `${rows} source row(s)`);
    rec.check(
      "result.observed-sources-surface-complete",
      rows > 0 || (await panel.getByText(/no sources were retrieved/i).count()) > 0,
      `${rows} row(s) or an explicit empty state`,
    );
  } else {
    const groups = panelText.match(/Reporting group of \d+ occurrences?/g) ?? [];
    const pairs = /(\d+) pairs? compared/.exec(panelText);
    const selected = /(\d+) selected(?: of (\d+))?/.exec(panelText);
    rec.note("result.observed-reporting-groups", `${groups.length} group headline(s): ${groups.join(" | ") || "none"}`);
    rec.note("result.observed-coverage", `pairs=${pairs?.[1] ?? "n/a"} selected=${selected?.[1] ?? "n/a"} of ${selected?.[2] ?? "n/a"}`);
    const mislabel = panelText.match(/Shared group of \d+ occurrence/i);
    rec.check("result.observed-reporting-group-not-mislabeled", mislabel === null, mislabel ? mislabel[0] : "neutral headline");
    if (/Reporting group of \d+ occurrence/.test(panelText)) {
      // Every rendered group headline must carry a real member count.
      rec.check(
        "result.observed-reporting-group-counts-are-numeric",
        groups.every((g) => /Reporting group of [1-9]\d* occurrences?/.test(g)),
        groups.join(" | ") || "no group headline",
      );
    } else {
      rec.check(
        "result.observed-reporting-group-empty-state",
        /No resolved reporting groups were reported/i.test(panelText) || /no groups/i.test(panelText),
        panelText.slice(0, 120).replace(/\s+/g, " "),
      );
    }
  }
}

/* --------------------------------- drive -------------------------------- */

/**
 * `live-handler` runs the PRODUCTION result/viewer handler with `live: true`
 * while the API boundary is intercepted and serves a locally declared result.
 * It exists because the live code path can only be proven with zero provider
 * credit: the handler asserts against the real response it receives, and the
 * submission is intercepted before it can reach a provider.
 */
async function drive(opts = {}) {
  const handlerLive = opts.handlerLive === true;
  if (flags.case) {
    const retained = retainedControlDigest(flags.case);
    if (retained) {
      const actual = crypto
        .createHash("sha256")
        .update(fs.readFileSync(fixturePath(flags.case)))
        .digest("hex");
      if (actual !== retained.sha256) {
        fail(
          `retained control ${flags.case} does not match the bytes Astra captured on ea1b539 ` +
            `(manifest ${retained.sha256.slice(0, 12)}, file ${actual.slice(0, 12)}); ` +
            `refusing to report a replay of a different stream as her control`,
        );
      }
      retainedSha256 = { name: flags.case, ...retained, actual };
    }
  }
  if (handlerLive) {
    enforceCommandSchema("live-handler", {
      requiredOptions: ["run-id", "feature", "manifest", "image"],
    });
  }
  let feature;
  let spec;
  let live;
  let delayMs = 0;
  let userSuppliedCase = false;
  if (handlerLive) {
    feature = flags.feature;
    if (!LIVE_HANDLER_FEATURES.includes(feature)) {
      fail(`--feature ${feature} is not exercisable through live-handler (supported: ${LIVE_HANDLER_FEATURES.join("|")})`);
    }
    // The REAL parser, not a bypass: the same option allow-list, entry/view
    // defaults, fault scope and live input contract a `drive --live` invocation
    // goes through, with only the credit gate lifted (this path cannot spend
    // credit) and `--manifest` accepted as the readiness manifest's flag. It is
    // a live-semantics invocation, so it carries live semantics into the parser
    // — the command simply cannot allow a provider request.
    positional[1] = feature;
    ({ feature, spec, live, delayMs, userSuppliedCase } = parseDriveOptions({ handlerLive: true }));
  } else {
    if (!positional[1]) fail("drive requires a feature (implemented: " + FEATURE_LIST.join(", ") + ")");
    ({ feature, spec, live, delayMs, userSuppliedCase } = parseDriveOptions());
  }

  // Credit gate BEFORE run state: a --live drive must never reach the
  // manifest, port or browser checks without the explicit credit opt-in.
  // `live-handler` is exempt by construction: its boundary blocks every
  // provider-shaped request and the drive asserts zero attempts, so requiring
  // credit opt-in for a command that cannot spend credit would be theatre.
  if (live && !handlerLive && process.env.RUN_LIVE_TESTS !== "1") {
    fail("--live requires RUN_LIVE_TESTS=1 (provider credit gate)");
  }

  const runId = required("run-id");
  const m = readManifest(runId);
  if (!m) fail(`no manifest for run-id ${runId}`);
  if (!pidIsOwned(m)) fail(`server pid ${m.pid} is not alive (or was reused) — relaunch`);
  if (live && !handlerLive && !m.live) {
    fail("--live drive requires a run launched with --live (credentials are absent otherwise)");
  }

  if (manifestSealed(runId)) {
    fail(
      `evidence for run ${runId} generation ${generation(runId)} is sealed; ` +
        `relaunch with --new-generation to record more drives`,
    );
  }

  const viewport = flags.viewport ?? "desktop";
  const fault = flags.fault ?? null;
  const fixtureDrivesThisRun = featureDrivesTier(feature);
  const tier = handlerLive
    ? "public-contract-boundary"
    : live
      ? "live"
      : fixtureDrivesThisRun
        ? "public-contract-boundary"
        : "real-ui";
  // Only a case the caller actually supplied is a case. An injected fixture
  // default is provenance for a controlled run and meaningless for a live one.
  const caseName = userSuppliedCase ? flags.case ?? null : null;

  // Resolved before any browser work: a live drive submits the operator's own
  // image/claim, a controlled drive the generated set.
  const fixtureName = live ? null : driveFixture(feature, caseName);
  // Truthful label for the intercepted live handler: production handler code,
  // locally declared result, zero provider calls, no real-data claim.
  let input = resolveInput(runId, {
    live,
    mode: flags.mode ?? null,
    fixture: fixtureName,
    spec,
  });
  // The two-stream recipe submits TWO different claims, so the single-input record
  // (claimProvided:false, no claims) understated it. The real per-request claim
  // identities are written by the drive into request-inputs.json; the top-level
  // record says so explicitly rather than claiming one claim.
  if (feature === "stream-ownership" && !live) {
    input = {
      kind: "controlled-multi-stream",
      claimProvided: true,
      claimCount: 2,
      claimNote: "two distinct claims, one per request; identities in request-inputs.json",
      image: input.kind === "controlled" ? input.image : null,
      imageBytes: input.kind === "controlled" ? input.imageBytes : null,
      imageSha256: input.kind === "controlled" ? input.imageSha256 : null,
      imageSource: "generated-controlled-1x1-png (harness input, 70B)",
      imageOnWire:
        "the app re-encodes the input; B's request carried investigation-image 560B. The exact wire " +
        "bytes are NOT retained, so no wire image hash is claimed — only the harness input hash above.",
      imageEntryMethod: "setInputFiles",
    };
  }


  const { dir: driveDir, seq } = nextDriveDir(runId, feature, [
    flags.entry,
    flags.mode,
    caseName,
    viewport,
  ]);
  const rec = new Recorder(driveDir);
  const runner = runnerIdentity();
  const t0 = Date.now();
  // Fault self-report: how many mutations the injected fault actually performed,
  // read before the browser closes, and whether that counts as having fired.
  let faultHits = null;
  let faultFired = null;

  // Per-drive fixture retention: the exact bytes this drive was shown, copied
  // into the drive's own evidence directory and hashed. Sealing later hashes
  // whatever is in the fixtures directory at that moment, so a mid-generation
  // regeneration would otherwise re-attribute a drive to different bytes.
  const fixtureUsed = fixtureName && fixtureNames().includes(fixtureName) ? fixtureName : null;
  let fixtureBytesSha = null;
  if (fixtureUsed) {
    const bytes = fs.readFileSync(fixturePath(fixtureUsed));
    fs.writeFileSync(path.join(driveDir, `fixture-${fixtureUsed}.ndjson`), bytes);
    fixtureBytesSha = sha256(bytes);
  }

  // An in-progress record exists from the moment the drive directory does, so
  // a killed, timed-out or crashed drive is still reported instead of leaving
  // an unaccounted directory that sealing silently skips.
  const initialRecord = {
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
    fixture: fixtureUsed,
    fixtureBytes: fixtureUsed ? fs.statSync(path.join(driveDir, `fixture-${fixtureUsed}.ndjson`)).size : null,
    fixtureSha256: fixtureBytesSha,
    generator: fixtureUsed ? "contexttrail-fixtures" : null,
    appRevision: m.revision,
    buildId: m.buildId,
    runnerRevision: runner.runnerRevision,
    runnerDirty: runner.runnerDirty,
    cliSha256: runner.cliSha256,
    // The harness files this drive actually READ, hashed now — not at seal
    // time, which would let a later map/generator edit be attributed backward.
    runnerFiles: runner.runnerFiles,
    // Provenance of a replayed opposing control: the case name, the mutation it
    // came from and the sha256 of the exact bytes, verified against the manifest
    // before the drive started.
    retainedControl: retainedSha256,
    startedAt: new Date(t0).toISOString(),
    outcome: "INCOMPLETE",
    complete: false,
    command: process.argv.slice(2),
  };
  writeJson(path.join(driveDir, "drive.json"), initialRecord);

  // Video evidence: Playwright finalizes the recording asynchronously after the
  // context closes, so it cannot be copied before then. The context is closed
  // first, then the finished file is collected into the drive directory and
  // hashed — never trimmed, never re-encoded, never regenerated.
  const videoStageDir = path.join(runDir(runId), "video");
  const videoStaged = flags["no-video"] ? [] : snapshotVideos(videoStageDir);

  let stream = null;
  let session = null;
  let outcome = "PASS";

  // An interrupted drive (Ctrl-C, a supervisor's SIGTERM) must still hand back
  // what it can prove. Closing the browser flushes the recording encoder, so the
  // partial video is collected into the drive's evidence and the record is
  // written as INCOMPLETE with no assertion verdict — a killed run is never
  // reported as a pass, and never leaves an unpreserved recording behind.
  let interrupting = false;
  const onInterrupt = (signal) => {
    if (interrupting) return;
    interrupting = true;
    (async () => {
      try {
        if (fault && session?.page) {
          faultHits = await session.page
            .evaluate(() => Number(window.__ctFaultHits ?? 0))
            .catch(() => 0);
        }
        await session?.context?.close().catch(() => {});
        await session?.browser?.close().catch(() => {});
        const collected = collectVideos(videoStaged, videoStageDir, driveDir);
        rec.push("drive.interrupted", "FAIL", `interrupted by ${signal}`);
        rec.close();
        writeJson(path.join(driveDir, "drive.json"), {
          ...initialRecord,
          outcome: "INCOMPLETE",
          complete: false,
          interruptedBy: signal,
          finishedAt: new Date().toISOString(),
          videos: collected,
          faultFired: fault ? faultHits > 0 : null,
          note:
            "interrupted before completion: assertions recorded up to the signal are kept, " +
            "the recording is preserved, and no pass verdict is claimed",
        });
      } finally {
        process.exit(EXIT_ASSERT);
      }
    })();
  };
  process.on("SIGINT", () => onInterrupt("SIGINT"));
  process.on("SIGTERM", () => onInterrupt("SIGTERM"));
  let failure = null;
  let failureStack = "";

  try {
    if (handlerLive) {
      // Intercepted submission of a locally declared result. The handler runs
      // unmodified with live semantics; the boundary blocks provider-shaped
      // requests and serves the declared stream instead of the backend.
      stream = await startStreamServer();
      const declared = flags["declared-result"] ?? DEFAULT_DECLARED_RESULT;
      stream.planFast(declared, 0);
      session = await openSession(m, runId, viewport, {
        fault: null,
        streamOrigin: stream.origin,
        mode: "controlled",
        apiMode: "redirect",
      });
    } else if (live) {
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
      // The exact media/claim this drive submits, resolved once and recorded.
      input,
    });

    if (session.syncBoundary) session.syncBoundary();
    boundaryCheck(rec, boundary, live, handlerLive);
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
      // The fault's self-report must be read while the page is still alive and
      // on BOTH paths: a fault that fires and trips an assertion, and a fault
      // that trips nothing at all, both need their count recorded.
      if (fault && session.page) {
        faultHits = await session.page
          .evaluate(() => Number(window.__ctFaultHits ?? 0))
          .catch(() => 0);
      }
      await session.context.close().catch(() => {});
      await session.browser.close().catch(() => {});
    }
    rec.close();
  }

  // Collect the finished recordings into the drive's evidence directory, after
  // the browser has released them and before anything can delete them. A
  // failure here must still finalize the drive record rather than leave an
  // unaccounted directory behind.
  let videoCollected = { collected: [], missing: [], staged: videoStaged.length, finalized: 0 };
  try {
    videoCollected = collectVideos(videoStaged, videoStageDir, driveDir);
  } catch (err) {
    outcome = "FAIL";
    failure = failure ?? `video collection failed: ${String(err?.message ?? err)}`;
    rec.push("drive.videos-collected", "FAIL", String(err?.message ?? err));
  }

  // An accepted --fault that reported no mutation did not sabotage anything, so
  // the drive is red even when every assertion happened to pass. This is the
  // general guard behind the per-fault scope checks.
  if (fault) {
    faultFired = faultHits === null ? null : faultHits > 0;
    rec.push(
      "fault.sabotage-reported",
      faultFired === true ? "PASS" : "FAIL",
      `${fault} performed ${faultHits ?? "unknown"} mutation(s)`,
    );
    if (faultFired !== true) {
      outcome = "FAIL";
      failure =
        failure ??
        `fault ${fault} never fired (${faultHits ?? 0} mutation(s) reported): an inert fault must not pass`;
    }
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
    // Whether the injected fault actually sabotaged anything, as the page itself
    // reported it. `null` on a run with no fault.
    faultFired,
    live,
    tier,
    fixture: fixtureUsed,
    fixtureBytes: fixtureUsed ? fs.statSync(path.join(driveDir, `fixture-${fixtureUsed}.ndjson`)).size : null,
    fixtureSha256: fixtureBytesSha,
    generator: fixtureUsed ? "contexttrail-fixtures" : null,
    // The exact submitted input, so a drive cannot be re-attributed to a
    // different image or claim.
    input: input
      ? {
          kind: input.kind,
          imageName: input.imageName,
          imageBytes: input.imageBytes,
          imageSha256: input.imageSha256,
          imageSource: input.imageSource,
          claimProvided: input.claimProvided,
          claimSha256:
            typeof input.claim === "string" ? sha256(Buffer.from(input.claim, "utf8")) : null,
        }
      : null,
    liveManifestSha256: handlerLive
      ? readLiveManifest(flags.manifest).sha256
      : live && flags["live-manifest"]
        ? readLiveManifest(flags["live-manifest"]).sha256
        : null,
    liveHandler: handlerLive || undefined,
    declaredResult: handlerLive ? (flags["declared-result"] ?? DEFAULT_DECLARED_RESULT) : undefined,
    appRevision: m.revision,
    buildId: m.buildId,
    runnerRevision: runner.runnerRevision,
    runnerDirty: runner.runnerDirty,
    cliSha256: runner.cliSha256,
    runnerFiles: runner.runnerFiles,
    startedAt: new Date(t0).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    outcome,
    complete: true,
    failure,
    failureStack: failureStack || null,
    assertions: counts,
    boundary: session?.boundary ?? null,
    command: process.argv.slice(2),
    videos: videoCollected,
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

/** Drives that reach the controlled fixture boundary. `session` is included:
 *  its cases submit a real request that the boundary redirects into the
 *  in-process fixture stream, so its evidence is contract-boundary evidence
 *  even though it also exercises real UI controls. */
// stream-ownership posts the app's real /api/investigate and consumes redirected
// local streams, so it proves the public contract, not a real UI surface.
const fixtureDrives = new Set(["investigation", "result", "viewer", "session", "stream-ownership"]);

function featureDrivesTier(feature) {
  return fixtureDrives.has(feature);
}

function apiModeFor(feature, caseName) {
  if (feature === "session" && caseName === "fatal-retry") return "fail";
  if (feature === "investigation" || feature === "result" || feature === "viewer") return "redirect";
  if (feature === "session") return "redirect";
  return "redirect";
}

function boundaryCheck(rec, b, live, handlerLive = false) {
  if (handlerLive) {
    // The live handler path, exercised with the API intercepted: the handler
    // code is the production one, but no provider request can leave the
    // browser, and the submission must be the local declared result.
    rec.check(
      "boundary.live-handler-zero-provider-attempts",
      b.providerAttempted === 0,
      `${b.providerAttempted} provider-shaped request(s) attempted (${JSON.stringify(b.providerCategories)})`,
    );
    rec.check("boundary.live-handler-mode-controlled", b.mode === "controlled", `mode=${b.mode}`);
    rec.check(
      "boundary.live-handler-api-redirected-to-declared-result",
      b.apiRedirected >= 1,
      `${b.apiRedirected} API request(s) redirected to the declared local result`,
    );
    rec.note(
      "boundary.live-handler-tier",
      "handler: production live path · result: locally declared, NOT provider truth",
    );
    return;
  }
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

  async investigation({ page, rec, m, runId, driveDir, live, delayMs, stream, caseName, input }) {
    const mode = flags.mode ?? "trace";
    if (!live && stream) {
      const plan =
        delayMs > 0
          ? stream.plan(caseName, { holds: 0, paceMs: delayMs })
          : stream.plan(caseName, { holds: 3 });
      rec.note("stream.plan", JSON.stringify(plan));
    }
    await submitUpload(page, m, runId, { claim: input.claim, rec, file: input.file });
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
      live,
      input,
    });
    if (!live && delayMs > 0) {
      const elapsed = Date.now() - tSubmit;
      rec.check("investigation.pacing-observed", elapsed >= delayMs * 0.8, `${elapsed}ms >= ${Math.round(delayMs * 0.8)}ms`);
    }
    await shot(page, driveDir, "02-investigation-result");
    await aria(page, driveDir, "investigation-result");
    if (stream) {
      rec.check("stream.request-captured", stream.state.captured !== null, JSON.stringify({ fields: stream.state.captured?.fields ?? null }));
      const captured = stream.state.captured;
      if (captured && captured.fields) {
        const fields = captured.fields;
        // The client normalizes the multipart part name to "investigation-image"
        // and submits its own preprocessed encoding, so the harness's file name
        // is deliberately NOT what travels. What must hold: a media part is
        // present, it is an image, it is non-empty, and the normalized name is
        // the product's own.
        const media = fields.image ?? fields.media ?? fields.file ?? null;
        rec.check(
          "stream.submitted-media-present",
          media !== null,
          `media part=${media === null ? "absent" : "present"}`,
        );
        rec.check(
          "stream.submitted-media-is-an-image",
          media !== null && /^image\//.test(media.contentType ?? ""),
          `contentType=${String(media?.contentType)}`,
        );
        rec.check(
          "stream.submitted-media-non-empty",
          media !== null && media.bytes > 0,
          `${media?.bytes ?? 0}B submitted, harness file ${input.imageName} was ${input.imageBytes}B before client preprocessing`,
        );
        rec.check(
          "stream.submitted-media-name-is-normalized",
          media !== null && media.filename === "investigation-image",
          `filename=${String(media?.filename)}`,
        );
        // Claim presence follows the fixture's own mode: a Trace request must
        // carry no claim at all.
        const claimField = fields.claim ?? fields.text ?? null;
        const wantClaim = Boolean(input.claimProvided);
        rec.check(
          "stream.submitted-claim-presence-matches-mode",
          wantClaim ? claimField !== null && (claimField.bytes ?? 0) > 0 : claimField === null || (claimField.bytes ?? 0) === 0,
          `claimField=${claimField ? `${claimField.bytes}B` : "absent"} expected=${wantClaim ? "present" : "absent"}`,
        );
        if (wantClaim && claimField && typeof input.claim === "string") {
          rec.check(
            "stream.submitted-claim-matches-intended-text",
            claimField.sha256 === sha256(Buffer.from(input.claim, "utf8")),
            `submitted sha256=${claimField.sha256 ?? "none"}`,
          );
        }
      }
    }
  },

  async result({ page, rec, m, runId, driveDir, live, delayMs, stream, caseName, input, viewport }) {
    const view = flags.view ?? "overview";
    if (!live && stream) stream.plan(caseName, { holds: delayMs > 0 ? 0 : 1, paceMs: delayMs });
    await submitUpload(page, m, runId, { claim: input.claim, rec, file: input.file });
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
    await waitForTerminalResult(page, rec, {
      timeoutMs: live ? 95_000 : 45_000,
      fixture: live ? null : caseName,
      live,
      input,
    });

    for (const name of RESULT_TABS) await selectTab(page, rec, name);

    // Keyboard operation of the tablist, with real key presses: focus, the
    // selected tab, the roving tabindex and the matching panel must all move
    // together. A broken mapping has to turn a specific assertion red.
    await page.getByRole("tab", { name: /^Overview$/ }).first().focus();
    const tabKeys = ["ArrowRight", "ArrowRight", "Home", "End", "ArrowLeft"];
    // Where each key MUST land, taken from the documented tab order and NOT from
    // whatever the view happened to do: ArrowRight, ArrowRight, Home, End,
    // ArrowLeft over Overview/Timeline/Sources/Analysis must visit
    // Timeline, Sources, Overview, Analysis, Sources. Deriving the expectation
    // from the observed state is what let a handler that ignores every key after
    // the first pass while remaining self-consistent.
    const expectedSequence = [1, 2, 0, RESULT_TABS.length - 1, RESULT_TABS.length - 2];
    for (let step = 0; step < tabKeys.length; step++) {
      const key = tabKeys[step];
      await page.keyboard.press(key);
      await delay(180);
      const state = await page.evaluate(() => {
        const active = document.activeElement;
        const selected = [...document.querySelectorAll('[role="tab"]')].find(
          (t) => t.getAttribute("aria-selected") === "true",
        );
        const panelId = selected?.getAttribute("aria-controls") ?? null;
        const panel = panelId ? document.getElementById(panelId) : null;
        return {
          key: null,
          focusName: (active?.getAttribute("aria-label") || active?.textContent || "").trim(),
          focusRole: active?.getAttribute("role") ?? null,
          focusTabIndex: active?.getAttribute("tabindex") ?? null,
          selectedName: (selected?.textContent || "").trim(),
          selectedIndex: [...document.querySelectorAll('[role="tab"]')].indexOf(selected),
          panelId,
          panelPresent: !!panel,
          panelVisible: !!panel && panel.getBoundingClientRect().height > 1,
          tabStops: [...document.querySelectorAll('[role="tab"]')].filter(
            (t) => t.getAttribute("tabindex") === "0",
          ).length,
        };
      });
      state.key = key;
      const want = expectedSequence[step];
      rec.check(
        `result.tablist-keyboard-${key.toLowerCase()}-moved`,
        state.selectedIndex === want,
        `expected tab ${want} ("${RESULT_TABS[want]}"), focus/selection at ${state.selectedIndex} ("${state.selectedName}") ` +
          `after ${key} — a key that changes nothing is a failure, not a pass`,
      );
      rec.check(
        `result.tablist-keyboard-${key.toLowerCase()}-consistent`,
        state.focusRole === "tab" &&
          state.focusName === state.selectedName &&
          state.panelPresent &&
          state.panelVisible,
        `focus="${state.focusName}" selected="${state.selectedName}" panel=${state.panelId} visible=${state.panelVisible}`,
      );
      rec.check(
        `result.tablist-keyboard-${key.toLowerCase()}-roving-tabindex`,
        state.focusTabIndex === "0" && state.tabStops === 1,
        `focused tab tabindex=${state.focusTabIndex}, ${state.tabStops} tab(s) in the tab order with tabindex=0 ` +
          `(a roving tabindex keeps exactly one stop, on the selected tab)`,
      );
      rec.note(`result.tablist-keyboard-${key.toLowerCase()}-state`, JSON.stringify(state));
    }

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

    const requestedView = view[0].toUpperCase() + view.slice(1);
    await selectTab(page, rec, requestedView);

    // Wrapping and reading order are properties of the panel that is ACTUALLY
    // selected. Collecting before the tab was selected measured Overview and
    // reported it under the requested view's name, so the row set could not
    // disagree with DOM order even when the Sources panel really was reversed.
    // Settle the panel first, then scope the measurement to it.
    const panelInfo = await page.evaluate(() => {
      const selected = [...document.querySelectorAll('[role="tab"]')].find(
        (t) => t.getAttribute("aria-selected") === "true",
      );
      const id = selected?.getAttribute("aria-controls") ?? null;
      const panel = id ? document.getElementById(id) : null;
      if (!panel) return { observedTab: null, panelId: null, settled: false, rowsInPanel: 0 };
      const r = panel.getBoundingClientRect();
      return {
        observedTab: (selected?.textContent || "").trim(),
        panelId: id,
        settled: r.height > 1,
        rowsInPanel: panel.querySelectorAll("li,dd,p,span,a,td,div").length,
      };
    });
    rec.check(
      "result.measurement-surface-is-the-requested-panel",
      panelInfo.observedTab === requestedView && panelInfo.settled === true,
      `requested "${requestedView}", observed tab "${panelInfo.observedTab}", panel ${panelInfo.panelId} ` +
        `settled=${panelInfo.settled} (${panelInfo.rowsInPanel} candidate nodes inside that panel)`,
    );
    const faultTarget = await page.evaluate(() => window.__ctReadingOrderTarget ?? null);
    rec.note("result.reading-order-mutation-target", JSON.stringify(faultTarget));
    rec.check(
      "result.reading-order-mutation-target-is-the-requested-list",
      faultTarget === null
        ? panelInfo.observedTab !== "Sources"
        : faultTarget.panelId === panelInfo.panelId && faultTarget.directRows >= 2 && faultTarget.applied === true,
      faultTarget === null
        ? "no reading-order mutation applied (baseline)"
        : `reversed ${faultTarget.selector} (tab "${faultTarget.tab}", ${faultTarget.directRows} direct visible ` +
          `li, applied=${faultTarget.applied}${faultTarget.restored ? ", then removed" : ""})`,
    );
    const layout = await longValueLayout(page, { panelId: panelInfo.panelId });
    writeJson(path.join(driveDir, "long-value-layout.json"), {
      requestedView,
      observedTab: panelInfo.observedTab,
      panelId: panelInfo.panelId,
      viewport,
      rows: layout.rows,
      visualDomSequence: layout.visualDomSequence,
      inversions: layout.inversions,
      outOfOrder: layout.outOfOrder,
      verdict: compareReadingOrder(layout),
    });
    const overflowing = layout.rows.filter((r) => r.overflowX > 1);
    const clipped = layout.rows.filter((r) => r.clippedBy);
    rec.check(
      "result.long-values-no-horizontal-overflow",
      layout.rows.length > 0 && overflowing.length === 0,
      overflowing.length === 0
        ? `${layout.rows.length} long value(s) in panel ${panelInfo.panelId}, widest overflow ${Math.max(0, ...layout.rows.map((r) => r.overflowX))}px`
        : `${overflowing.length} overflow horizontally: ${JSON.stringify(overflowing.slice(0, 3))}`,
    );
    rec.check(
      "result.long-values-wrap-not-truncate",
      clipped.length === 0,
      clipped.length === 0
        ? `${layout.rows.filter((r) => r.wraps).length}/${layout.rows.length} wrap onto multiple lines, none clipped by an overflow:hidden ancestor`
        : `${clipped.length} clipped by overflow:hidden: ${JSON.stringify(clipped.slice(0, 3))}`,
    );
    rec.check(
      "result.reading-order-matches-dom",
      compareReadingOrder(layout) === true,
      `${layout.rows.length} long value(s) in panel ${panelInfo.panelId}: ${layout.inversions} visual/DOM inversion(s), ` +
        `visual domIndex order ${JSON.stringify(layout.visualDomSequence.slice(0, 8))}` +
        (layout.outOfOrder ? ` — first divergence ${JSON.stringify(layout.outOfOrder)}` : ""),
    );

    await shot(page, driveDir, `01-result-${view}`);
    await aria(page, driveDir, `result-${view}`);

    // The selected panel is compared with the fixture it was rendered from:
    // counts must line up, and no placeholder token may reach the user.
    // A LIVE run has no fixture: the returned investigation is whatever the
    // backend produced, so nothing here may be compared with controlled rows.
    // `terminal` stays null and every fixture comparison is replaced by an
    // observation of what was actually rendered.
    const terminal = live ? null : fixtureTerminal(caseName);
    const panel = page.locator(`#ct-panel-${view}`);
    const panelText = await panel.innerText({ timeout: 10_000 }).catch(() => "");
    rec.check(
      `result.${view}-no-placeholder`,
      panelText.length > 0 && !/\b(undefined|NaN|Invalid Date)\b/.test(panelText) && !/\bnull\b/i.test(panelText),
      panelText.slice(0, 160).replace(/\s+/g, " "),
    );

    if (live) {
      // Observed-result contract: real assertions about a real response, and
      // honest observations of the numbers — never a comparison with a
      // controlled fixture's rows.
      await observeResultView(page, rec, view, panel, panelText);
    } else if (view === "overview") {
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
        // Actual dates, in actual order: each fixture occurrence's own date must
        // appear in the rendered rows, in the fixture's chronological order.
        const rows = await panel.locator("ol > li").allInnerTexts();
        const expectedDates = terminal.timeline
          .filter((t) => t && typeof t.observedAt === "string")
          .map((t) => String(t.observedAt).slice(0, 4));
        const missing = expectedDates.filter(
          (y) => !rows.some((r) => r.includes(y)),
        );
        rec.check(
          "result.timeline-shows-every-fixture-date",
          missing.length === 0,
          `missing year(s) ${missing.join(",") || "none"} of ${expectedDates.join(",") || "none"}`,
        );
        let ordered = true;
        let previous = null;
        for (const t of terminal.timeline) {
          const at = typeof t?.observedAt === "string" ? t.observedAt : null;
          if (at === null) continue;
          if (previous !== null && at < previous) ordered = false;
          previous = at;
        }
        const rendered = rows.map((r) => (/(20\d{2}-\d{2}-\d{2})/.exec(r) ?? [])[1] ?? null);
        const renderedOrdered = rendered.every(
          (d, i) => d === null || i === 0 || rendered[i - 1] === null || d >= rendered[i - 1],
        );
        rec.check(
          "result.timeline-rendered-in-chronological-order",
          ordered && renderedOrdered,
          `fixture ordered=${ordered}; rendered=${JSON.stringify(rendered)}`,
        );
        // Connectors are the substantive claim of the chronology: the rendered
        // copy must carry each connector the fixture recorded, and never
        // present an unexamined edge as compared.
        const CONNECTOR_COPY = [
          [/same context as previous · compared/i, "same_context"],
          [/different context from previous · compared/i, "different_context"],
          [/comparison inconclusive — performed but not established/i, "uncertain"],
          [/not compared in this investigation/i, "unexamined"],
        ];
        for (const [pattern, kind] of CONNECTOR_COPY) {
          const inFixture = terminal.timeline.some(
            (t) => String(t?.incomingConnector?.kind ?? "") === kind,
          );
          const renderedCopy = pattern.test(panelText);
          if (inFixture) {
            rec.check(
              `result.timeline-connector-${kind}`,
              renderedCopy,
              `fixture has a ${kind} edge and the view ${renderedCopy ? "shows" : "omits"} its copy`,
            );
          } else {
            rec.check(
              `result.timeline-no-invented-connector-${kind}`,
              !renderedCopy,
              `fixture has no ${kind} edge and the view ${renderedCopy ? "shows it anyway" : "does not show it"}`,
            );
          }
        }
        // "Not compared" and "compared but inconclusive" are different claims
        // and must not be collapsed into one another.
        const saysNotCompared = /not compared in this investigation/i.test(panelText);
        const saysInconclusive = /comparison inconclusive — performed but not established/i.test(panelText);
        rec.check(
          "result.timeline-distinguishes-not-compared-from-inconclusive",
          !(saysNotCompared && saysInconclusive && !(
            terminal.timeline.some((t) => String(t?.incomingConnector?.kind ?? "") === "unexamined") &&
            terminal.timeline.some((t) => String(t?.incomingConnector?.kind ?? "") === "uncertain")
          )),
          `notCompared=${saysNotCompared} inconclusive=${saysInconclusive}`,
        );
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
      // Comparison coverage, as the product actually projects it. The summary
      // is one of three real states — not reported, nothing selected, or an
      // explicit count — and the performed list is a separate, countable
      // surface. An absent count is never read as a zero, and a rendered count
      // is never allowed to contradict the run.
      if (terminal) {
        const coverage = terminal.comparisonCoverage ?? null;
        // The additive `comparisons` field is validated on its own, whether or
        // not a coverage summary exists: the absence of one optional field must
        // never disable validation of the other (C7-R2).
        const comparisons = Array.isArray(terminal.comparisons) ? terminal.comparisons : null;
        const analysisSurface = await analysisCoverageSurface(page);
        {
          const surface = analysisSurface;
          const performedItems = surface.performed?.items ?? [];
          const nested = surface.performed?.nested ?? [];
          rec.note(
            "result.analysis-performed-surface",
            JSON.stringify({
              comparisonsField: comparisons === null ? "absent" : comparisons.length,
              directRows: performedItems.length,
              nestedProbabilityRows: nested.length,
              allListRows: surface.performed?.allRows ?? 0,
            }),
          );
          const displayed = new Map(
            [
              ...(terminal.timeline ?? []),
              ...(terminal.supportingEvidence ?? []),
              ...(terminal.contextualEvidence ?? []),
              ...(terminal.undatedEvidence ?? []),
            ]
              .map((o) => [o.evidenceId ?? o.occurrenceId, typeof o.title === "string" ? o.title : null])
              .filter(([id, title]) => typeof id === "string" && title !== null),
          );
          if (comparisons === null) {
            rec.check(
              "result.analysis-performed-list-not-invented",
              performedItems.length === 0 &&
                /No context comparison was performed/.test(surface.performed?.text ?? ""),
              `no comparisons field in the result and ${performedItems.length} comparison row(s) rendered`,
            );
            rec.note(
              "result.analysis-performed-field-absent",
              "this result carries no `comparisons` field: the performed list is reported as not performed, not counted as zero",
            );
          } else {
            rec.check(
              "result.analysis-performed-list-count",
              performedItems.length === comparisons.length,
              `result records ${comparisons.length} performed comparison(s), the view renders ${performedItems.length} comparison row(s)`,
            );
            const recordedPairs = comparisons
              .map((c) => [c?.fromOccurrenceId, c?.toOccurrenceId])
              .filter(([a, b]) => typeof a === "string" && typeof b === "string");
            rec.check(
              "result.analysis-performed-pairs-are-displayed",
              recordedPairs.length === comparisons.length &&
                recordedPairs.every(([a, b]) => displayed.has(a) && displayed.has(b)),
              `every performed pair must name two displayed occurrences (${recordedPairs.length} pair(s), ${displayed.size} occurrence(s) displayed)`,
            );
            rec.check(
              "result.analysis-performed-list-identity",
              performedItems.length === recordedPairs.length &&
                recordedPairs.every(([a, b], i) => {
                  const item = performedItems[i] ?? "";
                  return (
                    item.includes(displayed.get(a) ?? "\u0000") && item.includes(displayed.get(b) ?? "\u0000")
                  );
                }),
              "each rendered comparison must name the two occurrences the result recorded, in order",
            );
            // Probability values are their own contract, kept separate from the
            // comparison count (C7-R1).
            const withDistributions = comparisons.filter(
              (c) => c && typeof c.distribution === "object" && c.distribution !== null,
            );
            if (withDistributions.length > 0) {
              const optionRows = nested.length;
              const expectedRows = withDistributions.reduce(
                (n, c) => n + Object.keys(c.distribution).length,
                0,
              );
              rec.check(
                "result.analysis-performed-probability-rows",
                optionRows === expectedRows,
                `${withDistributions.length} comparison(s) carry ${expectedRows} probability option(s); the view renders ${optionRows} nested row(s)`,
              );
              rec.check(
                "result.analysis-performed-probabilities-normalized",
                withDistributions.every((c) => {
                  const values = Object.values(c.distribution).filter((v) => typeof v === "number");
                  const sum = values.reduce((a, b) => a + b, 0);
                  return values.length > 0 && values.every((v) => v >= 0 && v <= 1) && Math.abs(sum - 1) < 1e-6;
                }),
                `every returned probability distribution sums to 1: ${withDistributions.length} comparison(s)`,
              );
              rec.check(
                "result.analysis-performed-probabilities-not-comparison-rows",
                nested.every((row) => !/between two retrieved occurrences/.test(row)),
                "a probability row is never counted as a comparison",
              );
            }
          }
        }

        if (coverage === null || typeof coverage !== "object") {
          rec.check(
            "result.analysis-coverage-not-reported",
            /Comparison coverage was not reported for this investigation/.test(panelText),
            "no coverage in the result: the view must say so instead of inventing numbers",
          );
        } else {
          const count = (k) => (typeof coverage[k] === "number" ? coverage[k] : null);
          const eligible = count("eligible");
          const selected = count("selected");
          const compared = count("comparedPairs");
          const comparedIds = Array.isArray(coverage.comparedPairIds) ? coverage.comparedPairIds : [];
          const surface = analysisSurface;
          const summary = surface.coverage?.text ?? "";
          const pairSentence = /(\d+) pairs? compared/.exec(summary);
          const selectionSentence = /(\d+) selected(?: of (\d+))?/.exec(summary);
          const emptySummary = /No occurrences were selected for context comparison/.test(summary);
          const nothingPerformed = /No context comparison was performed/.test(
            surface.performed?.text ?? "",
          );
          // The summary, against the three states the product can be in.
          if (eligible === 0 && selected === 0 && (compared === 0 || compared === null)) {
            rec.check(
              "result.analysis-coverage-empty-state",
              emptySummary,
              `eligible=0 selected=0 compared=${compared ?? "null"}: the view must state that nothing was selected`,
            );
            rec.check(
              "result.analysis-coverage-no-invented-pair-count",
              pairSentence === null,
              pairSentence
                ? `view claims "${pairSentence[0]}" on a run that compared nothing`
                : "no pair count claimed for an empty run",
            );
          } else if (compared !== null && selected !== null) {
            rec.check(
              "result.analysis-coverage-pair-count",
              pairSentence !== null && Number(pairSentence[1]) === compared,
              `fixture comparedPairs=${compared}, view says ${pairSentence ? pairSentence[0] : "no pair count"}`,
            );
            if (eligible !== null) {
              rec.check(
                "result.analysis-coverage-selection-counts",
                selectionSentence !== null &&
                  Number(selectionSentence[1]) === selected &&
                  Number(selectionSentence[2] ?? selected) === eligible,
                `fixture selected=${selected} eligible=${eligible}, view says ${
                  selectionSentence ? selectionSentence[0] : "no selection count"
                }`,
              );
            }
          } else {
            // A count the result did not report must not be invented. Recorded,
            // never assumed to be zero.
            rec.check(
              "result.analysis-coverage-no-invented-count",
              pairSentence === null,
              pairSentence
                ? `view claims "${pairSentence[0]}" but the result reported compared=${compared ?? "null"} selected=${selected ?? "null"}`
                : "no count invented from an unreported value",
            );
            rec.note(
              "result.analysis-coverage-partial",
              `eligible=${eligible} selected=${selected} compared=${compared}`,
            );
          }

          // A KNOWN count is checked against the separately supplied performed
          // list even when the summary used the empty-state sentence instead of
          // a numeric one (C7-R3). An absent/null count is never invented.
          if (compared !== null) {
            const performedCount = comparisons === null ? null : comparisons.length;
            if (performedCount !== null) {
              rec.check(
                "result.analysis-coverage-count-matches-performed-list",
                compared === performedCount,
                `coverage reports ${compared} compared pair(s) while the result supplies ${performedCount} performed comparison(s)`,
              );
            } else {
              rec.note(
                "result.analysis-coverage-performed-cross-check-skipped",
                `no \`comparisons\` field, so the reported ${compared} pair(s) cannot be cross-checked against a list`,
              );
            }
          }

          // Whatever was claimed must be internally possible: adjacent pairs in
          // one selected sequence are at most max(0, selected - 1) — fewer are
          // valid for imprecise/equal-date gaps — and an empty eligible set can
          // never have produced a comparison.
          if (pairSentence) {
            const claimed = Number(pairSentence[1]);
            // The summary and the performed list are two projections of one run.
            // They are only comparable when the result reported both; when
            // `comparisons` is absent there is nothing to compare against and
            // inventing a zero there would be the very error this guards.
            if (comparisons !== null) {
              rec.check(
                "result.analysis-coverage-matches-performed-list",
                claimed === comparisons.length,
                `summary claims ${claimed} pair(s) while the result records ${comparisons.length} performed comparison(s)`,
              );
            } else {
              rec.note(
                "result.analysis-coverage-cross-check-skipped",
                `no \`comparisons\` field in this result, so the summary's ${claimed} pair(s) cannot be cross-checked against a list`,
              );
            }
            const adjacencyMax = selected === null ? null : Math.max(0, selected - 1);
            rec.check(
              "result.analysis-coverage-not-contradictory",
              !(
                (eligible === 0 && claimed > 0) ||
                (adjacencyMax !== null && claimed > adjacencyMax) ||
                (compared !== null && claimed !== compared)
              ),
              `view claims ${claimed} adjacent pair(s) against eligible=${eligible} selected=${selected} (at most ${
                adjacencyMax ?? "unknown"
              } adjacent pair(s) exist) compared=${compared}`,
            );
          }
        }
        // Every reporting group the fixture declares must be rendered with its
        // real member count, and every declared policy gate must be rendered
        // with its real pass/fail — numeric equality, not vocabulary.
        const groups = Array.isArray(terminal.reportingGroups) ? terminal.reportingGroups : [];
        for (const [i, g] of groups.entries()) {
          const members = Array.isArray(g.memberIds) ? g.memberIds.length : null;
          if (members === null) continue;
          const headline = new RegExp(
            `Reporting group of ${members} occurrence${members === 1 ? "" : "s"}`,
          );
          rec.check(
            `result.analysis-reporting-group-${i}-member-count`,
            headline.test(panelText),
            `fixture group ${g.groupId} has ${members} member(s)`,
          );
          for (const id of Array.isArray(g.memberIds) ? g.memberIds : []) {
            rec.check(
              `result.analysis-reporting-group-${i}-member-link`,
              panelText.includes(id) || new RegExp(escapeRe(titleOf(terminal, id))).test(panelText),
              `member ${id} is listed in the group`,
            );
          }
        }
        const renderedGroups = panelText.match(/Reporting group of \d+ occurrences?/g) ?? [];
        rec.check(
          "result.analysis-reporting-group-count-matches",
          renderedGroups.length === groups.length &&
            groups.length ===
              (typeof terminal.reportingGroupCount === "number" ? terminal.reportingGroupCount : groups.length),
          `rendered ${renderedGroups.length} group headline(s), fixture groups=${groups.length}, reportingGroupCount=${String(terminal.reportingGroupCount)}`,
        );
        for (const gate of Array.isArray(terminal.policyReasons) ? terminal.policyReasons : []) {
          const label = String(gate.gate ?? "").replace(/_/g, " ");
          const pattern = new RegExp(`${escapeRe(label)}[^.]*${gate.passed === true ? "passed" : "not passed"}`, "i");
          rec.check(
            `result.analysis-policy-gate-${String(gate.gate).replace(/_/g, "-")}`,
            pattern.test(panelText),
            `fixture gate ${gate.gate} passed=${String(gate.passed)}`,
          );
        }
      }

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

  async viewer({ page, rec, m, runId, driveDir, viewport, stream, caseName, spec, delayMs, live, input }) {
    const entry = flags.entry ?? spec.defaultEntry;
    const vcase = flags.case ?? spec.defaultCase;
    // Each case is driven by the fixture that actually contains the evidence it
    // is about: the viewer fixture ships loadable, no-snippet and
    // per-occurrence images, and the pair fixture ships a real paired
    // divergence. Same resolver the drive record uses, so the retained bytes
    // and the asserted surface are the same fixture. A LIVE run has no fixture:
    // it asserts the dialog contract and records what the real response showed.
    const fixture = live ? null : driveFixture("viewer", vcase);
    if (stream && !live) stream.planFast(fixture, delayMs);
    await submitUpload(page, m, runId, { claim: input.claim, rec, file: input.file });
    await submitButton(page).click();
    if (stream) stream.releaseAll();
    await waitForTerminalResult(page, rec, { fixture, live, input });

    let entryBtn;
    if (entry === "timeline") {
      await selectTab(page, rec, "Timeline");
      entryBtn = page.getByRole("button", { name: /inspect evidence/i }).first();
      // Live: whether an entry exists depends on the response, so it is observed
      // here and the empty case is handled explicitly below.
      recordEntry(rec, "viewer.timeline-entry-present", entryBtn, live);
    } else if (entry === "sources") {
      await selectTab(page, rec, "Sources");
      entryBtn = page.getByRole("button", { name: /^inspect/i }).first();
      recordEntry(rec, "viewer.sources-entry-present", entryBtn, live);
    } else {
      entryBtn = page
        .locator('[aria-label="Key takeaways"]')
        .getByRole("button", { name: /view evidence/i })
        .first();
      recordEntry(rec, "viewer.takeaway-entry-present", entryBtn, live);
    }

    if (live && (await entryBtn.count()) === 0) {
      // An honest live outcome: the response carried no inspectable occurrence,
      // so there is no entry to open and no dialog contract to assert. The
      // absence must itself be explained — the surface exists, it simply has
      // nothing to inspect — and the drive says so instead of pretending to
      // have opened a viewer.
      const panelText = await page
        .locator(`#ct-panel-${entry === "takeaway" ? "overview" : entry === "sources" ? "sources" : "timeline"}`)
        .innerText({ timeout: 10_000 })
        .catch(() => "");
      rec.note(
        "viewer.live-observed-no-evidence",
        `the returned result exposes no ${entry} entry (${panelText.trim().length} chars in the panel)`,
      );
      rec.check(
        "viewer.live-no-evidence-explained",
        panelText.trim().length > 0 || (await page.locator('[aria-label="Result views"]').count()) > 0,
        "the result surface rendered; it simply has no occurrence to inspect",
      );
      rec.check("viewer.live-no-dialog-opened", (await page.locator('[role="dialog"]').count()) === 0, "no dialog was opened");
      await shot(page, driveDir, "01-viewer-no-evidence");
      await aria(page, driveDir, `viewer-no-evidence-${entry}`);
      return;
    }

    await entryBtn.click();

    const dialog = page.locator('[role="dialog"]');
    await dialog.waitFor({ timeout: 10_000 });
    rec.check("viewer.dialog-open", true, "role=dialog");
    rec.check("viewer.back-to-timeline", (await dialog.getByText(/back to timeline/i).count()) > 0, "close control present");
    // The open state is evidence in its own right: a screenshot taken only after
    // the close proves nothing about what the dialog rendered.
    await shot(page, driveDir, `00-viewer-open-${entry}-${vcase}`);

    // Bounded, NON-WAITING image inspection. A locator that auto-waits for a
    // missing <img> burns a full timeout per navigation step, which is how a
    // drive over several unavailable predecessors used to exceed any sane
    // bound. This reads the current state once and never waits.
    const imageState = () =>
      page.evaluate(() => {
        const dlg = document.querySelector('[role="dialog"]');
        if (!dlg) return { dialog: false };
        const img = dlg.querySelector('img[alt^="Retrieved image"]');
        const fallback = [...dlg.querySelectorAll("p")].some((p) =>
          /retrieved image unavailable/i.test(p.textContent || ""),
        );
        const submitted = dlg.querySelector('img[alt^="The image submitted"]');
        return {
          dialog: true,
          hasImg: !!img,
          fallback,
          complete: img ? img.complete : null,
          naturalWidth: img ? img.naturalWidth : null,
          src: img ? (img.getAttribute("src") || "").slice(0, 400) : null,
          submittedSrc: submitted ? (submitted.getAttribute("src") || "").slice(0, 400) : null,
        };
      });

    const fallback = dialog.getByText(/retrieved image unavailable/i);
    const retrievedImg = dialog.locator('img[alt^="Retrieved image"]');

    if (vcase === "image-load" && live) {
      // Observed media state for a real response: what is on screen now, with no
      // fixture row to attribute it to and no expectation to compare with.
      await delay(1500);
      const state = await imageState();
      rec.note("viewer.live-observed-image-state", JSON.stringify(state));
      rec.check(
        "viewer.live-media-surface-honest",
        state.hasImg
          ? state.complete === true
            ? state.naturalWidth > 0
            : true // a still-loading image is not a failure at observation time
          : state.fallback === true,
        `hasImg=${state.hasImg} complete=${String(state.complete)} naturalWidth=${String(state.naturalWidth)} fallback=${state.fallback}`,
      );
      if (state.hasImg && state.submittedSrc !== null) {
        rec.check(
          "viewer.live-retrieved-differs-from-submitted",
          state.src !== state.submittedSrc,
          "the retrieved image is not the submitted one",
        );
      }
    } else if (vcase === "image-load") {
      // Deterministic search for a decodable image: step through the fixture's
      // occurrences under a hard wall-clock budget, inspecting state without
      // waiting, and attribute whatever loaded back to the fixture row.
      const nextBtn = page.getByRole("button", { name: "Next evidence" });
      const order = fixtureViewerOrder(fixture);
      const images = fixtureViewerImages(fixture);
      const budgetMs = 25_000;
      const t0 = Date.now();
      let state = await imageState();
      let steps = 0;
      let loadedAt = -1;
      while (!(state.hasImg && state.complete && state.naturalWidth > 0)) {
        if (Date.now() - t0 > budgetMs) break;
        if (!(await nextBtn.isEnabled())) break;
        await nextBtn.click();
        steps++;
        await delay(250);
        state = await imageState();
        if (state.hasImg && state.complete && state.naturalWidth > 0) loadedAt = steps;
      }
      rec.check(
        "viewer.image-load",
        state.hasImg === true && state.complete === true && state.naturalWidth > 0,
        `loaded=${state.complete === true && state.naturalWidth > 0} after ${steps} step(s), ${Date.now() - t0}ms, naturalWidth=${state.naturalWidth}`,
      );
      // Attribution: the pixels on screen must be the ones the FIXTURE shipped
      // for this occurrence, and must not be the submitted image.
      const wantSrc = images[loadedAt === -1 ? 0 : loadedAt] ?? null;
      rec.check(
        "viewer.image-matches-fixture-source",
        wantSrc !== null && state.src === wantSrc,
        `rendered=${state.src === null ? "none" : `${state.src.slice(0, 48)}…`} fixture=${wantSrc === null ? "none" : `${wantSrc.slice(0, 48)}…`} at #${loadedAt === -1 ? 0 : loadedAt} of ${order.length}`,
      );
      rec.check(
        "viewer.image-is-not-the-submitted-image",
        state.src !== null && state.submittedSrc !== null && state.src !== state.submittedSrc,
        `retrieved=${state.src === null ? "none" : "present"} submitted=${state.submittedSrc === null ? "none" : "present"} same=${state.src === state.submittedSrc}`,
      );
      rec.note("viewer.image-state-observed", JSON.stringify(state));
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
    } else if (vcase === "pair" && live) {
      // A paired divergence is a property of one investigation's result, so it
      // can only be asserted against a result this harness controls. On a live
      // response the affordance is observed when present and never demanded.
      const pairCount = await dialog.getByRole("button", { name: /View paired divergence occurrence/i }).count();
      const note = /Observed divergence pair/.test(await dialog.innerText());
      rec.note("viewer.live-observed-pair-affordance", `present=${pairCount > 0} note=${note}`);
      rec.check(
        "viewer.live-pair-affordance-consistent",
        pairCount === 0 || note === true,
        "the pair control never appears without its explanatory note",
      );
    } else if (vcase === "pair") {
      // A real paired divergence: the fixture ships a genuine
      // `firstObservedContextDivergence` whose two endpoints are occurrences
      // this investigation displayed, and the viewer must offer the pair,
      // label each side honestly, jump between them by keyboard, and CLEAR
      // the pair as soon as ordinary navigation leaves it.
      const div = fixtureDivergence(fixture);
      rec.check("viewer.pair-fixture-has-endpoints", div !== null, JSON.stringify(div));
      const next = page.getByRole("button", { name: "Next evidence" });
      const prev = page.getByRole("button", { name: "Previous evidence" });
      if (div) {
        const order = fixtureViewerOrder(fixture);
        const fromIdx = order.indexOf(div.fromId);
        const toIdx = order.indexOf(div.toId);
        rec.check(
          "viewer.pair-endpoints-are-shown-occurrences",
          fromIdx >= 0 && toIdx >= 0,
          `from=${div.fromId}#${fromIdx} to=${div.toId}#${toIdx}`,
        );
        rec.check(
          "viewer.pair-endpoints-are-adjacent",
          toIdx === fromIdx + 1,
          `fromIdx=${fromIdx} toIdx=${toIdx}`,
        );

        // Home: walk back to the first occurrence so the navigation order can
        // be compared with the fixture's own order, whatever entry was used.
        for (let i = 0; i < 30 && (await prev.isEnabled()); i++) {
          await prev.click();
          await delay(120);
        }
        rec.check(
          "viewer.order-starts-at-first-fixture-occurrence",
          (await viewerEvidenceId(dialog)) === order[0],
          `rendered=${await viewerEvidenceId(dialog)} fixture[0]=${order[0]}`,
        );

        // Step forward one occurrence at a time and compare every rendered id
        // with the fixture's flat viewer order.
        const walked = [await viewerEvidenceId(dialog)];
        for (let step = 1; step <= toIdx; step++) {
          if (!(await next.isEnabled())) break;
          await next.click();
          await delay(220);
          walked.push(await viewerEvidenceId(dialog));
        }
        rec.check(
          "viewer.order-matches-fixture",
          JSON.stringify(walked) === JSON.stringify(order.slice(0, walked.length)),
          `${JSON.stringify(walked)} vs ${JSON.stringify(order.slice(0, walked.length))}`,
        );
        rec.check("viewer.pair-opens-earlier-endpoint", walked[fromIdx] === div.fromId,
          `at #${fromIdx} rendered=${walked[fromIdx]} fixture.from=${div.fromId}`);

        // Back to the earlier endpoint to inspect the pair affordance there.
        for (let i = walked.length - 1; i > fromIdx; i--) {
          await prev.click();
          await delay(180);
        }
        const earlierId = await viewerEvidenceId(dialog);
        rec.check("viewer.pair-earlier-id", earlierId === div.fromId, `rendered=${earlierId} expected=${div.fromId}`);
        const dialogTextEarlier = await dialog.innerText();
        rec.check(
          "viewer.pair-earlier-note",
          /Observed divergence pair — earlier occurrence/.test(dialogTextEarlier),
          "earlier-occurrence note present",
        );
        const pairBtn = dialog.getByRole("button", { name: /View paired divergence occurrence/i });
        rec.check("viewer.pair-entry-present", (await pairBtn.count()) > 0, `count=${await pairBtn.count()}`);
        rec.check("viewer.pair-entry-visible", (await pairBtn.count()) > 0 && (await pairBtn.isVisible()), "pair entry visible");
        const box = await pairBtn.boundingBox().catch(() => null);
        rec.check("viewer.pair-entry-touch-target", box !== null && box.height >= 44, `height=${box?.height ?? "n/a"}`);

        // Keyboard reachability, then keyboard activation.
        const reach = await tabWalkTo(page, /View paired divergence occurrence/i, 40);
        rec.check("viewer.pair-entry-keyboard-reachable", reach.matched, `${reach.steps} tab(s): ${reach.seen.slice(0, 8).join(" → ")}`);
        await shot(page, driveDir, "01-viewer-pair-earlier");
        await page.keyboard.press("Enter");
        await delay(350);
        const laterId = await viewerEvidenceId(dialog);
        rec.check("viewer.pair-keyboard-jumps-to-later-endpoint", laterId === div.toId,
          `rendered=${laterId} expected=${div.toId}`);
        const dialogTextLater = await dialog.innerText();
        rec.check(
          "viewer.pair-later-note",
          /Observed divergence pair — later occurrence \(first observed divergence\)/.test(dialogTextLater),
          "later-occurrence note present",
        );
        rec.check(
          "viewer.pair-back-entry-present",
          (await dialog.getByRole("button", { name: /View paired divergence occurrence/i }).count()) > 0,
          "the later endpoint can jump back",
        );
        await shot(page, driveDir, "02-viewer-pair-later");

        // Ordinary Next past the pair must clear the pair attribution: the
        // note and the pair entry follow the CURRENT occurrence, so stale pair
        // copy is a defect.
        let clearedAt = null;
        for (let i = 0; i < 6 && clearedAt === null; i++) {
          if (!(await next.isEnabled())) break;
          await next.click();
          await delay(220);
          const id = await viewerEvidenceId(dialog);
          if (id !== div.fromId && id !== div.toId) clearedAt = id;
        }
        rec.check("viewer.pair-cleared-outside-pair-reachable", clearedAt !== null,
          `navigated to ${clearedAt ?? "no occurrence outside the pair"}`);
        if (clearedAt !== null) {
          const outsideText = await dialog.innerText();
          rec.check("viewer.pair-note-cleared-outside-pair", !/Observed divergence pair/.test(outsideText),
            `at ${clearedAt}: ${/Observed divergence pair[^.]*\./.exec(outsideText)?.[0] ?? "no pair note"}`);
          rec.check(
            "viewer.pair-entry-cleared-outside-pair",
            (await dialog.getByRole("button", { name: /View paired divergence occurrence/i }).count()) === 0,
            `at ${clearedAt}`,
          );
          await shot(page, driveDir, "03-viewer-pair-cleared");
        }
        // Back to the first occurrence for the remaining shared assertions.
        for (let i = 0; i < 30 && (await prev.isEnabled()); i++) {
          await prev.click();
          await delay(120);
        }
      }
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
    //
    // Focus is first placed on a live in-dialog control: the harness's own last
    // click may have landed on a control that then became disabled (navigating
    // back to the first occurrence disables Previous), which would measure the
    // harness rather than the product's focus return.
    let trigger = await activeElement(page);
    for (let i = 0; i < 5 && (trigger === null || trigger.inDialog !== true); i++) {
      await page.keyboard.press("Tab");
      await delay(80);
      trigger = await activeElement(page);
    }
    rec.check(
      "viewer.focus-inside-dialog-before-close",
      trigger !== null && trigger.inDialog === true,
      JSON.stringify(trigger),
    );
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden", timeout: 10_000 });
    rec.check("viewer.escape-closes", true, "dialog hidden");
    await settleFocusFault(page);
    const focusAfter = await settledActiveElement(page);
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

    // Actual values, compared with the fixture's own row — not just "some dd
    // exists somewhere in the dialog". The open occurrence is the first item of
    // the fixture's flat viewer order at this point in the drive.
    const order = live ? [] : fixtureViewerOrder(fixture);
    const currentId = await viewerEvidenceId(dialog);
    const idx = order.indexOf(currentId);
    const rows = live ? null : fixtureResult(fixture);
    if (live) {
      const liveLabels = await dialog.locator("dt").allTextContents();
      const liveValues = await dialog.locator("dd").allTextContents();
      rec.note(
        "viewer.live-observed-technical-details",
        JSON.stringify(
          liveLabels.map((label, i) => [label.replace(/:\s*$/, ""), liveValues[i] ?? ""]),
        ),
      );
    }
    const occurrenceRow =
      idx >= 0 && rows
        ? [
            ...(rows.timeline ?? []),
            ...(rows.supportingEvidence ?? []),
            ...(rows.contextualEvidence ?? []),
            ...(rows.undatedEvidence ?? []),
          ][idx] ?? null
        : null;
    const detailLabels = await dialog.locator("dt").allTextContents();
    const detailValues = await dialog.locator("dd").allTextContents();
    const pairs = detailLabels.map((label, i) => [label.replace(/:\s*$/, ""), detailValues[i] ?? ""]);
    // Model version must be the configured pin, rendered verbatim.
    if (occurrenceRow && typeof occurrenceRow.jevModel === "string") {
      const modelRow = pairs.find(([label]) => /model version/i.test(label));
      rec.check(
        "viewer.technical-details-model-value",
        modelRow !== undefined && modelRow[1] === occurrenceRow.jevModel,
        `rendered=${modelRow ? modelRow[1] : "absent"} fixture=${occurrenceRow.jevModel}`,
      );
    }
    // Retrieval timestamp, when the fixture ships one, must match exactly.
    if (occurrenceRow && typeof occurrenceRow.retrievedAt === "string") {
      const tsRow = pairs.find(([label]) => /retrieval timestamp/i.test(label));
      rec.check(
        "viewer.technical-details-retrieved-at-value",
        tsRow !== undefined && tsRow[1] === occurrenceRow.retrievedAt,
        `rendered=${tsRow ? tsRow[1] : "absent"} fixture=${occurrenceRow.retrievedAt}`,
      );
    }
    // Every rendered value must be non-empty: a label with a blank value is a
    // field that says nothing.
    rec.check(
      "viewer.technical-details-values-non-empty",
      pairs.length > 0 && pairs.every(([, v]) => v.trim().length > 0),
      pairs.map(([l, v]) => `${l}=${v.slice(0, 28)}`).join(" | ").slice(0, 300),
    );
    // The remaining identity fields must equal the fixture's own values too.
    if (occurrenceRow && typeof occurrenceRow.canonicalUrl === "string") {
      const urlRow = pairs.find(([label]) => /canonical url/i.test(label));
      rec.check(
        "viewer.technical-details-canonical-url-value",
        urlRow !== undefined && urlRow[1] === occurrenceRow.canonicalUrl,
        `rendered=${urlRow ? urlRow[1] : "absent"} fixture=${occurrenceRow.canonicalUrl}`,
      );
    }
    if (occurrenceRow && occurrenceRow.serpPosition !== undefined) {
      const posRow = pairs.find(([label]) => /result position/i.test(label));
      rec.check(
        "viewer.technical-details-result-position-value",
        posRow !== undefined && posRow[1].trim() === String(occurrenceRow.serpPosition),
        `rendered=${posRow ? posRow[1] : "absent"} fixture=${String(occurrenceRow.serpPosition)}`,
      );
    }
    // The disclosure may name engines and result types — that is its purpose —
    // but it must never render an absent value as a token.
    rec.check(
      "viewer.technical-details-no-empty-or-undefined-values",
      !pairs.some(([l, v]) => /^(undefined|null|NaN|-)$/i.test(v.trim())),
      pairs.map(([l, v]) => `${l}=${v}`).join(" | ").slice(0, 240),
    );

    // Closing after an in-dialog interaction must ALSO hand focus back to the
    // entry control. Expanding a disclosure is an ordinary in-dialog
    // interaction, so the modal return property applies to it exactly as it
    // does to a plain close: a focus left on <body> is lost focus, and it is
    // asserted rather than observed.
    const triggerAfterDetails = await activeElement(page);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden", timeout: 10_000 });
    await delay(200);
    await settleFocusFault(page);
    const focusAfterDetails = await settledActiveElement(page);
    const backOnEntryAfterDetails = await entryBtn
      .evaluate((el) => document.activeElement === el)
      .catch(() => false);
    rec.check(
      "viewer.focus-return-after-disclosure-close",
      focusAfterDetails !== null && backOnEntryAfterDetails,
      JSON.stringify({ triggerAfterDetails, focusAfterDetails, backOnEntryAfterDetails }),
    );

    await shot(page, driveDir, `01-viewer-${entry}-${vcase}`);
    await aria(page, driveDir, `viewer-${entry}-${vcase}`);
  },

  async session({ page, rec, m, runId, driveDir, delayMs, stream, caseName, input }) {
    const scase = caseName ?? "refresh";
    switch (scase) {
      case "new": {
        if (stream) stream.planFast("controlled-claim", delayMs);
        await submitUpload(page, m, runId, { claim: input.claim, rec, file: input.file });
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
        await submitUpload(page, m, runId, { claim: input.claim, rec, file: input.file });
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
        await submitUpload(page, m, runId, { claim: input.claim, rec, file: input.file });
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
        await submitUpload(page, m, runId, { claim: input.claim, rec, file: input.file });
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
        await submitUpload(page, m, runId, { claim: input.claim, rec, file: input.file });
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

  /**
   * Native A -> cancel/reset -> B ownership.
   *
   * Two real requests over the real POST, each with its own fixture and its own
   * investigationId, so the ids are actually distinct rather than labelled
   * distinct. A is held mid-stream, cancelled, and B is started; then a late A
   * event is ATTEMPTED and the outcome recorded honestly — the client aborted, so
   * the transport is closed and the packet is undeliverable. That is recorded as
   * undeliverable and is explicitly not treated as proof that a late event was
   * processed. What is asserted is the ownership that IS observable: the UI, the
   * claim, the result and the sessionStorage cache belong to B, and B is still
   * streaming after A's response closed (A's stream ending must not mark B failed
   * or cancelled).
   */
  async "stream-ownership"({ page, rec, m, runId, driveDir, stream, viewport }) {
    const A = "controlled-pair";
    const B = "controlled-insufficient";
    const plan = stream.planSequence([{ fixture: A, holds: 1 }, { fixture: B, holds: 1 }]);
    // Both consumed streams, identified by their exact bytes, recorded before the
    // first request: name, byte length, sha256 and generator, plus the viewport and
    // the entry method the harness used to attach the image.
    // Durable copies of the exact buffers actually read, one file per request,
    // named and linked to the request that consumed them.
    const retained = plan.plans.map((pl, i) => {
      const st = stream.state.sequence[i];
      const file = `stream-request-${i}-${pl.fixture}.ndjson`;
      fs.writeFileSync(path.join(driveDir, file), st.buffer);
      return {
        request: i,
        fixture: pl.fixture,
        file,
        bytes: st.bytes,
        sha256: st.sha256,
        generator: st.generator,
        capturedAt: "planSequence (the buffer this request is served from)",
      };
    });
    const streamsConsumed = plan.plans.map((pl, i) => ({
      request: i,
      fixture: pl.fixture,
      bytes: stream.state.sequence?.[i]?.bytes ?? null,
      sha256: stream.state.sequence?.[i]?.sha256 ?? null,
      generator: stream.state.sequence?.[i]?.generator ?? null,
      segments: pl.segments,
    }));
    rec.note("ownership.streams-consumed", JSON.stringify(streamsConsumed));
    writeJson(path.join(driveDir, "ownership-plan.json"), {
      streamsConsumed,
      retainedStreams: retained,
      viewport,
      imageEntryMethod: "setInputFiles",
      imagePath: path.basename(uploadFileSet(runId)["upload.png"].path),
      imageSha256: sha256(fs.readFileSync(uploadFileSet(runId)["upload.png"].path)),
    });
    rec.check(
      "ownership.both-streams-retained-with-bytes",
      streamsConsumed.every((x) => typeof x.bytes === "number" && /^([0-9a-f]{64})$/.test(String(x.sha256)) && !!x.generator),
      `A ${streamsConsumed[0].bytes}B sha256 ${String(streamsConsumed[0].sha256).slice(0, 12)}, ` +
        `B ${streamsConsumed[1].bytes}B sha256 ${String(streamsConsumed[1].sha256).slice(0, 12)}, ` +
        `generator ${streamsConsumed[0].generator}`,
    );

    const ids = (p) => p.filter(Boolean).map((x) => String(x));
    rec.check(
      "ownership.streams-have-distinct-ids",
      plan.plans.length === 2 && plan.plans[0].id && plan.plans[1].id && plan.plans[0].id !== plan.plans[1].id,
      `A(${A})=${plan.plans[0]?.id} B(${B})=${plan.plans[1]?.id} — the two streams must be distinguishable by id, not only by position`,
    );
    const aId = plan.plans[0]?.id ?? null;
    const bId = plan.plans[1]?.id ?? null;
    // A's real article titles, from the fixtures' own evidence rows. A rendered
    // card's last line is the DOMAIN, which matches nothing, so the identity has to
    // come from the fixture data.
    const fixtureTitles = (name) => {
      const out = new Set();
      // From the CAPTURED buffer, not a re-read of the file, so the expectation
      // cannot silently diverge from the bytes the stream served.
      const st = stream.state.sequence.find((x) => x.fixture === name);
      for (const l of st.buffer.toString("utf8").split("\n")) {
        if (!l.trim()) continue;
        try {
          const ev = JSON.parse(l);
          const rows = ev.evidence ? (Array.isArray(ev.evidence) ? ev.evidence : [ev.evidence]) : [];
          for (const r of rows) {
            if (typeof r?.title === "string" && r.title.trim().length > 3) out.add(r.title.trim());
          }
        } catch { /* keep looking */ }
      }
      return [...out];
    };
    // One integrity check, used by the drive at seal time and by the offline
    // derivative: a retained stream that is missing or modified is a RED on this
    // same assertion, not a silently smaller evidence set.
    const retainedIntegrity = () => {
      const rows = retained.map((r) => {
        const p = path.join(driveDir, r.file);
        if (!fs.existsSync(p)) return { ...r, present: false, matches: false, why: "retained file is missing" };
        const actual = fs.readFileSync(p);
        const sha = crypto.createHash("sha256").update(actual).digest("hex");
        return {
          ...r,
          present: true,
          actualBytes: actual.length,
          actualSha256: sha,
          matches: sha === r.sha256 && actual.length === r.bytes,
          why: sha === r.sha256 && actual.length === r.bytes ? "byte-identical" : "retained bytes differ from the captured buffer",
        };
      });
      return rows;
    };
    const aTitlesAll = fixtureTitles(A);
    const bTitlesAll = fixtureTitles(B);
    // A-exclusive: titles A has that B does not. Shared titles are legitimate on
    // both results, so requiring every A title to be absent would be a false red.
    const aExclusive = aTitlesAll.filter((t) => !bTitlesAll.includes(t));
    rec.note("ownership.a-exclusive-titles", JSON.stringify({ aExclusive, shared: aTitlesAll.length - aExclusive.length }));

    // Evidence ids actually rendered in the DOM, and the claim text on screen.
    // Read the RENDERED state, not the markup. Two earlier observer bugs came
    // from doing this the other way: raw `ev-` ids are not in the upload-stage
    // HTML at all, and matching the word "cancel" also matches the cancel BUTTON.
    // The product's own accessible surfaces are the honest hooks: the live
    // evidence section's item titles/domains, its candidate count sentence, the
    // cancelled screen's exact heading, and the claim actually on screen.
    const observe = () =>
      page.evaluate(() => {
        const text = document.body.innerText || "";
        const live = document.querySelector('[aria-label="Evidence arriving live"]');
        const items = live ? [...live.querySelectorAll("li")] : [];
        const titles = items
          .map((li) => {
            const t = li.querySelector("h3, h4, [data-title]")?.textContent?.trim();
            if (t) return t;
            const lines = (li.innerText || "").split("\n").map((x) => x.trim()).filter(Boolean);
            return lines[lines.length - 1] || "";
          })
          .filter(Boolean);
        const domains = [...new Set(items.map((li) => (li.innerText || "").match(/([a-z0-9-]+\.[a-z]{2,})/i)?.[1]).filter(Boolean))];
        const countSentence = (live?.innerText || "").match(/(\d+)\s+candidates? found/i)?.[0] ?? null;
        const claimField = document.querySelector("#ct-claim");
        const heading = document.querySelector("h1")?.textContent?.trim() ?? null;
        return {
          evidenceCount: items.length,
          evidenceTitles: titles,
          evidenceDomains: domains,
          countSentence,
          // The product's cancelled screen says exactly this; the cancel BUTTON
          // does not, so this cannot be confused with the affordance.
          cancelled: heading === "Investigation cancelled.",
          heading,
          claim: claimField ? claimField.value : null,
          stageLabels: [...document.querySelectorAll('[aria-label^="Investigation stages"] [aria-label]')].map((n) =>
            String(n.getAttribute("aria-label") || "").split(":")[0].trim(),
          ),
          hasLateA: text.includes("LATE A RESULT THAT MUST NOT APPEAR"),
          bodySample: text.replace(/\s+/g, " ").slice(0, 150),
        };
      });

    // The real controlled image, attached for real: the form's submit stays
    // disabled without an image, so "start investigation" would be a disabled
    // control and the sequence could not start at all.
    const image = uploadFileSet(runId)["upload.png"];
    const imageBytes = fs.statSync(image.path).size;
    const submitEnabled = async () => {
      const b = page.getByRole("button", { name: /start investigation/i }).first();
      await b.waitFor({ state: "attached", timeout: 10_000 });
      return (await b.isEnabled()) === true;
    };
    const attachAndClaim = async (claim) => {
      await page.setInputFiles("#ct-image-input", image.path);
      await page.fill("#ct-claim", claim);
      await page
        .waitForFunction(
          () => {
            const b = [...document.querySelectorAll("button")].find((x) =>
              /start investigation/i.test(x.textContent || ""),
            );
            return !!b && !b.disabled;
          }, undefined, { timeout: 10_000 },
        )
        .catch(() => {});
      return submitEnabled();
    };

    await page.goto(`${m.url}/investigate`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#ct-claim");

    // --- stream A: submit, let it reach early evidence, then hold ---
    const aEnabled = await attachAndClaim("controlled claim describes a fictional event today.");
    rec.check(
      "ownership.a-usable-primary-action",
      aEnabled === true,
      `with the real controlled image attached (${path.basename(image.path)}, ${imageBytes}B, ` +
        `sha256 ${sha256(fs.readFileSync(image.path)).slice(0, 12)}), ` +
        `the primary control is enabled=${aEnabled} — a disabled button cannot start a stream`,
    );
    await page.getByRole("button", { name: /start investigation/i }).first().click();
    const aReached = await stream.reachedFor(0, 0);
    rec.check("ownership.a-delivered-early-evidence", aReached, `request 0 (${A}) reached its first held segment`);
    // Wait for the surface this assertion measures. Sampling once raced the
    // render: the cards arrive a frame or two after the held segment is written, so
    // a single read could see an empty live section and report a product failure.
    await page
      .waitForFunction(
        () => {
          const live = document.querySelector('[aria-label="Evidence arriving live"]');
          return !!live && live.querySelectorAll("li").length > 0;
        }, undefined, { timeout: 15_000 },
      )
      .catch(() => {});
    const seenA = await observe();
    rec.note("ownership.a-observed", JSON.stringify(seenA));
    const aTitles = seenA.evidenceTitles;
    rec.check(
      "ownership.a-delivered-rendered-early-evidence",
      seenA.evidenceCount > 0 && aTitles.length > 0 && !!seenA.countSentence,
      `A rendered ${seenA.evidenceCount} live evidence card(s) ("${seenA.countSentence}"), ` +
        `titles e.g. ${aTitles.slice(0, 2).join(" | ")}, domains ${seenA.evidenceDomains.slice(0, 3).join(", ")}`,
    );

    // --- cancel A, which aborts its fetch and closes the transport ---
    // The product's affordance is "Cancel investigation", not a bare "Cancel".
    const cancel = page.getByRole("button", { name: /^cancel investigation$/i }).first();
    const hadCancel = (await cancel.count()) > 0;
    rec.check("ownership.cancel-available-while-streaming", hadCancel, "a cancel control is offered while A streams");
    if (hadCancel) await cancel.click();
    await page
      .waitForFunction(
        () => document.querySelector("h1")?.textContent?.trim() === "Investigation cancelled.", undefined, { timeout: 10_000 },
      )
      .catch(() => {});
    const afterCancel = await observe();
    rec.note("ownership.after-cancel", JSON.stringify(afterCancel));
    rec.check(
      "ownership.a-really-cancelled",
      afterCancel.cancelled === true,
      `after cancelling, the screen heading is "${afterCancel.heading}" — the product's cancelled state, ` +
        `not merely a cancel button being present`,
    );
    // The close is a real event but not an instantaneous one: the client aborts,
    // the connection tears down, and the server observes it a tick later. Wait a
    // bounded time for it, and report how long it took rather than sampling once.
    const t0 = Date.now();
    let transportClosed = false;
    while (Date.now() - t0 < 5000) {
      if (stream.state.ledger.find((e) => e.index === 0)?.clientClosed === true) {
        transportClosed = true;
        break;
      }
      await delay(100);
    }
    const closeMs = Date.now() - t0;
    rec.check(
      "ownership.a-abort-closed-the-transport",
      transportClosed === true,
      `request 0 clientClosed=${transportClosed} after ${closeMs}ms — cancelling must abort the fetch, ` +
        `not merely hide the UI behind a still-open response`,
    );

    // --- the late A packet: attempted, and honestly recorded ---
    const lateLine = JSON.stringify({
      type: "investigation.completed",
      investigationId: aId,
      result: { mode: "claim_check", status: "POSSIBLE_CONTEXT_CONFLICT", claim: "LATE A RESULT THAT MUST NOT APPEAR" },
    });
    const attempt = stream.attemptLate(0, lateLine);
    rec.note("ownership.late-a-attempt", JSON.stringify(attempt));
    rec.check(
      "ownership.late-a-recorded-as-undeliverable",
      attempt.delivered === false && !!attempt.reason,
      `late A packet delivered=${attempt.delivered} (${attempt.reason}) — an undeliverable packet is NOT ` +
        `evidence that a late event was processed, and is recorded as exactly that`,
    );
    await delay(400);
    const afterLate = await observe();
    rec.check(
      "ownership.late-a-not-shown-to-the-user",
      afterLate.hasLateA === false && afterLate.cancelled === true,
      `after the undeliverable attempt the screen still shows "${afterLate.heading}" and no late-A result`,
    );

    // --- stream B: distinct identity, must own everything from here ---
    const restart = page.getByRole("button", { name: /start (a )?new|retry|new investigation/i }).first();
    if ((await restart.count()) > 0) await restart.click();
    else await page.goto(`${m.url}/investigate`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#ct-claim");
    const bEnabled = await attachAndClaim("a different controlled claim with no corroborating evidence at all");
    rec.check(
      "ownership.b-usable-primary-action",
      bEnabled === true,
      `B's primary control is enabled=${bEnabled} with the same real image attached`,
    );
    await page.getByRole("button", { name: /start investigation/i }).first().click();
    const bReached = await stream.reachedFor(1, 0);
    rec.check("ownership.b-started-and-streaming", bReached, `request 1 (${B}) reached its first held segment`);
    const seenB = await observe();
    rec.note("ownership.b-observed", JSON.stringify(seenB));
    // The ownership property is that A's cancelled screen and A's stream do not
    // decide B's state. B's own evidence count is a separate property and is
    // asserted after B is released, because at B's first hold its stream has not
    // produced evidence yet — conflating the two would have made this assertion
    // fail for a reason that has nothing to do with ownership.
    rec.check(
      "ownership.b-not-marked-cancelled-by-a",
      seenB.cancelled === false && seenB.heading !== "Investigation cancelled." && seenB.evidenceCount === 0
        ? true
        : seenB.cancelled === false,
      `B is on its own screen with heading "${seenB.heading}" and cancelled=${seenB.cancelled} — A's cancelled ` +
        `state and A's aborted stream must not decide B's state`,
    );
    // B's claim is asserted from what B's REQUEST carried, not from a form field
    // that does not exist on the streaming screen, and compared with A's.
    const CLAIM_A = "controlled claim describes a fictional event today.";
    const CLAIM_B = "a different controlled claim with no corroborating evidence at all";
    const wantA = sha256(Buffer.from(CLAIM_A, "utf8"));
    const wantB = sha256(Buffer.from(CLAIM_B, "utf8"));
    const sentA = stream.state.ledger.find((e) => e.index === 0)?.sentClaimSha256 ?? null;
    const sentB = stream.state.ledger.find((e) => e.index === 1)?.sentClaimSha256 ?? null;
    rec.check(
      "ownership.b-request-carried-its-own-claim",
      sentA === wantA && sentB === wantB && sentA !== sentB,
      `claim sha256 request 0 ${String(sentA).slice(0, 12)} (expected ${wantA.slice(0, 12)}), ` +
        `request 1 ${String(sentB).slice(0, 12)} (expected ${wantB.slice(0, 12)}) — the two streams must be ` +
        `distinguishable by the claim they carried, compared by hash so the body never enters the evidence`,
    );
    rec.check(
      "ownership.b-request-carried-a-real-image",
      (stream.state.ledger.find((e) => e.index === 1)?.sentMediaBytes ?? 0) > 0,
      `request 1 carried media ${stream.state.ledger.find((e) => e.index === 1)?.sentMediaName} ` +
        `(${stream.state.ledger.find((e) => e.index === 1)?.sentMediaBytes} bytes) — a claim-only request would ` +
        `not be the flow under test`,
    );

    // --- let B finish, then the cached result must be B's ---
    stream.releaseAllFor(1);
    await stream.waitForServed(8000);
    await delay(600);
    // B's completed Overview surface: exact terminal heading, and no A-exclusive
    // title anywhere in the RENDERED body. The live evidence section does not exist
    // on a completed result, so reading stale content from it proved nothing.
    await page
      .waitForFunction(
        () => /insufficient evidence|possible context conflict|no corroborating/i.test(document.body.innerText || ""), undefined, { timeout: 20_000 },
      )
      .catch(() => {});
    const overview = await page.evaluate(() => {
      const text = document.body.innerText || "";
      return {
        heading: document.querySelector("h1")?.textContent?.trim() ?? null,
        norm: text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(),
        chars: text.length,
        headingText: [...document.querySelectorAll("h1,h2")].map((h) => h.textContent?.trim()).filter(Boolean).slice(0, 6),
      };
    });
    writeJson(path.join(driveDir, "result-overview.json"), { heading: overview.heading, chars: overview.chars, headings: overview.headingText });
    rec.check(
      "ownership.b-terminal-heading-is-its-own",
      overview.heading === "Insufficient evidence",
      `B's completed Overview heading is "${overview.heading}" (headings on screen: ${JSON.stringify(overview.headingText)}) — ` +
        `the exact terminal state for ${B}, not merely "not cancelled"`,
    );
    const normTitle = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const staleVisible = aExclusive.filter((t) => overview.norm.includes(normTitle(t)));
    rec.check(
      "ownership.no-stale-a-content-on-completed-overview",
      staleVisible.length === 0,
      staleVisible.length === 0
        ? `none of A's ${aExclusive.length} exclusive title(s) appear in the ${overview.chars}-char rendered Overview ` +
          `(checked against the whole body, not the absent live section)`
        : `${staleVisible.length} of A's exclusive titles are VISIBLE on B's completed Overview: ${JSON.stringify(staleVisible.slice(0, 3))}`,
    );
    const afterB = await observe();
    rec.note("ownership.after-b-complete", JSON.stringify(afterB));
    // The earlier "A's live cards must not survive" check is REMOVED, not kept
    // alongside: it read the live evidence section, which does not exist on a
    // completed result, and compared against rendered-card last lines, which are
    // DOMAINS rather than article titles. It could not fail, and
    // ownership.no-stale-a-content-on-completed-overview is the real guard, over the
    // whole rendered Overview, against A-exclusive article titles. Two overlapping
    // claims would be worse than one correct one.
    rec.check(
      "ownership.b-not-cancelled-at-the-end",
      afterB.cancelled === false,
      `B's final screen heading is "${afterB.heading}" — B must not inherit A's cancelled state`,
    );
    const cache = await page.evaluate(() => {
      const out = {};
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        if (k && /result|investigat/i.test(k)) out[k] = sessionStorage.getItem(k);
      }
      return out;
    });
    writeJson(path.join(driveDir, "session-cache.json"), cache);
    // The cache stores the RESULT, which carries the claim rather than the
    // investigation id, so ownership is asserted by content: the cached result is
    // B's (B's claim, B's status) and nothing of A's. Asserting on the id here
    // would have failed for a reason that has nothing to do with ownership.
    const cacheText = JSON.stringify(cache);
    // The cache holds the RESULT the controlled stream returned, so its claim is
    // the FIXTURE's claim, not the text the drive typed. The exact question is
    // therefore WHICH STREAM's result was cached: compare the cached result with
    // each fixture's own terminal result, canonically hashed.
    const fixtureResultSha = (name) => {
      const lines = fs.readFileSync(fixturePath(name), "utf8").split("\n").filter((l) => l.trim());
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const ev = JSON.parse(lines[i]);
          if (ev.type === "investigation.completed" && ev.result) return sha256(Buffer.from(JSON.stringify(ev.result), "utf8"));
        } catch { /* keep looking */ }
      }
      return null;
    };
    const cachedSha = (() => {
      const key = Object.keys(cache)[0];
      if (!key) return null;
      try {
        return sha256(Buffer.from(JSON.stringify(JSON.parse(cache[key])), "utf8"));
      } catch {
        return null;
      }
    })();
    const wantFixtureA = fixtureResultSha(A);
    const wantFixtureB = fixtureResultSha(B);
    rec.check(
      "ownership.cache-is-bs-result",
      cachedSha !== null && cachedSha === wantFixtureB,
      `sessionStorage ${Object.keys(cache).join(", ") || "(none)"}; cached result sha256 ` +
        `${String(cachedSha).slice(0, 12)} — ${B}'s own terminal result hashes to ${String(wantFixtureB).slice(0, 12)}`,
    );
    rec.check(
      "ownership.cache-not-as-result",
      cachedSha !== wantFixtureA,
      `the cached result is not A's (${A}'s terminal result hashes to ${String(wantFixtureA).slice(0, 12)}), ` +
        `so the cache followed B rather than keeping the first stream's outcome`,
    );
    rec.note("ownership.cache-identity", JSON.stringify({ aId, bId, keys: Object.keys(cache) }));

    // --- the ledger, verbatim ---
    writeJson(path.join(driveDir, "delivery-ledger.json"), {
      ledger: stream.state.ledger,
      note:
        "One row per served request. A late write the client had already aborted is recorded as " +
        "delivered:false with a reason; an undeliverable packet is never reported as a late event processed.",
    });
    rec.note("ownership.delivery-ledger", JSON.stringify(stream.state.ledger));

    // Seal-time integrity: the retained per-request stream files must still be the
    // exact bytes those requests were served from.
    const integrity = retainedIntegrity();
    writeJson(path.join(driveDir, "retained-streams.json"), {
      streams: integrity,
      note:
        "Each file is the exact buffer request N was served from. A missing or modified file is " +
        "a RED on ownership.retained-streams-byte-identical, not a smaller evidence set.",
    });
    const badRetained = integrity.filter((r) => !r.matches);
    rec.check(
      "ownership.retained-streams-byte-identical",
      integrity.length === 2 && badRetained.length === 0,
      badRetained.length === 0
        ? integrity
            .map((r) => `request ${r.request} ${r.file} ${r.actualBytes}B sha256 ${String(r.actualSha256).slice(0, 12)}`)
            .join("; ")
        : `${badRetained.length} retained stream(s) not byte-identical: ${JSON.stringify(badRetained)}`,
    );
    // Both request claim identities, explicitly non-empty, in the drive record.
    const claimIdentities = [0, 1].map((i) => {
      const e = stream.state.ledger.find((x) => x.index === i);
      return {
        request: i,
        claimSha256: e?.sentClaimSha256 ?? null,
        claimBytes: e?.sentClaimBytes ?? null,
        imageInput: "upload.png 70B (harness input)",
        imageOnWire: e?.sentMediaName ? `${e.sentMediaName} ${e.sentMediaBytes}B` : null,
        imageEntryMethod: e?.imageEntryMethod ?? null,
      };
    });
    writeJson(path.join(driveDir, "request-inputs.json"), { requests: claimIdentities });
    rec.check(
      "ownership.both-request-claims-identified",
      claimIdentities.every((c) => /^([0-9a-f]{64})$/.test(String(c.claimSha256)) && c.claimBytes > 0),
      claimIdentities
        .map((c) => `request ${c.request}: claim ${c.claimBytes}B sha256 ${String(c.claimSha256).slice(0, 12)}`)
        .join("; "),
    );
  },

  async accessibility({ page, rec, m, driveDir, viewport }) {
    // The claim the reduced-motion leg submits: a real claim string, so the
    // primary control is enabled and "usable" can mean something.
    const claimText = "This shows a recent incident in my city.";
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

    // Real keyboard focus must PAINT an indicator, measured on the element that
    // actually holds focus and compared against the same element unfocused. The
    // walk above ends on <body>, so Tab forward until a real control holds
    // focus — the measurement must never be taken with no focused element.
    for (let i = 0; i < 8; i++) {
      const here = await page.evaluate(() => document.activeElement?.tagName ?? "BODY");
      if (here && here !== "BODY") break;
      await page.keyboard.press("Tab");
      await delay(60);
    }
    const indicator = await focusIndicator(page);
    rec.note("a11y.focus-indicator-observed", JSON.stringify(indicator));
    if (indicator.focused) {
      rec.check(
        "a11y.focus-indicator-visible",
        indicator.indicatorChange === true,
        `${indicator.tag} "${indicator.label}" outline=${indicator.outline} shadow=${indicator.shadow} ` +
          `paintsOutline=${indicator.focusedPaintsOutline}/${indicator.blurredPaintsOutline} ` +
          `paintsShadow=${indicator.focusedPaintsShadow}/${indicator.blurredPaintsShadow} ` +
          `changed=[${(indicator.changedProps || []).join(",")}]` +
          (indicator.indicatorChange === true
            ? ""
            : " — a permanent outline/shadow is decoration; focus itself must PAINT an indicator"),
      );
    } else {
      rec.note(
        "a11y.focus-indicator-not-measured",
        "focus was on <body> when the indicator was read; see focus-sequence.json for the walked order",
      );
    }

    // Reduced motion is a rendered outcome, not a preference read: emulate it,
    // then require the screen to be settled and its primary control usable. The
    // claim field is filled first, because an empty form leaves the submit
    // disabled — and "a disabled button is present" is not evidence that the
    // primary action is usable.
    await page.fill("#ct-claim", claimText);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#ct-claim", { timeout: 15_000 });
    await page.fill("#ct-claim", claimText);
    // Settled = the enabled state the form reaches, not merely a laid-out box:
    // wait for the submit control to actually become enabled, then for two
    // animation frames so a style transition has been flushed to the compositor.
    await page
      .waitForFunction(
        () => {
          const b = [...document.querySelectorAll("button")].find((x) =>
            /start investigation/i.test(x.textContent || ""),
          );
          return !!b && !b.disabled && b.getAttribute("aria-disabled") !== "true";
        }, undefined, { timeout: 15_000 },
      )
      .catch(() => {});
    await page
      .evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      )
      .catch(() => {});
    const reduced = await page.evaluate(() => {
      const claim = document.querySelector("#ct-claim");
      const submit = [...document.querySelectorAll("button")].find((b) =>
        /start investigation/i.test(b.textContent || ""),
      );
      const vis = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        // A box is not visibility: an element at opacity 0 (its own, or inherited
        // from a faded group) still has width and height and would pass a
        // geometry-only test while showing the user nothing.
        let opacity = 1;
        for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
          const v = Number(getComputedStyle(n).opacity);
          if (Number.isFinite(v)) opacity *= v;
        }
        return r.width > 1 && r.height > 1 && getComputedStyle(el).visibility !== "hidden" && opacity > 0.01;
      };
      const hasImage = !!document.querySelector('input[type="file"]')?.files?.length;
      return {
        matches: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        hasImage,
        claimValue: claim ? claim.value.length : 0,
        claimVisible: vis(claim),
        claimOpacity: claim ? getComputedStyle(claim).opacity : null,
        submitVisible: vis(submit),
        submitEnabled: submit ? !submit.disabled && submit.getAttribute("aria-disabled") !== "true" : null,
        submitHeight: submit ? Math.round(submit.getBoundingClientRect().height) : 0,
        submitOpacity: submit ? getComputedStyle(submit).opacity : null,
      };
    });
    rec.check(
      "a11y.reduced-motion-emulated",
      reduced.matches === true,
      `prefers-reduced-motion: ${reduced.matches}`,
    );
    rec.check(
      "a11y.reduced-motion-content-settled",
      reduced.claimVisible === true && reduced.submitVisible === true,
      `claim=${reduced.claimVisible} (opacity ${reduced.claimOpacity}) ` +
        `submit=${reduced.submitVisible} (opacity ${reduced.submitOpacity}) after the reduced-motion reload`,
    );
    // The EXPECTED state, not a wish: the form permits submission only with an
    // image attached, so on this screen (claim filled, no image) a disabled
    // submit is correct and must not be reported as a defect. Asserting "enabled"
    // here would be a false red; asserting the enabled state without ever
    // attaching an image would be a false green about usability.
    const expectEnabled = reduced.hasImage === true && reduced.claimValue > 0;
    rec.check(
      "a11y.reduced-motion-primary-control-usable",
      reduced.submitEnabled === expectEnabled && (expectEnabled ? reduced.submitVisible === true : true),
      `primary control enabled=${reduced.submitEnabled} (expected ${expectEnabled} for image=${reduced.hasImage}, ` +
        `claimChars=${reduced.claimValue}) visible=${reduced.submitVisible} opacity=${reduced.submitOpacity}`,
    );
    rec.check(
      "a11y.reduced-motion-primary-target-44px",
      reduced.submitHeight >= 44 && (expectEnabled ? reduced.submitEnabled === true : true),
      `primary control ${reduced.submitHeight}px tall, enabled=${reduced.submitEnabled}, under reduced motion`,
    );
    await shot(page, driveDir, "02-accessibility-reduced-motion");
    await page.emulateMedia({ reducedMotion: null });

    // Back to the screen as a user first meets it: the reduced-motion leg filled
    // the claim, and a filled control does not render its placeholder — measuring
    // contrast here would silently drop the very surface under review.
    await page.emulateMedia({ reducedMotion: null });
    await page.fill("#ct-claim", "");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#ct-claim", { timeout: 15_000 });

    // Composited contrast on this screen's own surface. No stored constant: the
    // ratio is computed from the rendered colours, so a lowered foreground is
    // caught here rather than excused by a previous measurement. The survey
    // covers visible text nodes AND form-control value text AND the placeholder
    // an empty control renders; a text-node-only survey silently skipped exactly
    // the case an independent design review found at 2.58:1.
    const survey = await contrastSurvey(page);
    const contrastRows = survey.rows;
    writeJson(path.join(driveDir, "contrast-composited.json"), {
      viewport,
      rows: contrastRows,
      skipped: survey.skipped,
      notCovered: survey.notCovered,
    });
    rec.note(
      "a11y.contrast-survey-scope",
      JSON.stringify({
        measured: contrastRows.length,
        byKind: contrastRows.reduce((acc, r) => ((acc[r.kind] = (acc[r.kind] || 0) + 1), acc), {}),
        exempted: survey.skipped.length,
        notCovered: survey.notCovered,
        claim: "text nodes + form-control value text + rendered ::placeholder, on this screen only; NOT a whole-AA claim",
      }),
    );
    const belowFloor = contrastRows.filter((r) => r.ratio < r.floor);
    rec.check(
      "a11y.contrast-meets-floor",
      contrastRows.length > 0 && belowFloor.length === 0,
      belowFloor.length === 0
        ? `${contrastRows.length} measured surface(s), lowest ${Math.min(...contrastRows.map((r) => r.ratio)).toFixed(2)}:1`
        : `${belowFloor.length}/${contrastRows.length} below floor: ${JSON.stringify(belowFloor.slice(0, 4))}`,
    );
    // The form-control subset on its own, so a placeholder failure is
    // attributable to the control and not buried in a text-node count.
    const controlRows = contrastRows.filter((r) => r.kind !== "text-node");
    if (controlRows.length > 0) {
      const controlLow = controlRows.filter((r) => r.ratio < r.floor);
      rec.check(
        "a11y.form-control-contrast-meets-floor",
        controlLow.length === 0,
        controlLow.length === 0
          ? `${controlRows.length} form surface(s), lowest ${Math.min(...controlRows.map((r) => r.ratio)).toFixed(2)}:1 (${controlRows.map((r) => r.kind).join(", ")})`
          : `${controlLow.length}/${controlRows.length} form surface(s) below floor: ${JSON.stringify(controlLow.slice(0, 4))}`,
      );
    } else {
      rec.note("a11y.form-control-contrast-meets-floor", "no enabled form control rendered on this screen");
    }

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

async function submitUpload(page, m, runId, { claim, rec, file }) {
  // The file is always the one the caller resolved: the generated set for a
  // controlled run, the operator's own --image for a live run. Never a
  // hardcoded generated upload.
  const chosen = file ?? uploadFileSet(runId)["upload.png"];
  const fileName = path.basename(chosen.path);
  await page.goto(`${m.url}/investigate`, { waitUntil: "domcontentloaded" });
  await applyUploadEntry(page, "setinputfiles", chosen);
  await expectSelectedPreview(page, rec, fileName);
  if (claim) await page.locator("#ct-claim").fill(claim);
  else await page.locator("#ct-claim").fill("");
}

/* ------------------------------- evidence ------------------------------- */

async function evidence() {
  // Validated before the manifest is read and before anything is written:
  // `evidence --nonsense 1` must not seal a run.
  enforceCommandSchema("evidence", { requiredOptions: ["run-id"] });

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
  const incomplete = [];
  if (fs.existsSync(drivesRoot)) {
    for (const name of fs.readdirSync(drivesRoot).sort()) {
      const p = path.join(drivesRoot, name, "drive.json");
      if (!fs.existsSync(p)) {
        // A drive directory with assertions but no finalized record is an
        // unfinished attempt. It is reported, never silently dropped.
        const assertionsPath = path.join(drivesRoot, name, "assertions.jsonl");
        incomplete.push({
          driveId: name,
          reason: fs.existsSync(assertionsPath)
            ? "no drive.json: the drive ended without finalizing its record"
            : "empty drive directory",
          assertionsRecorded: fs.existsSync(assertionsPath)
            ? fs
                .readFileSync(assertionsPath, "utf8")
                .split("\n")
                .filter(Boolean).length
            : 0,
          artifacts: fs.existsSync(path.join(drivesRoot, name))
            ? fs.readdirSync(path.join(drivesRoot, name)).sort()
            : [],
        });
        continue;
      }
      const d = JSON.parse(fs.readFileSync(p, "utf8"));
      if (d.complete !== true) {
        incomplete.push({
          driveId: d.driveId,
          reason: "record was never finalized (interrupted drive)",
          outcome: d.outcome,
          startedAt: d.startedAt,
          command: d.command,
        });
      }
      const assertions = fs
        .readFileSync(path.join(drivesRoot, name, "assertions.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      // The fixture bytes kept with the drive are hashed here too, so the seal
      // records what was actually shown even if the fixtures directory changed
      // afterwards.
      const keptFixture = d.fixture
        ? path.join(drivesRoot, name, `fixture-${d.fixture}.ndjson`)
        : null;
      const keptFixtureSha =
        keptFixture && fs.existsSync(keptFixture) ? sha256(fs.readFileSync(keptFixture)) : null;
      drives.push({
        driveId: d.driveId,
        feature: d.feature,
        viewport: d.viewport,
        case: d.case,
        entry: d.entry,
        tier: d.tier,
        generator: d.generator,
        fixture: d.fixture,
        fixtureBytes: d.fixtureBytes ?? null,
        fixtureSha256: d.fixtureSha256 ?? null,
        // Recomputed from the retained copy: equal to fixtureSha256 unless the
        // retained bytes were altered after the drive.
        fixtureSha256FromRetainedBytes: keptFixtureSha,
        fixtureBytesIntact:
          keptFixtureSha === null ? null : keptFixtureSha === (d.fixtureSha256 ?? null),
        input: d.input ?? null,
        liveManifestSha256: d.liveManifestSha256 ?? null,
        fault: d.fault,
        faultFired: d.faultFired ?? null,
        live: d.live,
        outcome: d.outcome,
        complete: d.complete === true,
        videos: d.videos ?? null,
        assertions: {
          pass: assertions.filter((a) => a.status === "PASS").length,
          fail: assertions.filter((a) => a.status === "FAIL").length,
          info: assertions.filter((a) => a.status === "INFO").length,
        },
        assertionIds: assertions.filter((a) => a.status !== "INFO").map((a) => `${a.status}:${a.id}`),
        boundary: d.boundary,
        appRevision: d.appRevision,
        runnerRevision: d.runnerRevision,
        runnerDirty: d.runnerDirty ?? null,
        cliSha256: d.cliSha256,
        // Per-drive, from the record — not the seal-time file list.
        runnerFiles: d.runnerFiles ?? null,
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

  // Recordings that exist in the generation staging directory but belong to no
  // drive record — an attempt that was hard-interrupted before it could collect
  // its own video. Listing a hash is not preserving a recording, so each one is
  // COPIED into durable evidence before the seal, labelled INCOMPLETE (never as
  // completed proof) and kept through cleanup.
  const claimedVideos = new Set(
    drives.flatMap((d) => (d.videos?.collected ?? []).map((v) => path.basename(v.file))),
  );
  const unclaimedRecordings = [];
  const stagingDir = path.join(runDir(runId), "video");
  const orphanDir = path.join(dir, "orphan-video");
  for (const v of snapshotVideos(stagingDir)) {
    if (claimedVideos.has(v.file)) continue;
    const buf = fs.readFileSync(path.join(stagingDir, v.file));
    const digest = sha256(buf);
    if (!fs.existsSync(orphanDir)) fs.mkdirSync(orphanDir, { recursive: true });
    const kept = path.join(orphanDir, v.file);
    fs.copyFileSync(path.join(stagingDir, v.file), kept);
    const entry = {
      file: `orphan-video/${v.file}`,
      bytes: buf.length,
      sha256: digest,
      label: "INCOMPLETE",
      reason:
        "belongs to no finalized drive record: the attempt was interrupted before it could " +
        "collect its own recording. These bytes are preserved as-is and are NOT completed proof.",
      owner: "unknown (interrupted attempt)",
      candidateIncompleteDrives: incomplete.map((i) => i.driveId),
      preserved: fs.existsSync(kept),
      preservedBytes: fs.statSync(kept).size,
      preservedSha256: sha256(fs.readFileSync(kept)),
    };
    writeJson(path.join(orphanDir, `${v.file}.json`), entry);
    unclaimedRecordings.push(entry);
  }

  // Zero-provider live-input controls are evidence too: they prove the live
  // INPUT contract without a provider call.
  const readinessRoot = path.join(dir, "readiness");
  const readinessControls = [];
  if (fs.existsSync(readinessRoot)) {
    for (const name of fs.readdirSync(readinessRoot).sort()) {
      const p = path.join(readinessRoot, name, "readiness.json");
      if (!fs.existsSync(p)) continue;
      const r = JSON.parse(fs.readFileSync(p, "utf8"));
      readinessControls.push({
        controlId: name,
        pass: r.pass,
        fail: r.fail,
        manifestSha256: r.manifestSha256,
        imageSha256: r.imageSha256,
        mode: r.mode,
        note: r.note,
        checks: r.checks,
      });
    }
  }

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
    incompleteDriveCount: incomplete.length,
    incompleteDrives: incomplete,
    videosCollected: drives.reduce((n, d) => n + (d.videos?.collected?.length ?? 0), 0),
    videosMissing: drives.reduce((n, d) => n + (d.videos?.missing?.length ?? 0), 0),
    unclaimedRecordings,
    readinessControlCount: readinessControls.length,
    readinessControls,
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
      incompleteDriveCount: summary.incompleteDriveCount,
      videosCollected: summary.videosCollected,
      videosMissing: summary.videosMissing,
      unclaimedRecordings: summary.unclaimedRecordings.length,
      readinessControlCount: summary.readinessControlCount,
      tierCounts: summary.tierCounts,
      assertionTotals: summary.assertionTotals,
      artifactCount: summary.artifactCount,
      manifest: manifestPathOut,
    }),
  );
}

/* -------------------------------- cleanup ------------------------------- */

async function cleanup() {
  // Validated before any process is signalled: `cleanup --nonsense 1` must not
  // stop a server.
  enforceCommandSchema("cleanup", { requiredOptions: ["run-id"] });

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
  // Recordings live inside each drive's evidence directory, so removing the
  // generation-level staging directory must not remove any video. Count the
  // survivors from evidence itself rather than from the staging directory.
  const survives = countEvidenceVideos(evidenceDir(runId));
  const orphanDir = path.join(evidenceDir(runId), "orphan-video");
  const orphans = fs.existsSync(orphanDir)
    ? fs.readdirSync(orphanDir).filter((f) => f.endsWith(".webm"))
    : [];
  console.log(JSON.stringify({
    cleaned: runId,
    killed,
    evidenceArtifacts: ev,
    evidenceVideosSurviving: survives,
    // Interrupted attempts' recordings are preserved inside evidence, so
    // removing the staging directory must not remove any of them.
    orphanRecordingsPreserved: orphans.length,
    orphanRecordings: orphans.map((f) => ({
      file: f,
      bytes: fs.statSync(path.join(orphanDir, f)).size,
    })),
    videoStagingRemoved: !fs.existsSync(video),
  }));
}

/* --------------------------------- main --------------------------------- */

/** Handlers whose live code path is fixture-coupled enough to need an
 *  intercepted, zero-provider proof. */
const LIVE_HANDLER_FEATURES = ["result", "viewer"];

/** A valid, honest result shape served locally for an intercepted live
 *  submission: provider-validated empty collections → INSUFFICIENT_EVIDENCE. It
 *  is a DECLARED result, never presented as provider truth. */
const DEFAULT_DECLARED_RESULT = "controlled-insufficient";

const handlers = {
  launch,
  doctor,
  drive,
  "live-ready": liveReady,
  "live-handler": () => drive({ handlerLive: true }),
  evidence,
  cleanup,
};
if (!command || !handlers[command]) {
  console.error(
    "usage: control-contexttrail <launch|doctor|drive|live-ready|live-handler|evidence|cleanup> [args]\n" +
      "  drive <landing|upload|investigation|result|viewer|session|accessibility> --run-id <id>\n" +
      "  live-ready --run-id <id> --manifest <path> --image <path> [--mode claim --claim-text <t>]\n" +
      "    zero-provider validation of a live input manifest; makes no provider call\n" +
      "  live-handler --run-id <id> --feature result|viewer --manifest <path> --image <path>\n" +
      "    [--claim-text <t>] [--declared-result <fixture>]\n" +
      "    runs the PRODUCTION live handler against an intercepted, locally declared result;\n" +
      "    zero provider calls, no real-data claim",
  );
  process.exit(EXIT_SCHEMA);
}
handlers[command]().catch((err) => {
  console.error(`control-contexttrail ${command} failed:`, err?.message ?? err);
  process.exit(EXIT_ASSERT);
});
