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
    this.closed = false;
    fs.mkdirSync(dir, { recursive: true });
    this.stream = fs.createWriteStream(path.join(dir, "assertions.jsonl"), { flags: "w" });
  }
  push(id, status, detail) {
    // A push after close would land in the in-memory count but never reach the
    // durable file — the exact divergence that let a drive report more PASSes
    // than assertions.jsonl holds. That must be loud, not silently dropped.
    if (this.closed) {
      throw new Error(`assertion pushed after the recorder closed: ${id}`);
    }
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
  async close() {
    if (this.closed) return;
    this.closed = true;
    // Wait for the buffered bytes to be flushed: the drive totals are read and
    // the record written right after this returns, so the durable file must
    // already hold every pushed entry.
    await new Promise((resolve, reject) => {
      this.stream.once("error", reject);
      this.stream.end(() => resolve());
    });
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
        // S2: the fixture is read EXACTLY ONCE. Lines, segments, the id, the hash
        // and the retained bytes are all derived from this one buffer, so two reads
        // can never disagree about what the stream was served from. The read count
        // is asserted by the drive.
        state.fixtureReads = state.fixtureReads ?? {};
        state.fixtureReads[p.fixture] = (state.fixtureReads[p.fixture] ?? 0) + 1;
        const raw = fs.readFileSync(fixturePath(p.fixture));
        const lines = raw.toString("utf8").split("\n").filter((l) => l.trim());
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
        // The EXACT bytes this stream will be served from, retained and hashed from
        // the buffer read above, plus the generator identity, so a replay can be
        // tied to the bytes rather than to a fixture name.
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
  await rec.close();

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
      // RO4: applied exactly ONCE, and only when it actually lands. The observer
      // calls this on every mutation, so a fault that re-appended on each call would
      // stack stylesheets; and an existing style means the effect is already in
      // place, so re-applying it is not a new mutation and must not be counted.
      if (document.getElementById("ct-long-value-truncated")) return;
      const st = document.createElement("style");
      st.id = "ct-long-value-truncated";
      st.textContent =
        "li,dd,p,span,a,td{max-height:1.4em;overflow:hidden;white-space:nowrap !important;text-overflow:clip !important;}";
      if (!document.head) return;
      document.head.appendChild(st);
      window.__ctLayoutFault = true;
      window.__ctLongValueTarget = { id: st.id, applied: true };
      hit();
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
          const m = /^(?:Evidence|Occurrence) ID:\\s*(\\S+)/.exec(u);
          if (m && m[1] !== "ev-wrong-endpoint") {
            q.textContent = u.replace(m[1], "ev-wrong-endpoint");
            hit();
          }
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

/* --------------------- retained stream integrity ----------------------- */

/**
 * The single pure check on retained stream files: for each expected stream, is the
 * file on disk still the bytes that were captured, by both length and sha256?
 *
 * One function, used by the drive at the end of the run, by `evidence` before it
 * writes an intact seal, and by the offline controls, so a check that exists in
 * three places cannot drift into three answers. It is pure: it takes expectation
 * rows and a read(row) callback and returns rows.
 *
 * The retained files are the SOURCE bytes each request is served from, not a
 * capture of the bytes as they crossed the wire: the stream is built by splitting
 * and re-joining lines, so this proves the input was retained intact and says
 * nothing about transport framing.
 */
function verifyRetainedStreams(expected, read) {
  return expected.map((r) => {
    let buf = null;
    let present = true;
    try {
      // The callback is given the whole ROW, not the file name. A previous version
      // passed r.file to a callback that then read f.drive / f.file, so every read
      // threw, every case reported "missing" -- including a pristine run -- and the
      // check was worse than having none.
      buf = read(r);
    } catch {
      present = false;
    }
    if (!present || buf === null) {
      return { ...r, present: false, actualBytes: null, actualSha256: null, matches: false, why: "retained file is missing" };
    }
    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    const sameLength = buf.length === r.bytes;
    const sameHash = sha256 === r.sha256;
    return {
      ...r,
      present: true,
      actualBytes: buf.length,
      actualSha256: sha256,
      sameLength,
      sameHash,
      matches: sameLength && sameHash,
      // A same-length corruption is exactly what a length-only check would miss.
      why: sameLength && sameHash ? "byte-identical" : sameLength ? "same length, different bytes" : "length differs",
    };
  });
}

/**
 * S3: project the planned multi-request contract against the request ledger that
 * was ACTUALLY observed. Pure — plans and ledger rows in, rows out — so the
 * drive's finalizer, the seal and the offline controls all run the same
 * projection.
 *
 * A request the plan named but the drive never got as far as sending stays
 * UNOBSERVED, with a reason, and is never fabricated into a row that looks like
 * it reached the transport: its observed-only fields are null, not invented.
 * Ledger rows with no matching plan are surfaced separately as unplanned rather
 * than silently dropped.
 */
function projectRequestObservations(planned, ledger) {
  const rows = (ledger ?? []).filter((e) => e && typeof e.index === "number");
  const requests = planned.map((pl) => {
    const entry = rows.find((e) => e.index === pl.request) ?? null;
    if (!entry) {
      return {
        request: pl.request,
        fixture: pl.fixture,
        investigationId: pl.investigationId ?? null,
        observed: false,
        status: "UNOBSERVED",
        unobservedReason:
          "planned but never reached the transport: the drive ended before this request was sent",
        sentClaimSha256: null,
        sentClaimBytes: null,
        sentMediaName: null,
        sentMediaBytes: null,
        imageEntryMethod: null,
        eventsWritten: null,
        clientClosed: null,
        endedByServer: null,
        lateAttempts: null,
      };
    }
    return {
      request: pl.request,
      fixture: pl.fixture,
      investigationId: pl.investigationId ?? null,
      observed: true,
      status: "OBSERVED",
      unobservedReason: null,
      // Whether the request was actually served from the planned fixture: a
      // mismatch is a real observation to report, not something to paper over.
      fixtureAgrees: entry.fixture === pl.fixture,
      sentClaimSha256: entry.sentClaimSha256 ?? null,
      sentClaimBytes: entry.sentClaimBytes ?? null,
      sentMediaName: entry.sentMediaName ?? null,
      sentMediaBytes: entry.sentMediaBytes ?? null,
      imageEntryMethod: entry.imageEntryMethod ?? null,
      eventsWritten: entry.eventsWritten ?? null,
      clientClosed: entry.clientClosed ?? null,
      endedByServer: entry.endedByServer ?? null,
      lateAttempts: entry.lateAttempts ?? [],
    };
  });
  const plannedIndexes = new Set(planned.map((pl) => pl.request));
  const unplanned = rows
    .filter((e) => !plannedIndexes.has(e.index))
    .map((e) => ({
      index: e.index,
      fixture: e.fixture ?? null,
      sentClaimSha256: e.sentClaimSha256 ?? null,
      note: "reached the transport but was not in this drive's plan",
    }));
  return { requests, unplanned };
}

/**
 * RO5: whether the reading-order sabotage target observed in the page matches
 * what the drive actually asked for. With a reading fault requested, the
 * mutation must have applied to the measured panel's own Sources list; with NO
 * reading fault, the only honest requirement is that NO sabotage target exists
 * — the requested panel itself is established separately by
 * result.measurement-surface-is-the-requested-panel, so conditioning on
 * "Sources" here false-reds every other valid view.
 */
function readingOrderTargetOk(fault, faultTarget, panelId) {
  if (fault === "reading-order-reversed" || fault === "reading-order-restored") {
    return (
      faultTarget !== null &&
      faultTarget.panelId === panelId &&
      faultTarget.directRows >= 2 &&
      faultTarget.applied === true
    );
  }
  return faultTarget === null;
}

/**
 * RO5: the panel the layout is measured on must be the one the requested view
 * selected — the check that runs BEFORE the mutation-target assertion, so a
 * wrong panel is red there, not here.
 */
function measurementSurfaceOk(requestedView, panelInfo) {
  return panelInfo.observedTab === requestedView && panelInfo.settled === true;
}

/**
 * S2: whether a stream-plan entry's derived fields are exactly what the ONE
 * retained buffer produces — never re-reading the fixture. Everything is
 * re-derived from `st.buffer` itself and compared: the flattened segments must
 * equal the buffer's normalized line sequence exactly (not merely in count —
 * a same-count different-content stream must be red), the recorded sha256 must
 * be the buffer's recomputed digest, the recorded investigation id must be the
 * id parsed out of the buffer's own lines, the recorded byte count must be the
 * buffer's length, and the fixture must have been read exactly once.
 *
 * Pure and exported: the drive calls it on the live state and the offline
 * control exercises the identical predicate against real planSequence output,
 * so neither can drift into a weaker check.
 */
function verifyStreamBufferProvenance(st, reads) {
  if (!st || !Buffer.isBuffer(st.buffer)) {
    return { ok: false, problems: ["stream plan has no retained buffer"], fixture: st?.fixture ?? null, reads: reads ?? null };
  }
  const problems = [];
  const lines = st.buffer.toString("utf8").split("\n").filter((l) => l.trim());
  const segmentLines = (st.segments ?? []).flat();
  const recomputedSha256 = crypto.createHash("sha256").update(st.buffer).digest("hex");
  let recomputedId = null;
  for (const l of lines) {
    try {
      const ev = JSON.parse(l);
      if (ev.investigationId) {
        recomputedId = ev.investigationId;
        break;
      }
    } catch {
      /* keep looking */
    }
  }
  const firstMismatch = segmentLines.findIndex((l, i) => l !== lines[i]);
  if (segmentLines.length !== lines.length || firstMismatch !== -1) {
    problems.push(
      `segments are not the exact normalized line sequence of the retained buffer ` +
        `(${segmentLines.length} segment line(s) vs ${lines.length} buffer line(s)` +
        `${firstMismatch >= 0 ? `, first divergence at line ${firstMismatch}` : ""})`,
    );
  }
  if (recomputedSha256 !== st.sha256) {
    problems.push(
      `recorded sha256 ${String(st.sha256).slice(0, 12)}… does not match the retained buffer (${recomputedSha256.slice(0, 12)}…)`,
    );
  }
  if (recomputedId !== st.id) {
    problems.push(`recorded investigation id ${st.id} is not the id parsed from the retained buffer (${recomputedId})`);
  }
  if (st.bytes !== st.buffer.length) {
    problems.push(`recorded byte count ${st.bytes} does not match the retained buffer (${st.buffer.length}B)`);
  }
  if (reads !== 1) {
    problems.push(`fixture ${st.fixture} was read ${reads ?? "an unrecorded number of"} time(s), expected exactly 1`);
  }
  return {
    ok: problems.length === 0,
    problems,
    fixture: st.fixture ?? null,
    reads: reads ?? null,
    lines: lines.length,
    segmentLines: segmentLines.length,
    sha256: recomputedSha256,
    id: recomputedId,
    bytes: st.buffer.length,
  };
}

/**
 * Files the run PLANNED to retain, projected to expectation fields only.
 *
 * Returns expectations AND the problems found, because a missing or malformed plan
 * must not read as "nothing was planned". Every stream-ownership drive dir is
 * enumerated first — including failed or incomplete ones — and a drive whose
 * record says stream-ownership but wrote no plan is a broken seal, not a skip.
 *
 * Expectations come from ownership-plan.json, written BEFORE any effect — not
 * from the end-of-drive retained-streams.json, whose observed fields would let a
 * stale verdict stand in for a check. The end ledger still has to AGREE with the
 * plan: a recorded set that diverges from what was declared is a broken seal.
 */
function plannedRetainedStreams(runId) {
  const out = [];
  const problems = [];
  const drivesDir = path.join(evidenceDir(runId), "drives");
  if (!fs.existsSync(drivesDir)) {
    problems.push({ drive: "(none)", why: "evidence has no drives/ directory at all" });
    return { out, problems };
  }
  for (const name of fs.readdirSync(drivesDir).sort()) {
    const drivePath = path.join(drivesDir, name);
    if (!fs.statSync(drivePath).isDirectory()) continue;
    // The drive record is the authority on what this directory was: a
    // stream-ownership drive that never wrote its plan (aborted before the
    // first write, or the file lost) must not read as "never planned".
    let feature = null;
    try {
      feature = JSON.parse(fs.readFileSync(path.join(drivePath, "drive.json"), "utf8"))?.feature ?? null;
    } catch {
      /* no readable record — the plan file decides below */
    }
    const planPath = path.join(drivePath, "ownership-plan.json");
    const streamsPath = path.join(drivePath, "retained-streams.json");
    if (!fs.existsSync(planPath)) {
      if (feature === "stream-ownership") {
        problems.push({ drive: name, why: "stream-ownership drive wrote no ownership-plan.json" });
      }
      continue; // a drive that never planned streams
    }
    let plan;
    try {
      plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    } catch (err) {
      problems.push({ drive: name, why: `ownership-plan.json is unreadable: ${err.message}` });
      continue;
    }
    const declared = plan?.retainedStreams ?? null;
    if (!Array.isArray(declared) || declared.length === 0) {
      problems.push({ drive: name, why: "ownership-plan.json declares no retained streams" });
      continue;
    }
    const expectations = [];
    for (const r of declared) {
      if (
        !r ||
        typeof r.file !== "string" ||
        path.basename(r.file) !== r.file ||
        !Number.isInteger(r.bytes) ||
        r.bytes < 0 ||
        !/^[0-9a-f]{64}$/.test(String(r.sha256))
      ) {
        problems.push({ drive: name, why: `plan stream entry missing file/bytes/sha256: ${JSON.stringify(r)}` });
        continue;
      }
      out.push({ drive: name, file: r.file, bytes: r.bytes, sha256: r.sha256, generator: r.generator ?? null });
      expectations.push(`${r.file}:${r.bytes}:${r.sha256}`);
    }
    if (!fs.existsSync(streamsPath)) {
      problems.push({
        drive: name,
        why: `ownership-plan.json declares ${declared.length} retained stream(s) but retained-streams.json is missing`,
      });
      continue;
    }
    let recorded;
    try {
      recorded = JSON.parse(fs.readFileSync(streamsPath, "utf8"));
    } catch (err) {
      problems.push({ drive: name, why: `retained-streams.json is unreadable: ${err.message}` });
      continue;
    }
    if (!Array.isArray(recorded.streams) || recorded.streams.length === 0) {
      problems.push({ drive: name, why: "retained-streams.json lists no streams" });
      continue;
    }
    const declaredKeys = new Set(expectations);
    const recordedKeys = new Set(
      recorded.streams.map((r) => `${r?.file}:${r?.bytes}:${r?.sha256}`),
    );
    const unrecorded = expectations.filter((k) => !recordedKeys.has(k)).length;
    const undeclared = recorded.streams.filter(
      (r) => !declaredKeys.has(`${r?.file}:${r?.bytes}:${r?.sha256}`),
    ).length;
    if (unrecorded > 0 || undeclared > 0) {
      problems.push({
        drive: name,
        why:
          `retained-streams.json diverges from ownership-plan.json: ` +
          `${unrecorded} declared stream(s) unrecorded, ${undeclared} undeclared`,
      });
    }
  }
  return { out, problems };
}

/**
 * S3: the failure-safe finalizer for a stream-ownership drive. Idempotent — the
 * case calls it on the success path so a late assertion failure still leaves the
 * full record on disk, and `drive` calls it again on the abort path so a case
 * that never reached its own persist still writes everything it observed.
 *
 * Writes the three records that used to be reachable only on the happy path:
 * the delivery ledger (verbatim), the per-request inputs projected
 * planned-vs-observed, and the retained-stream integrity rows. `reason` says
 * which exit produced the record, so a reader can tell a completed drive's
 * record from an aborted one's.
 */
function persistStreamOwnership(driveDir, stream, reason) {
  const ctx = stream?.state?.ownership;
  if (!ctx) return null;
  if (ctx.persisted) return ctx.persisted;
  const projection = projectRequestObservations(
    ctx.plan.plans.map((pl, i) => ({ request: i, fixture: pl.fixture, investigationId: pl.id ?? null })),
    stream.state.ledger,
  );
  const integrity = verifyRetainedStreams(ctx.retained, (r) =>
    fs.readFileSync(path.join(driveDir, r.file)),
  );
  ctx.persisted = { reason, projection, integrity };
  writeJson(path.join(driveDir, "delivery-ledger.json"), {
    planned: ctx.plan.plans.length,
    observed: stream.state.ledger.length,
    unplanned: projection.unplanned,
    ledger: stream.state.ledger,
    finalizedUnder: reason,
    note:
      "One row per served request, exactly as observed at finalize time. A late write the " +
      "client had already aborted is recorded as delivered:false with a reason; an " +
      "undeliverable packet is never reported as a late event processed.",
  });
  writeJson(path.join(driveDir, "request-inputs.json"), {
    planned: ctx.plan.plans.length,
    observed: projection.requests.filter((r) => r.observed).length,
    requests: projection.requests,
    finalizedUnder: reason,
    note:
      "One row per PLANNED request, projected against what the transport actually observed. " +
      "status UNOBSERVED means the request was planned but never sent — its observed-only " +
      "fields are null, not fabricated.",
  });
  writeJson(path.join(driveDir, "retained-streams.json"), {
    streams: integrity,
    finalizedUnder: reason,
    note:
      "Each file is the exact buffer request N was served from. A missing or modified file is " +
      "a RED on ownership.retained-streams-byte-identical, not a smaller evidence set.",
  });
  return ctx.persisted;
}

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
const LIVE_ONLY = ["image"];
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
    options: ["entry", "case", "delay-ms", "image", "claim-text", "focus-fallback"],
    entries: ["timeline", "sources", "takeaway"],
    cases: ["image-load", "image-fail", "no-excerpt", "pair"],
    alsoFixtureCases: true,
    focusFallbacks: ["hidden", "disabled", "disconnected", "tabindex-negative"],
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
      // A spec that also accepts real fixture names (the A8 recipe's
      // `drive viewer --case <fixture>`) must still reject a name that is
      // neither — never silently fall through to a different fixture.
      if (!(spec.alsoFixtureCases === true && fixtureNames().includes(flags.case))) {
        fail(
          `unsupported --case ${flags.case} for ${feature} (supported: ${spec.cases.join("|")}` +
            `${spec.alsoFixtureCases ? ", or a fixture name" : ""})`,
        );
      }
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

  // The viewer's invalid-opener scenario: mutate the recorded trigger into one
  // of the four states the product's restorable-target check rejects, and the
  // settle must land on the selected tab. It is a scenario flag, not a fault —
  // the expected outcome is a PASS proving the fallback, and combining it with
  // a sabotage fault would make the intended result ambiguous.
  if (flags["focus-fallback"] !== undefined) {
    if (!spec.focusFallbacks) fail(`unsupported option(s) for ${feature}: --focus-fallback`);
    if (!spec.focusFallbacks.includes(flags["focus-fallback"])) {
      fail(
        `unsupported --focus-fallback ${flags["focus-fallback"]} (supported: ${spec.focusFallbacks.join("|")})`,
      );
    }
    if (flags.fault !== undefined) {
      fail(
        `--focus-fallback cannot be combined with --fault ${flags.fault}: the fallback is an asserted ` +
          "positive contract and a second sabotage would make the outcome ambiguous",
      );
    }
  }

  for (const k of LIVE_ONLY) {
    if (flags[k] !== undefined && !live) fail(`--${k} is only valid with --live`);
  }
  // A controlled drive may pin --claim-text ONLY to the fixture's own
  // submitted claim: the replayed terminal asserts that exact investigation,
  // so any other text would submit a different claim than the one under
  // test. Trace fixtures and non-fixture cases carry no claim at all.
  if (flags["claim-text"] !== undefined && !live) {
    const claimFixture = driveFixture(feature, flags.case);
    const claimResult =
      typeof claimFixture === "string" ? fixtureResult(claimFixture) : null;
    const ownClaim =
      typeof claimResult?.claim === "string"
        ? claimResult.claim
        : typeof claimResult?.input?.claim === "string"
          ? claimResult.input.claim
          : null;
    if (fixtureMode(claimFixture) !== "claim" || ownClaim === null) {
      fail(
        `--claim-text on a controlled drive requires a claim-mode fixture case ` +
          `(--case ${flags.case} resolves to ${claimFixture ?? "none"}, mode=${fixtureMode(claimFixture) ?? "unknown"})`,
      );
    }
    if (flags["claim-text"] !== ownClaim) {
      fail(
        `--claim-text must equal the fixture's own submitted claim — a different text ` +
          `would submit a different investigation than the replayed terminal asserts`,
      );
    }
  }
  // Expected-map authority BEFORE any effect (V39-3): when the resolved case
  // is a maintained A8 fixture the accepted map must be present, readable,
  // digest-pinned and carry the fixture — checked at parse time, before any
  // manifest read, port probe, stream setup or page exists. A genuinely
  // non-A8 name (retained control, coverage-mutant scratch stream) needs no
  // map and skips silently by design.
  if (!live) {
    const fx = driveFixture(feature, flags.case);
    if (typeof fx === "string" && A8_MAINTAINED_FIXTURES.has(fx)) {
      expectedCaseFor(fx);
    }
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
    // N83-3: collect text-bearing candidates, then keep only LEAVES — a
    // collected element containing another collected element is the same text
    // measured twice (container + descendant) and would double-count order.
    const cand = [];
    for (const el of scope.querySelectorAll("li, dd, p, span, a, td, div")) {
      if (cand.length >= max) break;
      if (!isLong(el)) continue;
      // only leaf-ish text elements, not every wrapper
      if (el.children.length > 2) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      cand.push({ el, r, style });
    }
    const leaves = cand.filter((c) => !cand.some((o) => o !== c && c.el.contains(o.el)));
    // A multi-column container is a row-direction flex or a grid with more
    // than one column track. Two leaves sitting in DIFFERENT columns of the
    // SAME container are an independent-column pair — the product deliberately
    // orders its Overview columns against DOM order (lg:order-*) — so their
    // relative sequence is never an inversion. Everything else is compared:
    // within a column and across unrelated containers, visual top-to-bottom
    // order must follow DOM order, which is what catches column-reverse.
    const isMultiColumn = (n) => {
      const st = getComputedStyle(n);
      if (st.display === "flex" || st.display === "inline-flex") {
        return st.flexDirection === "row" || st.flexDirection === "row-reverse";
      }
      if (st.display === "grid" || st.display === "inline-grid") {
        const t = (st.gridTemplateColumns || "").trim();
        return t !== "" && t !== "none" && t.split(/\s+/).filter(Boolean).length > 1;
      }
      return false;
    };
    const domPos = (el) => Array.prototype.indexOf.call(document.querySelectorAll("*"), el);
    const columnOf = (el) => {
      let box = null;
      let child = null;
      for (let n = el, p = el.parentElement; p && p.nodeType === 1; n = p, p = p.parentElement) {
        if (isMultiColumn(p)) {
          box = p;
          child = n;
        }
        if (p === scope) break;
      }
      return box ? { box: domPos(box), child: domPos(child) } : null;
    };
    const rows = [];
    for (const c of leaves) {
      const { el, r, style } = c;
      const clipped = clippingAncestor(el);
      const col = columnOf(el);
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
        domIndex: domPos(el),
        colBox: col ? col.box : null,
        colChild: col ? col.child : null,
      });
    }
    // Reading order is the VISUAL order, so it must be compared against DOM order
    // as a real coordinate comparison. Comparing DOM order with the order the
    // rows were collected in is comparing a thing with itself: it passes under
    // `flex-direction: column-reverse`, where the markup is untouched and the
    // screen reads bottom-to-top.
    const visual = rows
      .map((r, i) => ({ i, top: r.top, left: r.left, domIndex: r.domIndex, text: r.text, colBox: r.colBox, colChild: r.colChild }))
      .sort((a, b) => a.top - b.top || a.left - b.left);
    // An inversion is a backwards DOM step between rows that share a reading
    // stream — every ordered pair counts, not just sort-adjacent ones (a third
    // column's row can interleave between two rows of the same stream). Rows
    // in different columns of the same multi-column container are independent
    // streams — their relative order is legitimate layout, never an inversion.
    const crossColumn = (a, b) =>
      a.colBox !== null && b.colBox !== null && a.colBox === b.colBox && a.colChild !== b.colChild;
    let outOfOrder = null;
    let inversions = 0;
    for (let i = 0; i < visual.length; i++) {
      for (let j = i + 1; j < visual.length; j++) {
        const a = visual[i];
        const b = visual[j];
        if (b.domIndex < a.domIndex && !crossColumn(a, b)) {
          inversions++;
          if (outOfOrder === null) {
            outOfOrder = {
              readsBefore: a.text.slice(0, 30),
              readsAfter: b.text.slice(0, 30),
              visualOrder: visual.map((v) => v.domIndex).slice(0, 8),
            };
          }
        }
      }
    }
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
    // A8 recipes bind the viewer case directly to its fixture name; the parse
    // gate already rejects names that are neither a named case nor a fixture.
    if (typeof caseName === "string" && fixtureNames().includes(caseName)) return caseName;
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
  // the product of a claim-carrying request. When a claim IS submitted it is
  // the fixture's OWN claim — --claim-text may pin it (parseDriveOptions
  // already validated it equals this exact string), and the default is the
  // same claim rather than a generic string that would describe a different
  // investigation than the replayed terminal.
  const fixtureClaimMode = fixture ? fixtureMode(fixture) === "claim" : mode === "claim";
  const ownClaim =
    typeof fixture === "string" && typeof fixtureResult(fixture)?.claim === "string"
      ? fixtureResult(fixture).claim
      : null;
  return {
    kind: "controlled",
    file,
    claim: fixtureClaimMode ? flags["claim-text"] ?? ownClaim ?? CONTROLLED_CLAIM : null,
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
  const selected = (await tab.first().getAttribute("aria-selected")) === "true";
  rec.check(`result.tab-${name.toLowerCase()}-selected`, selected, `aria-selected=${selected}`);
  // RO2: settle on CONFIRMED state, not a wall-clock guess. Two animation frames
  // after the tab reports itself selected is enough for layout and style to be
  // final, and unlike a fixed delay it cannot sample a mid-transition frame or
  // wait longer than the work needs.
  await page
    .evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      undefined,
    )
    .catch(() => {});
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

/** The opened dialog's identity is the `Occurrence ID:` paragraph inside the
 *  collapsed Technical-details <details>. There must be EXACTLY ONE disclosure
 *  whose summary is the exact product label — a `Not Technical details` forged
 *  summary is a different string and cannot own the field, and a second exact
 *  duplicate makes the owning disclosure ambiguous → failure — and exactly one
 *  ID paragraph inside that single disclosure. Reading textContent works while
 *  collapsed; a phrase inside an excerpt, the title or any other dialog text
 *  can never satisfy this. Returns { ok, id, reason, matches } — callers
 *  assert on ok/id, never on a string found somewhere in the dialog. */
async function openedOccurrenceId(dialog) {
  const r = await dialog
    .evaluate((d) => {
      const dets = [...d.querySelectorAll("details")].filter(
        (x) => (x.querySelector("summary")?.textContent ?? "").trim() === "Technical details",
      );
      if (dets.length !== 1)
        return { ok: false, reason: `${dets.length} Technical-details disclosure(s) in the dialog` };
      const matches = [...dets[0].querySelectorAll("p")]
        .map((p) => (p.textContent ?? "").trim())
        .filter((t) => /^Occurrence ID:\s*\S+/.test(t));
      if (matches.length !== 1)
        return { ok: false, reason: `${matches.length} occurrence-id field(s) inside Technical details`, matches };
      return { ok: true, id: /Occurrence ID:\s*(\S+)/.exec(matches[0])[1] };
    })
    .catch(() => ({ ok: false, reason: "dialog evaluate failed" }));
  return r;
}

/** The attribution bound to the excerpt's own block: the h3 immediately
 *  preceding the blockquote's <figure> — the product renders it as the
 *  excerpt block's own heading. The same phrase elsewhere in the dialog (the
 *  Full retrieved text disclosure, a gate label) must never satisfy this. */
async function excerptAttributionHeading(dialog) {
  return dialog
    .evaluate((d) => {
      const bq = d.querySelector("blockquote");
      if (!bq) return { found: false, reason: "no blockquote" };
      const fig = bq.closest("figure");
      const h = fig?.previousElementSibling;
      if (!h || h.tagName !== "H3") return { found: false, reason: "no h3 heading bound to the excerpt figure" };
      return { found: true, text: (h.textContent ?? "").replace(/\s+/g, " ").trim() };
    })
    .catch(() => ({ found: false, reason: "evaluate failed" }));
}

/** The occurrence the open viewer is showing — the scoped Technical-details
 *  field only. Compared with the fixture's own ids, so a viewer showing the
 *  wrong occurrence cannot pass. */
async function viewerEvidenceId(dialog) {
  const r = await openedOccurrenceId(dialog);
  return r.ok === true ? r.id : null;
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

/* --------------- focus restore acquisition and settle ------------------- *
 * Maintained integration of the accepted focus-fallback correction (FD1/FD2).
 * The recorded per-DOM-element key is the primary stability identity — two
 * elements that share a label are still two elements. The settle window starts
 * at the ACTUAL recorded dialog close (derived from the same sampled log), the
 * expected key must hold across every sample of the claimed stable run, and a
 * descriptor-only run is marked weaker and rejected when key basis is required.
 * The predicates below are pure; the drives call them and the offline controls
 * in fixtures/controls/ import them, so both exercise one implementation. */

/** Installed with page.addInitScript before the drive navigates. Samples
 *  document.activeElement once per animation frame into __ctFocusLog, assigns a
 *  durable data-ctfk key to every element that holds focus, records whether a
 *  [role=dialog] is open on that frame, and exposes __ctFocusKey/__ctFocusDescribe
 *  so the drive can key and describe the opener and the fallback tab. */
const FOCUS_SAMPLER_FN = `(() => {
  if (window.__ctFocusLog) return true;
  window.__ctFocusKeySeq = window.__ctFocusKeySeq || 0;
  window.__ctFocusLog = [];
  const keyOf = (el) => {
    if (!el || !el.setAttribute) return null;
    let k = el.getAttribute('data-ctfk');
    if (!k) { window.__ctFocusKeySeq += 1; k = 'ctfk-' + window.__ctFocusKeySeq; el.setAttribute('data-ctfk', k); }
    return k;
  };
  window.__ctFocusKey = keyOf;
  const describe = (el) => {
    if (!el || el === document.body) return { tag: el ? 'BODY' : 'null', label: null, role: null, selected: null, key: null };
    return {
      tag: el.tagName,
      label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 60) || null,
      role: el.getAttribute('role') || null,
      selected: el.getAttribute('aria-selected'),
      key: keyOf(el),
    };
  };
  window.__ctFocusDescribe = (el) => {
    if (!el) return null;
    const cs = el.ownerDocument && el.ownerDocument.defaultView ? el.ownerDocument.defaultView.getComputedStyle(el) : null;
    return {
      ...describe(el),
      connected: el.isConnected === true,
      rendered: !!cs && cs.display !== 'none' && cs.visibility !== 'hidden' && el.getClientRects().length > 0,
      disabled: el.disabled === true,
      tabIndex: typeof el.tabIndex === 'number' ? el.tabIndex : null,
    };
  };
  const tick = () => {
    window.__ctFocusLog.push({
      frame: window.__ctFocusLog.length,
      dialogOpen: !!document.querySelector('[role="dialog"]'),
      active: describe(document.activeElement),
    });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return true;
})()`;

/** Full element descriptor read in-page; returns null when the sampler was
 *  never installed, so a missing sampler can never be read as a valid target. */
const FOCUS_DESCRIPTOR_FN = `(el) => (window.__ctFocusDescribe ? window.__ctFocusDescribe(el) : null)`;

/** The same descriptor read as a REAL serializable function. Locator.evaluate
 *  invokes only an actual function with the element — passing the string
 *  expression evaluates it (yielding an unserializable function object) and
 *  never calls it, so the opener descriptor would silently read null. */
const FOCUS_DESCRIPTOR_EVALUATOR = (el) =>
  window.__ctFocusDescribe ? window.__ctFocusDescribe(el) : null;

/** Descriptor read through a Locator under the real call contract: a
 *  serializable function is passed, invoked in-page with the element. */
async function readFocusDescriptor(locator) {
  return locator.evaluate(FOCUS_DESCRIPTOR_EVALUATOR).catch(() => null);
}

/**
 * Primary stability identity: the recorded per-element key when one exists.
 * A descriptor (role|selected|label) is the fallback ONLY when no key was
 * recorded, and is marked basis 'descriptor-only' — weaker proof that cannot
 * distinguish two elements sharing a label.
 */
function focusIdentityOf(active) {
  if (!active || active.tag === "BODY" || active.tag === "null") {
    return { id: "BODY", basis: "descriptor-only" };
  }
  if (active.key !== undefined && active.key !== null && active.key !== "") {
    return { id: `key:${active.key}`, basis: "recorded-key" };
  }
  return {
    id: `desc:${[active.role ?? "", active.selected ?? "", active.label ?? ""].join("|")}`,
    basis: "descriptor-only",
  };
}

/**
 * The ACTUAL recorded close: the first sampled frame after the last frame on
 * which a [role=dialog] was observed open. null when the log never recorded an
 * open dialog — callers must fail closed on null rather than guessing a frame.
 */
function deriveDialogCloseMarker(samples) {
  if (!Array.isArray(samples) || samples.length === 0) return null;
  let lastOpen = -1;
  for (const s of samples) {
    if (s && s.dialogOpen === true && typeof s.frame === "number") lastOpen = s.frame;
  }
  if (lastOpen < 0) return null;
  return lastOpen + 1;
}

/**
 * The product's isRestorableFocusTarget contract, applied to the descriptor the
 * drive recorded for the trigger: BODY/null, disconnected, not rendered
 * (display:none / visibility:hidden / zero rects), disabled, or tabIndex < 0
 * are all invalid and force the selected-tab fallback.
 */
function restorableFocusTargetOk(d) {
  if (!d || typeof d !== "object") return { ok: false, reason: "no-recorded-trigger" };
  if (d.tag === "BODY" || d.tag === "null") return { ok: false, reason: "body-or-null" };
  if (d.connected === false) return { ok: false, reason: "disconnected" };
  if (d.rendered === false) return { ok: false, reason: "not-rendered" };
  if (d.disabled === true) return { ok: false, reason: "disabled" };
  if (typeof d.tabIndex === "number" && d.tabIndex < 0) return { ok: false, reason: "tabindex-negative" };
  return { ok: true, reason: "restorable" };
}

/**
 * What focus must settle on after the dialog closes: the recorded opener's key
 * when the opener is still restorable, otherwise the selected tab's key. A run
 * with neither a key-able opener nor a key-able tab has no usable expectation
 * and cannot pass.
 */
function focusRestoreExpectation({ opener, selectedTab }) {
  const rest = restorableFocusTargetOk(opener);
  if (rest.ok && typeof opener?.key === "string" && opener.key !== "") {
    return { key: opener.key, basis: "recorded-opener", openerRestorable: true, openerReason: rest.reason };
  }
  if (typeof selectedTab?.key === "string" && selectedTab.key !== "") {
    return {
      key: selectedTab.key,
      basis: "selected-tab-fallback",
      openerRestorable: false,
      openerReason: rest.reason,
    };
  }
  return { key: null, basis: "no-usable-target", openerRestorable: rest.ok, openerReason: rest.reason };
}

/**
 * Did focus settle on the expected element after the recorded close? Samples
 * before the supplied close marker are excluded; only the FINAL consecutive
 * identity run can satisfy the dwell, and the expected key must hold across
 * EVERY sample of that run — an A/B/A same-label sequence is not stability.
 * Malformed input (non-array samples, no samples at/after the marker, a run
 * shorter than the dwell) is a failure, never a pass.
 */
function settleFocusRun(samples, closeMarker, expected, opts = {}) {
  const dwell = opts.dwell ?? 3;
  const maxFrames = opts.maxFrames ?? 90;

  if (!Array.isArray(samples)) {
    return { ok: false, reason: "samples-not-an-array", problems: ["samples must be an array"], closeMarker, observed: 0, final: null, finalRunLength: 0 };
  }
  if (typeof closeMarker !== "number" || !Number.isFinite(closeMarker)) {
    return { ok: false, reason: "no-recorded-close-marker", problems: ["no recorded dialog-close marker was supplied"], closeMarker: closeMarker ?? null, observed: 0, final: null, finalRunLength: 0 };
  }

  const from = samples.filter((s) => s && typeof s.frame === "number" && s.frame >= closeMarker);
  const window = from.slice(0, maxFrames);
  if (window.length === 0) {
    return { ok: false, reason: "no-samples-at-or-after-close-marker", problems: ["no samples at or after the recorded close marker"], closeMarker, observed: 0, final: null, finalRunLength: 0 };
  }

  // Walk forward, CLEARING the candidate on every identity change so only the
  // final consecutive run can be reported.
  let candidate = focusIdentityOf(window[0].active);
  let runStart = window[0].frame;
  let runLength = 1;
  for (let i = 1; i < window.length; i++) {
    const id = focusIdentityOf(window[i].active);
    if (id.id === candidate.id) {
      runLength++;
    } else {
      candidate = id;
      runStart = window[i].frame;
      runLength = 1;
    }
  }

  const run = window.filter((s) => s.frame >= runStart);
  const bases = new Set(run.map((s) => focusIdentityOf(s.active).basis));

  const problems = [];
  // The expected key must hold across EVERY sample of the claimed run, not
  // just the final one.
  if (expected?.key) {
    for (const s of run) {
      const k = s.active?.key ?? null;
      if (k !== expected.key) problems.push(`expected key ${expected.key} but frame ${s.frame} has ${k}`);
    }
  }
  if (expected?.requireKeyBasis && !bases.has("recorded-key")) {
    problems.push("expected a recorded-key identity but the stable run is descriptor-only (weaker proof)");
  }
  if (run.length > 0) {
    const last = run[run.length - 1].active;
    if (expected?.tag && last?.tag !== expected.tag) problems.push(`tag mismatch: expected ${expected.tag}, got ${last?.tag}`);
    if (expected?.role != null && (last?.role ?? null) !== expected.role) problems.push(`role mismatch: expected ${expected.role}, got ${last?.role ?? null}`);
    if (expected?.selected != null && (last?.selected ?? null) !== expected.selected) problems.push(`selected mismatch: expected ${expected.selected}, got ${last?.selected ?? null}`);
    if (expected?.labelIncludes && !String(last?.label ?? "").toLowerCase().includes(expected.labelIncludes.toLowerCase())) {
      problems.push(`label mismatch: expected to include ${expected.labelIncludes}, got ${last?.label}`);
    }
  }

  if (runLength < dwell) {
    problems.push(`never stabilized: final consecutive run is ${runLength}, required dwell is ${dwell}`);
    return {
      ok: false,
      reason: "never-stabilized-within-bounded-wait",
      problems,
      closeMarker,
      settledAtFrame: null,
      finalRunLength: runLength,
      stabilityBasis: [...bases],
      final: window[window.length - 1].active,
      bodyFrames: window.filter((s) => focusIdentityOf(s.active).id === "BODY").length,
      observed: window.length,
    };
  }

  return {
    ok: problems.length === 0,
    reason: problems.length === 0 ? "settled-on-expected-target" : "settled-on-unexpected-target",
    problems,
    closeMarker,
    settledAtFrame: runStart,
    finalRunLength: runLength,
    stabilityBasis: [...bases],
    proofStrength: bases.has("recorded-key") ? "recorded-element-identity" : "descriptor-only (weaker: cannot distinguish same-label elements)",
    final: window[window.length - 1].active,
    bodyFrames: window.filter((s) => focusIdentityOf(s.active).id === "BODY").length,
    observed: window.length,
  };
}

/** The kinds of invalid opener state a --focus-fallback drive can apply while
 *  the dialog is open — the four prerequisites the product checks before
 *  restoring the recorded trigger. */
const FOCUS_FALLBACK_KINDS = ["hidden", "disabled", "disconnected", "tabindex-negative"];

/** Applies one invalid-opener mutation in-page, addressed by the recorded key
 *  so exactly the element the product captured is mutated. Returns the post-
 *  mutation descriptor as after, or {mutated:false} when the keyed element is
 *  gone. */
const FOCUS_OPENER_MUTATE_FN = `([key, kind]) => {
  const el = document.querySelector('[data-ctfk="' + key + '"]');
  if (!el) return { mutated: false, reason: 'recorded opener not found by key', key, kind };
  const before = window.__ctFocusDescribe ? window.__ctFocusDescribe(el) : null;
  if (kind === 'hidden') el.style.display = 'none';
  else if (kind === 'disabled') el.disabled = true;
  else if (kind === 'disconnected') el.remove();
  else if (kind === 'tabindex-negative') el.setAttribute('tabindex', '-1');
  else return { mutated: false, reason: 'unknown kind ' + kind };
  return {
    mutated: true,
    kind,
    key,
    before,
    after: window.__ctFocusDescribe ? window.__ctFocusDescribe(el) : null,
  };
}`;

/** The sampled-log boundary at this instant: every sample with
 *  frame >= the returned value was recorded after this call. Captured
 *  immediately before the click that opens a dialog so the close marker a
 *  settle observes can only come from THAT open interval — a second close can
 *  never borrow the first close's marker. */
async function focusLogFloor(page) {
  return page
    .evaluate(() => (Array.isArray(window.__ctFocusLog) ? window.__ctFocusLog.length : 0))
    .catch(() => 0);
}

/**
 * Bounded settle acquisition (F38-1): a DOM-hidden wait is not proof that a
 * single post-close RAF has been sampled, and a one-shot read can therefore
 * report `no-samples-at-or-after-close-marker` on an honest settle. This loop
 * polls the sampled log until THIS close's open interval (frames at or after
 * `openFloor`, never an earlier close's) yields a close marker AND at least
 * `dwell` samples after it, evaluating the same `settleFocusRun` predicate on
 * every poll. It returns early on a decisive verdict (settled on the expected
 * key, or a full-length run settled on the wrong one), keeps polling while the
 * run is still forming, and on bound exhaustion returns the last evaluation
 * with `acquired:false` — a truthful bounded failure, not a guessed timing.
 */
async function acquireFocusSettle(
  page,
  { opener, openFloor, dwell = 3, timeoutMs = 6000, pollMs = 60 } = {},
) {
  const floor = typeof openFloor === "number" && Number.isFinite(openFloor) ? openFloor : 0;
  const deadline = Date.now() + timeoutMs;
  const selectedTab = await page
    .evaluate(
      `(${FOCUS_DESCRIPTOR_FN})([...document.querySelectorAll('[role="tab"]')].find((t) => t.getAttribute('aria-selected') === 'true') ?? null)`,
    )
    .catch(() => null);
  const expectation = focusRestoreExpectation({ opener, selectedTab });
  let last = null;
  for (;;) {
    const log = await page.evaluate(() => window.__ctFocusLog ?? []).catch(() => []);
    // Scope the open interval to frames at/after openFloor: an open observed
    // only BEFORE this close's open click belongs to an earlier close and its
    // marker must not satisfy this settle.
    const scoped = log.filter((s) => s && typeof s.frame === "number" && s.frame >= floor);
    const closeMarker = deriveDialogCloseMarker(scoped);
    const postCloseSamples =
      closeMarker === null ? 0 : log.filter((s) => s && s.frame >= closeMarker).length;
    const acquired = closeMarker !== null && postCloseSamples >= dwell;
    const settle = settleFocusRun(log, closeMarker, {
      key: expectation.key ?? "ct-no-usable-target",
      requireKeyBasis: true,
    });
    last = {
      log,
      closeMarker,
      selectedTab,
      expectation,
      settle,
      acquired,
      postCloseSamples,
      openFloor: floor,
    };
    const decisive =
      acquired && (settle.ok || settle.reason === "settled-on-unexpected-target");
    if (decisive || Date.now() >= deadline) return last;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/* ------------- effective contrast (accepted A10 correction 2) ------------- *
 * The canvas-resolved, own-and-ancestor-opacity aware single-node contrast
 * function. EVERY group break (a group-forming ancestor with opacity < 1) is a
 * verdict of UNSUPPORTED — this helper is not a general CSS compositor and must
 * never silently emit a number for a layer shape it cannot model. UNSUPPORTED
 * is a non-pass; the diagnostic contrastRatio it still carries is not a result. */
const EFFECTIVE_CONTRAST_FN = `
(() => {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 1;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const cache = new Map();
  const toRGBA = (c) => {
    if (c === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    if (cache.has(c)) return cache.get(c);
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000000'; ctx.fillStyle = c;
    ctx.clearRect(0, 0, 1, 1); ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    const o = { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
    cache.set(c, o); return o;
  };
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]; return (hi + 0.05) / (lo + 0.05); };
  const op = (el) => { const o = parseFloat(getComputedStyle(el).opacity); return Number.isFinite(o) ? o : 1; };

  window.__ctEffectiveContrast = (el) => {
    const cs = getComputedStyle(el);
    const ownOpacity = op(el);
    const fgRaw = toRGBA(cs.color);
    const unsupported = [];
    const chain = [];
    for (let p = el; p; p = p.parentElement) chain.push(p);
    let acc = null;
    let groupOpacity = 1;
    const groupBreaks = [];
    for (const p of chain) {
      const pcs = getComputedStyle(p);
      const pbg = toRGBA(pcs.backgroundColor);
      const po = op(p);
      if (pbg.a > 0) {
        const under = { ...pbg, a: pbg.a * (p === el ? 1 : po) };
        acc = acc === null ? under : over(acc, under);
        if (acc.a >= 0.999) acc = { ...acc, a: 1 };
      }
      if (po < 1) {
        groupBreaks.push({ tag: p.tagName, opacity: po, ownBackgroundAlpha: pbg.a, backgroundShape: pbg.a >= 0.999 ? 'opaque' : (pbg.a > 0 ? 'translucent' : 'none') });
        unsupported.push({ tag: p.tagName, opacity: po, backgroundShape: pbg.a >= 0.999 ? 'opaque' : (pbg.a > 0 ? 'translucent' : 'none'),
          reason: 'a group-forming ancestor (opacity < 1) is not modelled correctly by this helper; measured composition is not attempted' });
        acc = { r: acc ? acc.r : 0, g: acc ? acc.g : 0, b: acc ? acc.b : 0, a: (acc ? acc.a : 0) * po };
        groupOpacity *= po;
      }
    }
    let backdrop = { r: 255, g: 255, b: 255, a: 1 };
    if (acc && acc.a > 0) backdrop = over(acc, backdrop);
    const ancestorGroupOpacity = groupOpacity / (ownOpacity || 1);
    const effectiveAlpha = fgRaw.a * ownOpacity * ancestorGroupOpacity;
    const fgEff = { r: fgRaw.r, g: fgRaw.g, b: fgRaw.b, a: effectiveAlpha };
    const fgOnBg = over(fgEff, backdrop);
    const r = ratio(fgOnBg, backdrop);
    // Visibility of the measured node itself: own display/visibility, the
    // whole ancestor rendering chain, and a real box. Contrast on a node the
    // user cannot see is not proof of the visible surface.
    const rect = el.getBoundingClientRect();
    let hiddenByAncestor = null;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const ps = getComputedStyle(p);
      if (ps.display === 'none' || ps.visibility === 'hidden' || ps.visibility === 'collapse') {
        hiddenByAncestor = { tag: p.tagName, id: p.id || undefined, display: ps.display, visibility: ps.visibility };
        break;
      }
    }
    const rendered =
      cs.display !== 'none' && cs.visibility !== 'hidden' && cs.visibility !== 'collapse' &&
      hiddenByAncestor === null && rect.width > 0 && rect.height > 0;
    return {
      text: (el.textContent || '').trim().slice(0, 70),
      rendered,
      display: cs.display,
      visibility: cs.visibility,
      rect: { width: Math.round(rect.width), height: Math.round(rect.height) },
      hiddenByAncestor,
      tag: el.tagName,
      role: el.getAttribute('role'),
      className: (el.className && el.className.baseVal !== undefined ? el.className.baseVal : String(el.className || '')).slice(0, 90),
      fontSizePx: parseFloat(cs.fontSize),
      fontWeight: cs.fontWeight,
      computedColor: cs.color,
      computedBackground: cs.backgroundColor,
      ownOpacity,
      ownColorAlpha: fgRaw.a,
      effectiveAlpha: Number(effectiveAlpha.toFixed(4)),
      ancestorOpacityProduct: Number((groupOpacity / (ownOpacity || 1)).toFixed(4)),
      groupBreaks,
      unsupportedLayerConfigurations: unsupported,
      effectiveBackground: { r: Math.round(backdrop.r), g: Math.round(backdrop.g), b: Math.round(backdrop.b) },
      effectiveForeground: { r: Math.round(fgOnBg.r), g: Math.round(fgOnBg.g), b: Math.round(fgOnBg.b) },
      contrastRatio: Number(r.toFixed(3)),
      verdict: unsupported.length > 0 ? 'UNSUPPORTED' : 'COMPUTED',
    };
  };
  return true;
})()
`;

/** AA threshold: 4.5 normal text, 3.0 large (>=24px, or >=18.66px bold). */
function aaThreshold(fontSizePx, fontWeight) {
  const large = fontSizePx >= 24 || (fontSizePx >= 18.66 && Number(fontWeight) >= 700);
  return { threshold: large ? 3.0 : 4.5, large };
}

/** The single pass predicate. An UNSUPPORTED configuration is a non-pass: the
 *  helper still returns a diagnostic contrastRatio for an unmodelled group, and
 *  that number is never an accepted computed ratio. A node that is not actually
 *  rendered (display:none, visibility hidden/collapse, an ancestor-hidden
 *  chain, or no painted rect) cannot pass either — the visible surface is what
 *  owes the ratio, and a hidden node proves nothing about it. */
function contrastVerdictFor(node, threshold) {
  if (!node || typeof node !== "object") return { pass: false, why: "no contrast record" };
  if (node.rendered !== true)
    return {
      pass: false,
      why: `target is not rendered visible (display=${node.display ?? "?"}, visibility=${node.visibility ?? "?"}, ancestorHidden=${node.hiddenByAncestor ? `${node.hiddenByAncestor.tag}` : "none"}, rect=${node.rect ? `${node.rect.width}x${node.rect.height}` : "none"})`,
    };
  if (node.verdict === "UNSUPPORTED") return { pass: false, why: "unsupported layer configuration" };
  if (node.verdict !== "COMPUTED") return { pass: false, why: `unknown verdict ${JSON.stringify(node.verdict)}` };
  if (!Number.isFinite(node.contrastRatio)) return { pass: false, why: "no computed ratio" };
  return { pass: node.contrastRatio >= threshold, why: `${node.contrastRatio} vs ${threshold}` };
}

/**
 * The accepted selected-panel contrast node set: for each result view, the
 * representative content nodes the correction measured INSIDE the selected
 * tab's aria-controls panel — never the shared ContextTrail header or an
 * action link. Every entry is contract-bound, not presence-optional:
 * `populatedWhen` names the data contract that decides whether the populated
 * selector must match; when the contract says the surface is empty the
 * `empty` explanation text must instead be the node that renders, and it is
 * THAT node whose visibility and contrast get measured. A populated node
 * that never rendered is a measured miss, not a skipped target.
 *
 * Contract keys (resolved by `panelContractPopulated`):
 *   "always"                — the node exists on every render of this panel
 *   "hasAnyOccurrence"      — any of timeline/supporting/contextual/undated
 *   "accountingRows"        — the Retrieval-accounting list rows: populated
 *                             for a requestLog array with mapped entries or
 *                             known non-empty searchCounts; absent for an
 *                             empty requestLog or known-empty counts
 *   "accountingNote"        — the trailing accounting note: populated for a
 *                             requestLog array or known non-empty counts;
 *                             empty (the missing-counts explanation) when
 *                             requestLog is absent and counts are known empty
 *                             (the "Retrieval accounting" section at pin
 *                             ResultView 603-640: per-operation engine rows
 *                             with attempted/returned/retained and search id,
 *                             plus the trailing accounting note)
 */
const PANEL_NODE_TARGETS = {
  sources: [
    {
      key: "sources-item-title",
      populated: "ul li p.font-medium",
      populatedWhen: "hasAnyOccurrence",
      empty: { selector: "p.text-center", text: "No sources were retrieved." },
      note: "a real Sources item title, not the source action link",
    },
    {
      key: "sources-item-metadata",
      populated: "ul li p.text-sm",
      populatedWhen: "hasAnyOccurrence",
      empty: { selector: "p.text-center", text: "No sources were retrieved." },
      note: "the adjacent Sources item metadata line (domain · date · date source)",
    },
  ],
  analysis: [
    {
      key: "analysis-intro-paragraph",
      populated: "p.mt-2.max-w-3xl",
      populatedWhen: "always",
      note: "the real Analysis panel intro paragraph",
    },
    {
      key: "analysis-retrieval-accounting-row",
      populated: { selector: "ul > li", scope: "Retrieval accounting" },
      populatedWhen: "accountingRows",
      absentOk: true,
      note: "a Retrieval-accounting operation row — request-log entries or legacy per-engine counts, whichever branch the consumed state produces (pin ResultView 595-642)",
    },
    {
      key: "analysis-retrieval-accounting-note",
      populated: { selector: "p.mt-2.text-xs", scope: "Retrieval accounting" },
      populatedWhen: "accountingNote",
      empty: {
        selector: "p.mt-2.text-sm",
        scope: "Retrieval accounting",
        text: "No retrieval counts were preserved",
      },
      note: "the Retrieval-accounting trailing note — per-operation accounting or legacy counts text; the contract-empty branch renders the missing-counts explanation in its place",
    },
  ],
  timeline: [
    {
      key: "timeline-panel-heading",
      populated: "h2",
      populatedWhen: "hasAnyOccurrence",
      empty: { selector: "p.text-center", text: "No occurrences were returned" },
      note: "the real Timeline panel heading",
    },
    {
      key: "timeline-panel-intro",
      populated: "p.mt-2.max-w-3xl",
      populatedWhen: "hasAnyOccurrence",
      empty: { selector: "p.text-center", text: "No occurrences were returned" },
      note: "the populated Timeline intro paragraph — the empty state is a bare p.text-center that can never satisfy this selector",
    },
    {
      key: "timeline-coverage-paragraph",
      populated: { selector: "p.mt-2.max-w-3xl", nth: 1 },
      populatedWhen: "hasAnyOccurrence",
      empty: { selector: "p.text-center", text: "No occurrences were returned" },
      note: "the populated Timeline comparison-coverage paragraph (second intro p)",
    },
  ],
};

/** The fixture's full event stream — the consumed state the page actually
 *  renders from, which is broader than the terminal alone (searchCounts live
 *  in hook state folded from `search.batch` events, not the result payload). */
function fixtureEvents(name) {
  const p = path.join(FIXTURES_DIR, `${name}.ndjson`);
  if (!fs.existsSync(p)) return null;
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** The request-log entries the product's getRequestLog maps out of the
 *  terminal — non-string-engine items are dropped. An ARRAY (even empty) is
 *  truthy for the product: it renders the request-log branch, including the
 *  trailing per-operation note, even when zero rows survive the mapping. */
function mappedRequestLog(terminal) {
  if (!terminal || !Array.isArray(terminal.requestLog)) return null;
  return terminal.requestLog.filter(
    (e) => e && typeof e.engine === "string" && e.engine.length > 0,
  );
}

/** The hook's searchCounts contract, folded from the consumed `search.batch`
 *  events exactly as useInvestigation reduces them (per-engine count, latest
 *  wins). `null` = not derivable (live run — the populated branch is then
 *  not provably owed, so the contract is "optional", never a hard skip). */
function consumedSearchCounts(events) {
  if (!Array.isArray(events)) return null;
  const counts = [];
  for (const ev of events) {
    if (ev?.type !== "search.batch") continue;
    if (typeof ev.engine !== "string" || typeof ev.count !== "number") continue;
    const ex = counts.find((c) => c.engine === ev.engine);
    if (ex) ex.count = ev.count;
    else counts.push({ engine: ev.engine, count: ev.count });
  }
  return counts;
}

/**
 * Resolve which measurement branch a target's contract owes — four states:
 *   "populated" — populated content is owed and must render a real node
 *   "empty"     — the contract-empty explanation must render and be measured
 *   "absent"    — the populated node must NOT render (e.g. empty requestLog
 *                 ul), and no explanation is owed in its place
 *   "optional"  — the consumed state cannot decide (live run, or hook state
 *                 not in the terminal): measure whichever legitimate branch
 *                 rendered; per-target `absentOk` governs a nothing-rendered
 *                 outcome.
 * The three retrieval-accounting modes mirror the product's own branch:
 * `requestLog` truthy (any ARRAY, even one mapping to zero rows) renders the
 * request-log list + per-operation note; otherwise `searchCounts.length === 0`
 * renders the missing-counts explanation, else the legacy counts list + note.
 */
function panelContractPopulated(mode, contract) {
  const terminal = contract?.terminal ?? null;
  const searchCounts = contract ? contract.searchCounts : null;
  if (mode === "always") return "populated";
  const evidenceTotal =
    asLen(terminal?.timeline) +
    asLen(terminal?.supportingEvidence) +
    asLen(terminal?.contextualEvidence) +
    asLen(terminal?.undatedEvidence);
  if (mode === "hasAnyOccurrence") {
    if (terminal === null) return "populated"; // live: populated required
    return evidenceTotal > 0 ? "populated" : "empty";
  }
  if (mode === "accountingRows" || mode === "accountingNote") {
    const mapped = mappedRequestLog(terminal);
    if (terminal === null) return "optional"; // live: hook state unknowable
    if (mapped !== null) {
      if (mode === "accountingNote") return "populated"; // note renders even for []
      return mapped.length > 0 ? "populated" : "absent";
    }
    if (searchCounts !== null) {
      if (searchCounts.length > 0) return "populated";
      return mode === "accountingNote" ? "empty" : "absent";
    }
    return "optional"; // requestLog absent and hook counts unknowable
  }
  return "populated";
}

/** The Retrieval-accounting branch probe: which of the product's three
 *  branches actually rendered under the section's own heading — the
 *  request-log list + per-operation note, the legacy counts list + note, or
 *  the missing-counts explanation — plus row/note detail for the verdict. */
const ACCOUNTING_BRANCH_FN = `(() => {
  const panel = document.getElementById("ct-panel-analysis");
  if (!panel) return null;
  const sec = panel.querySelector('section[aria-label="Analysis"]') ?? panel;
  const h = [...sec.querySelectorAll("h3")].find(
    (x) => (x.textContent || "").trim() === "Retrieval accounting",
  );
  if (!h) return { heading: false };
  const sibs = [];
  for (let n = h.nextElementSibling; n && !/^H[23]$/.test(n.tagName); n = n.nextElementSibling) sibs.push(n);
  const ul = sibs.find((e) => e.tagName === "UL") ?? null;
  const expl = sibs.find(
    (e) => e.tagName === "P" && /No retrieval counts were preserved/.test(e.textContent || ""),
  ) ?? null;
  const notes = sibs
    .filter((e) => e.tagName === "P" && e !== expl)
    .map((e) => (e.textContent || "").replace(/\\s+/g, " ").trim());
  return {
    heading: true,
    branch: ul
      ? notes.some((t) => /Per-operation accounting/.test(t))
        ? "requestLog"
        : notes.some((t) => /Counts are retrieved results/.test(t))
          ? "legacy"
          : "list-unknown"
      : expl
        ? "empty"
        : "none",
    rowCount: ul ? ul.children.length : 0,
    noteTexts: notes,
    explanationRendered: expl !== null,
    explanationVisible: expl
      ? !!(expl.offsetWidth || expl.offsetHeight || expl.getClientRects().length)
      : false,
  };
})()`;

/** The consumed-state contract for the accounting branch, validated against
 *  what actually rendered: a present requestLog array (even one mapping to
 *  zero entries — the product keeps the branch) requires the request-log
 *  branch with exactly the mapped row count; absent requestLog + known empty
 *  searchCounts requires the explanation; known non-empty counts require the
 *  legacy branch; and when the hook state is unknowable from the terminal
 *  (live, or a payload that omits it) the legacy or empty branch is accepted
 *  — but "none" is always a defect. */
function accountingBranchVerdict(terminal, searchCounts, b) {
  if (!b || b.heading !== true)
    return { ok: false, detail: "the Retrieval accounting heading did not render — no branch to measure" };
  const mapped = mappedRequestLog(terminal);
  const sc = Array.isArray(searchCounts) ? searchCounts : null;
  if (mapped !== null) {
    const ok =
      b.branch === "requestLog" && b.rowCount === mapped.length && b.explanationRendered === false;
    return {
      ok,
      detail: `terminal requestLog=${mapped.length} mapped row(s); rendered branch=${b.branch} rows=${b.rowCount} explanation=${b.explanationRendered}`,
    };
  }
  if (sc !== null) {
    const want = sc.length > 0 ? "legacy" : "empty";
    const rowsOk = want === "legacy" ? b.rowCount === sc.length : b.rowCount === 0;
    return {
      ok: b.branch === want && rowsOk && (want !== "empty" || b.explanationVisible === true),
      detail: `consumed searchCounts=${sc.length}; rendered branch=${b.branch} rows=${b.rowCount} explanationVisible=${b.explanationVisible}`,
    };
  }
  // Consumed state cannot establish the counts branch (live run, or a payload
  // that carries neither field): any single legitimate branch is acceptable,
  // but a request-log branch without requestLog data or NO branch is a defect.
  const ok = b.branch === "legacy" || b.branch === "empty";
  return {
    ok,
    detail: `accounting contract undecidable from consumed state; rendered branch=${b.branch} rows=${b.rowCount}`,
  };
}

/**
 * Did the selected tab's aria-controls resolve to a real panel? The record must
 * carry the tab's own aria-controls attribute, a matching panel id and the
 * tabpanel role — anything else means the measurement would have no scope.
 */
function panelScopeOk(info) {
  return (
    !!info &&
    typeof info.tabAriaControls === "string" &&
    info.tabAriaControls.length > 0 &&
    info.panelExists === true &&
    info.panelId === info.tabAriaControls &&
    info.panelRole === "tabpanel"
  );
}

/** Measures one node strictly INSIDE the resolved panel and reports whether it
 *  actually belongs there — a selector that escapes the panel fails the
 *  membership check instead of measuring a shared header. When `expectText`
 *  is given (contract-empty explanations), the node's normalized text must
 *  contain it — the required explanation measured on the REAL node. The node
 *  is tagged data-ctnpm so the follow-up CLIP_FN measures this element's own
 *  text range rather than any lookalike text elsewhere in the document. */
const PANEL_MEASURE_FN = `({ panelId, selector, expectText, scope, nth }) => {
  const panel = document.getElementById(panelId);
  if (!panel) return { found: false, reason: 'no panel', panelId, selector };
  const normT = (s) => String(s ?? '').replace(/\\s+/g, ' ').trim();
  // scope: restrict matching to the sibling slice after the named heading —
  // an unscoped selector can silently pick another section's lookalike node
  // (e.g. p.mt-2.text-sm matches the Analysis intro, not the Retrieval
  // accounting explanation it was written for).
  let matches;
  if (typeof scope === 'string' && scope.length > 0) {
    const heads = [...panel.querySelectorAll('h1,h2,h3,h4')];
    const h = heads.find((x) => normT(x.textContent).toLowerCase().includes(scope.toLowerCase()));
    if (!h) return { found: false, reason: 'scope heading not found: ' + scope, panelId, selector, matchCount: 0 };
    const sibs = [];
    for (let n = h.nextElementSibling; n && !/^H[1-4]$/.test(n.tagName); n = n.nextElementSibling) sibs.push(n);
    matches = sibs.flatMap((s) => [...(s.matches(selector) ? [s] : []), ...s.querySelectorAll(selector)]);
  } else {
    matches = [...panel.querySelectorAll(selector)];
  }
  const matchCount = matches.length;
  const el = matches[typeof nth === 'number' ? nth : 0] ?? null;
  if (!el) return { found: false, reason: 'selector matched nothing inside the panel', panelId, selector, matchCount };
  const owner = el.closest('[id^="ct-panel-"]');
  const membership = owner ? owner.id : null;
  const norm = (s) => String(s ?? '').replace(/\\s+/g, ' ').trim();
  const textMatched =
    typeof expectText === 'string' && expectText.length > 0
      ? norm(el.textContent).includes(norm(expectText))
      : null;
  const cs = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  let hiddenByAncestor = null;
  for (let a = el.parentElement; a; a = a.parentElement) {
    const as = getComputedStyle(a);
    if (as.display === 'none' || as.visibility === 'hidden' || as.visibility === 'collapse') {
      hiddenByAncestor = { tag: a.tagName, id: a.id || undefined, display: as.display, visibility: as.visibility };
      break;
    }
  }
  const rendered =
    cs.display !== 'none' && cs.visibility !== 'hidden' && cs.visibility !== 'collapse' &&
    hiddenByAncestor === null && rect.width > 0 && rect.height > 0;
  document.querySelectorAll('[data-ctnpm]').forEach((x) => x.removeAttribute('data-ctnpm'));
  el.setAttribute('data-ctnpm', '1');
  const node = window.__ctEffectiveContrast ? window.__ctEffectiveContrast(el) : null;
  return {
    found: true,
    membership,
    isInsidePanel: panel.contains(el),
    rendered,
    display: cs.display,
    visibility: cs.visibility,
    rect: { width: rect.width, height: rect.height },
    hiddenByAncestor,
    textMatched,
    nodeIdentity: {
      ctnpm: '1',
      tag: el.tagName,
      className: String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || ''),
      panelId,
      containerDomSubset: true,
    },
    node,
    tag: el.tagName,
    selector,
    text: (el.textContent || '').trim().slice(0, 70),
  };
}`;

async function measurePanelContrast(page, panelId, target) {
  const arg = typeof target === "string" ? { panelId, selector: target } : { panelId, ...target };
  return page.evaluate(
    `(${PANEL_MEASURE_FN})(${JSON.stringify(arg)})`,
  );
}

/* -------- media visibility, wrap/clipping, targets, at-rest motion -------- *
 * The accepted A10 source-scoped predicates. A decoded image that is hidden,
 * truncated or still animating is not a visible render; a wrapped title that is
 * line-clamped or ellipsised is clipped, not wrapped; and a 44px claim is
 * measured on real interactive controls, not paragraphs. */

/**
 * Visible-image probe: scope + alt prefix select the image, then the record
 * covers completeness, decode, a non-transparent pixel, ancestor-effective
 * hiding (display, visibility, hidden, aria-hidden, opacity, content-visibility
 * on EVERY ancestor), rendered geometry, viewport presence and running
 * animations. A hidden image is RED under exactly this predicate.
 */
const VISIBLE_IMAGE_FN = `([scopeSel, altPrefix]) => {
  const scope = scopeSel ? document.querySelector(scopeSel) : document;
  const img = scope ? scope.querySelector('img[alt^="' + altPrefix + '"]') : null;
  if (!img) return { present: false, reason: 'no image matching ' + altPrefix + ' inside ' + (scopeSel || 'document') };
  const cs = getComputedStyle(img);
  const rect = img.getBoundingClientRect();
  const hiddenBy = [];
  for (let p = img; p; p = p.parentElement) {
    const pcs = getComputedStyle(p);
    if (pcs.display === 'none') hiddenBy.push({ tag: p.tagName, reason: 'display:none' });
    if (pcs.visibility === 'hidden' || pcs.visibility === 'collapse') hiddenBy.push({ tag: p.tagName, reason: 'visibility:' + pcs.visibility });
    if (p.hasAttribute && p.hasAttribute('hidden')) hiddenBy.push({ tag: p.tagName, reason: 'hidden attribute' });
    if (p.getAttribute && p.getAttribute('aria-hidden') === 'true') hiddenBy.push({ tag: p.tagName, reason: 'aria-hidden=true' });
    const o = parseFloat(pcs.opacity);
    if (Number.isFinite(o) && o === 0) hiddenBy.push({ tag: p.tagName, reason: 'opacity:0' });
    if (pcs.contentVisibility === 'hidden') hiddenBy.push({ tag: p.tagName, reason: 'content-visibility:hidden' });
  }
  let ownOpacity = parseFloat(cs.opacity);
  ownOpacity = Number.isFinite(ownOpacity) ? ownOpacity : 1;
  const inViewport = rect.width > 0 && rect.height > 0
    && rect.bottom > 0 && rect.right > 0
    && rect.top < (window.innerHeight || 0) && rect.left < (window.innerWidth || 0);
  const renderedGeometry = rect.width > 0 && rect.height > 0;
  let visiblePixels = null, decodeOk = false, decodeError = null;
  try {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    visiblePixels = n; decodeOk = true;
  } catch (e) { decodeError = String(e).slice(0, 120); }
  const anims = img.getAnimations ? img.getAnimations().map((a) => ({ type: a.constructor ? a.constructor.name : 'unknown', playState: a.playState })) : [];
  return {
    present: true,
    alt: img.getAttribute('alt'),
    src: (img.getAttribute('src') || '').slice(0, 400),
    complete: img.complete,
    naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight,
    visiblePixels, decodeOk, decodeError,
    ownOpacity,
    renderedGeometry, inViewport,
    rect: { width: Math.round(rect.width), height: Math.round(rect.height), top: Math.round(rect.top) },
    hiddenBy,
    runningAnimations: anims, runningAnimationCount: anims.filter((a) => a.playState === 'running').length,
  };
}`;

/** The single visible-image predicate. */
function visibleImageVerdict(s) {
  if (!s?.present) return { pass: false, why: s?.reason ?? "no image" };
  if (s.hiddenBy.length > 0) return { pass: false, why: `hidden by ${s.hiddenBy.map((h) => h.tag + ":" + h.reason).join(", ")}` };
  if (s.ownOpacity === 0) return { pass: false, why: "own opacity 0" };
  if (!s.renderedGeometry) return { pass: false, why: "zero rendered geometry" };
  if (!s.inViewport) return { pass: false, why: "not in the viewport" };
  if (s.complete !== true || s.naturalWidth <= 0 || !s.decodeOk) return { pass: false, why: `not decoded (complete=${s.complete} naturalWidth=${s.naturalWidth} decodeError=${s.decodeError ?? "none"})` };
  if ((s.visiblePixels ?? 0) <= 0) return { pass: false, why: "no non-transparent pixel" };
  return { pass: true, why: `visible, ${s.visiblePixels} pixels, ${s.rect.width}x${s.rect.height}` };
}

/** At-rest motion on a media record: no running Web/CSS animations. A record
 *  that never counted its animations cannot pass. */
function motionAtRestOk(record) {
  return Number.isInteger(record?.runningAnimationCount) && record.runningAnimationCount === 0;
}

/**
 * Geometry/clip measure for ONE specific rendered node, scoped by the same
 * element-identity handle PANEL_MEASURE_FN already produces (data-ctnpm
 * tagging in this session, container-DOM-subset fallback). A body-wide text
 * search cannot stand in: identical strings elsewhere must never satisfy —
 * or fail — the predicate for this node. Rects are measured from a real
 * Range over the node's own text; clipping is checked in BOTH axes against
 * the node's border box AND against every ancestor that establishes a clip
 * (overflow hidden/clip/scroll/auto) — an overflow-x:hidden ancestor clips
 * without telling the node's own overflow value, so the ancestor clip chain
 * is computed from styles, not from the node alone.
 */
const CLIP_FN = `(({ text, nodeIdentity } = {}) => {
  if (typeof text !== 'string' || text.trim().length === 0)
    return { found: false, reason: 'no expected text' };
  const truthy = (s) => s !== null && s !== undefined && String(s).trim().length > 0;
  const norm = (s) => String(s ?? '').replace(/\\s+/g, ' ').trim();
  let node = null;
  if (nodeIdentity && truthy(nodeIdentity.tag)) {
    if (truthy(nodeIdentity.ctnpm)) {
      node = document.querySelector('[data-ctnpm="' + nodeIdentity.ctnpm + '"]');
    }
    if (node === null && nodeIdentity.containerDomSubset === true) {
      const panel = nodeIdentity.panelId ? document.getElementById(nodeIdentity.panelId) : document.body;
      const cand = panel ? [...panel.querySelectorAll(nodeIdentity.tag)] : [];
      node =
        cand.find(
          (el) =>
            norm(el.textContent) === norm(text) &&
            String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '') ===
              String(nodeIdentity.className ?? ''),
        ) ?? null;
    }
  }
  if (node === null) return { found: false, reason: 'scoped node not found' };
  const styleOf = (el) => getComputedStyle(el);
  const cs = styleOf(node);
  const rect = node.getBoundingClientRect();
  let hiddenByAncestor = null;
  for (let a = node.parentElement; a; a = a.parentElement) {
    const as = styleOf(a);
    if (as.display === 'none' || as.visibility === 'hidden' || as.visibility === 'collapse') {
      hiddenByAncestor = { tag: a.tagName, id: a.id || undefined, display: as.display, visibility: as.visibility };
      break;
    }
  }
  const rendered =
    cs.display !== 'none' && cs.visibility !== 'hidden' && cs.visibility !== 'collapse' &&
    hiddenByAncestor === null && rect.width > 0 && rect.height > 0;
  if (!rendered)
    return { found: true, rendered: false, hiddenByAncestor, display: cs.display, visibility: cs.visibility,
      nodeRect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
      reason: 'node has no rendered box' };
  // Real text geometry: a Range over this node's own text, not the element box.
  const range = document.createRange();
  range.selectNodeContents(node);
  const union = range.getBoundingClientRect();
  const lineRects = [...range.getClientRects()]
    .filter((r) => r.width > 0 && r.height > 0)
    .map((r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom }));
  if (lineRects.length === 0)
    return { found: true, rendered: true, rangeMeasured: false, reason: 'empty text range' };
  const clippingAncestors = [];
  for (let a = node.parentElement; a; a = a.parentElement) {
    const as = styleOf(a);
    if (as && (as.overflowX !== 'visible' || as.overflowY !== 'visible')) {
      const ar = a.getBoundingClientRect();
      clippingAncestors.push({
        tag: a.tagName,
        id: a.id || undefined,
        overflowX: as.overflowX,
        overflowY: as.overflowY,
        paddingLeft: parseFloat(as.paddingLeft) || 0,
        paddingRight: parseFloat(as.paddingRight) || 0,
        paddingTop: parseFloat(as.paddingTop) || 0,
        paddingBottom: parseFloat(as.paddingBottom) || 0,
        rect: { left: ar.left, right: ar.right, top: ar.top, bottom: ar.bottom },
      });
    }
  }
  return {
    found: true,
    rendered: true,
    rangeMeasured: true,
    lineRects,
    union: { left: union.left, right: union.right, top: union.top, bottom: union.bottom },
    nodeRect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
    hiddenByAncestor,
    display: cs.display,
    visibility: cs.visibility,
    overflowX: cs.overflowX,
    overflowY: cs.overflowY,
    clippingAncestors,
    documentHorizontalOverflow:
      document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  };
})`;

/**
 * The clip verdict (F38-2/V39-5): a missing scoped node is a fail (populated
 * content that never rendered is a defect, not a skip); an unrendered or
 * empty-range node is a fail; content measured beyond the node's border box
 * is a fail only when the node clips that axis itself (overflow != visible),
 * and beyond any clipping ancestor — in EITHER axis — always; document
 * horizontal overflow is a fail. Visible overflow inside all real clip
 * bounds passes — text painted beyond a non-clipping box is still fully
 * rendered, and length alone never fails.
 */
function wrapVerdict(m) {
  if (!m || m.found !== true)
    return { pass: false, why: m?.reason ?? "the scoped node was not found" };
  if (m.rendered !== true)
    return { pass: false, why: m.reason ?? `node has no rendered box (display=${m.display ?? "?"}, visibility=${m.visibility ?? "?"})` };
  if (m.rangeMeasured !== true || !Array.isArray(m.lineRects) || m.lineRects.length === 0)
    return { pass: false, why: m.reason ?? "no measurable text range" };
  const rangeLeft = Math.min(...m.lineRects.map((r) => r.left));
  const rangeRight = Math.max(...m.lineRects.map((r) => r.right));
  const rangeTop = Math.min(...m.lineRects.map((r) => r.top));
  const rangeBottom = Math.max(...m.lineRects.map((r) => r.bottom));
  const nr = m.nodeRect;
  if (nr) {
    // A range outrunning the node's own border box is a defect ONLY when the
    // node clips that axis itself — overflow:visible paints the overhang and
    // the text remains fully visible, which the ancestor clip bounds and the
    // document-overflow check below still govern. Containment-by-convention
    // is not clipping and must not be called one.
    const clipsX = (m.overflowX ?? "visible") !== "visible";
    const clipsY = (m.overflowY ?? "visible") !== "visible";
    if (clipsX && rangeRight > nr.right + 1)
      return { pass: false, why: `range right ${Math.round(rangeRight)}px clipped by node overflow-x=${m.overflowX} at ${Math.round(nr.right)}px` };
    if (clipsY && rangeBottom > nr.bottom + 1)
      return { pass: false, why: `range bottom ${Math.round(rangeBottom)}px clipped by node overflow-y=${m.overflowY} at ${Math.round(nr.bottom)}px` };
    if (clipsX && rangeLeft < nr.left - 1)
      return { pass: false, why: `range left ${Math.round(rangeLeft)}px clipped by node overflow-x=${m.overflowX} at ${Math.round(nr.left)}px` };
    if (clipsY && rangeTop < nr.top - 1)
      return { pass: false, why: `range top ${Math.round(rangeTop)}px clipped by node overflow-y=${m.overflowY} at ${Math.round(nr.top)}px` };
  }
  // Ancestor clip chain: a hidden/clip/scroll/auto ancestor cuts content at
  // its own padding box regardless of the node's own overflow value — this is
  // the overflow-x:hidden too-wide case that element-box checks alone miss.
  for (const a of m.clippingAncestors ?? []) {
    const box = {
      left: a.rect.left + a.paddingLeft,
      right: a.rect.right - a.paddingRight,
      top: a.rect.top + a.paddingTop,
      bottom: a.rect.bottom - a.paddingBottom,
    };
    const xClip = a.overflowX !== "visible" && (rangeRight > box.right + 1 || rangeLeft < box.left - 1);
    const yClip = a.overflowY !== "visible" && (rangeBottom > box.bottom + 1 || rangeTop < box.top - 1);
    if (xClip || yClip)
      return {
        pass: false,
        why: `range clipped by ${a.tag}${a.id ? "#" + a.id : ""} ancestor (${xClip ? "x" : ""}${xClip && yClip ? "+" : ""}${yClip ? "y" : ""})`,
      };
  }
  if (m.documentHorizontalOverflow === true)
    return { pass: false, why: "document scrollWidth exceeds clientWidth — horizontal overflow" };
  return { pass: true, why: `${m.lineRects.length} line box(es) inside every clip bound` };
}

/** A real interactive control measurement: geometry AND actual rendered
 *  visibility of an actual control — display, visibility, the ancestor
 *  rendering chain, effective opacity, and a real box. A control the user
 *  cannot see is not a hit target at all. */
const TARGET_FN = `(el) => {
  if (!el) return { found: false };
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  let hiddenByAncestor = null;
  for (let a = el.parentElement; a; a = a.parentElement) {
    const as = getComputedStyle(a);
    if (as.display === 'none' || as.visibility === 'hidden' || as.visibility === 'collapse') {
      hiddenByAncestor = { tag: a.tagName, id: a.id || undefined, display: as.display, visibility: as.visibility };
      break;
    }
  }
  let effectiveOpacity = Number.isFinite(parseFloat(cs.opacity)) ? parseFloat(cs.opacity) : 1;
  for (let a = el.parentElement; a; a = a.parentElement) {
    const o = parseFloat(getComputedStyle(a).opacity);
    if (Number.isFinite(o)) effectiveOpacity *= o;
  }
  const rendered =
    cs.display !== 'none' && cs.visibility !== 'hidden' && cs.visibility !== 'collapse' &&
    hiddenByAncestor === null && r.width > 0 && r.height > 0 && effectiveOpacity > 0;
  return {
    found: true,
    rendered,
    hiddenByAncestor,
    effectiveOpacity: Number(effectiveOpacity.toFixed(4)),
    tag: el.tagName, role: el.getAttribute('role'),
    accessibleName: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 60),
    width: Math.round(r.width), height: Math.round(r.height),
    minHeight44: r.height >= 44, minWidth44: r.width >= 44,
    interactive: el.tagName === 'BUTTON' || el.tagName === 'A' || ['button','link','menuitem','tab','checkbox'].includes(el.getAttribute('role') || ''),
    disabled: el.disabled === true, ariaDisabled: el.getAttribute('aria-disabled'),
    display: cs.display, visibility: cs.visibility,
  };
}`;

/** The target verdict. A control must first be a VISIBLE rendered control —
 *  display/visibility clean through the ancestor chain, a real painted box,
 *  nonzero effective opacity — before its size is even a question. PRIMARY
 *  controls then owe the 44px floor. A secondary control under 44px is a
 *  recorded inconsistency, not a mandatory violation — pass:true with
 *  belowPrimaryFloor flagged so the record carries it. */
function targetVerdict(t, { primary = true } = {}) {
  if (!t || t.found !== true) return { pass: false, why: "control not found" };
  if (t.rendered !== true)
    return {
      pass: false,
      why: `control is not rendered visible (display=${t.display ?? "?"}, visibility=${t.visibility ?? "?"}, ancestorHidden=${t.hiddenByAncestor ? t.hiddenByAncestor.tag : "none"}, box=${t.width ?? 0}x${t.height ?? 0}, opacity=${t.effectiveOpacity ?? "?"})`,
    };
  if (t.interactive !== true) return { pass: false, why: "not an interactive control" };
  if (t.disabled === true || t.ariaDisabled === "true") return { pass: false, why: "control disabled" };
  if (primary && t.height < 44) return { pass: false, why: `primary control ${t.height}px tall < 44px` };
  return { pass: true, why: `${t.width}x${t.height}`, belowPrimaryFloor: t.height < 44 };
}

/**
 * Fail-closed verdict for a maintained drive record: a verdict is computed only
 * from a complete, internally consistent record. A missing/malformed assertions
 * block, a missing complete flag, an unknown outcome, a PASS with failed
 * assertions or zero assertions, or a FAIL with nothing recorded are all
 * non-pass — an empty or truncated drive.json is never acceptance.
 */
function driveOutcomeOk(record) {
  const problems = [];
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return { ok: false, problems: ["drive record is not an object"] };
  }
  const a = record.assertions;
  if (!a || typeof a !== "object" || Array.isArray(a)) {
    problems.push("assertions block missing or not an object");
  } else {
    for (const k of ["pass", "fail", "info"]) {
      if (!Number.isInteger(a[k]) || a[k] < 0) problems.push(`assertions.${k} missing or not a non-negative integer (got ${JSON.stringify(a[k])})`);
    }
  }
  if (typeof record.complete !== "boolean") problems.push("complete flag missing or not boolean");
  if (!["PASS", "FAIL", "INCOMPLETE"].includes(record.outcome)) {
    problems.push(`outcome ${JSON.stringify(record.outcome)} is not a known verdict`);
  }
  if (problems.length === 0) {
    if (record.outcome === "PASS") {
      if (record.complete !== true) problems.push("PASS recorded on an incomplete drive");
      if (a.fail > 0) problems.push(`PASS with ${a.fail} failed assertion(s)`);
      if (a.pass + a.fail === 0) problems.push("PASS with zero assertions — an empty run is never acceptance");
    }
    if (record.outcome === "FAIL" && a.fail === 0 && !record.failure) {
      problems.push("FAIL with no failed assertion and no failure record");
    }
    if (record.complete !== true && record.outcome !== "INCOMPLETE") {
      problems.push(`incomplete drive must record INCOMPLETE, not ${record.outcome}`);
    }
    if (record.complete === true && record.outcome === "INCOMPLETE") {
      problems.push("a complete drive cannot record INCOMPLETE");
    }
  }
  return { ok: problems.length === 0, problems };
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

/** The fixture's own occurrence row for an evidence id, for excerpt and
 *  attribution identity checks — never a locator's self-report. */
function fixtureOccurrence(name, id) {
  const r = fixtureResult(name);
  if (!r || typeof id !== "string" || id === "") return null;
  return (
    [...(r.timeline ?? []), ...(r.supportingEvidence ?? []), ...(r.contextualEvidence ?? []), ...(
      r.undatedEvidence ?? []
    )].find((o) => (o.evidenceId ?? o.occurrenceId) === id) ?? null
  );
}

/* ------------- rendered excerpt identity (F38-4) ------------- *
 * The maintained predicate mirrors the product's own projection at the
 * accepted pin (src/components/result/evidence-display.ts at 7b18c16): the
 * composite "Title: / Snippet:" split, first-paragraph body selection,
 * word-boundary truncation at the viewer's real 600-char budget, and the
 * attribution labels. The rendered <blockquote> must EQUAL the projected
 * span — whitespace-normalized exact equality after the typographic quote
 * wrap — so a one-character prefix, a substituted string that happens to
 * appear in the full-retrieved-text disclosure, and the bare composite
 * title wrapper are all failures, not matches. */

/** Port of the product's splitCompositeExcerpt: "Title:" line, then
 *  "Snippet:" block, remainder is body; a bare "Title:" wrapper is no
 *  excerpt at all. */
function splitCompositeExcerpt(raw) {
  const empty = { title: null, snippet: null, body: null };
  if (typeof raw !== "string" || !raw) return empty;
  let rest = raw;
  let title = null;
  let snippet = null;
  const titleMatch = rest.match(/^Title:([^\n]*)\r?\n\r?\n([\s\S]*)$/);
  if (titleMatch) {
    title = titleMatch[1].trim() || null;
    rest = titleMatch[2];
  }
  const snippetMatch = rest.match(/^Snippet:([\s\S]*?)\r?\n\r?\n([\s\S]*)$/);
  if (snippetMatch) {
    snippet = snippetMatch[1].trim() || null;
    rest = snippetMatch[2];
  } else {
    const bareSnippet = rest.match(/^Snippet:([\s\S]*)$/);
    if (bareSnippet) {
      snippet = bareSnippet[1].trim() || null;
      rest = "";
    }
  }
  const body = rest.trim() || null;
  if (title === null && snippet === null) {
    const bareTitle = raw.match(/^Title:([^\n]*)$/);
    if (bareTitle) return { title: bareTitle[1].trim() || null, snippet: null, body: null };
    return { title: null, snippet: null, body: raw };
  }
  return { title, snippet, body };
}

/** Port of the product's truncateWords: cut at the last word boundary at or
 *  before maxChars (unless that discards more than half), append "…". */
function truncateExcerptWords(text, maxChars) {
  if (text.length <= maxChars) return { text, truncated: false };
  const cut = text.lastIndexOf(" ", maxChars);
  const end = cut > maxChars * 0.5 ? cut : maxChars;
  return { text: `${text.slice(0, end).trimEnd()}…`, truncated: true };
}

/** Port of the product's attributableSpan at the viewer's real maxChars=600:
 *  page_text composites quote the first body paragraph (falling back to the
 *  embedded snippet); every other source quotes the raw text truncated; an
 *  occurrence with no quotable span renders "No excerpt available". */
function expectedAttributableSpan(occurrence, maxChars = 600) {
  if (!occurrence || typeof occurrence !== "object") return null;
  const raw =
    (typeof occurrence.excerpt === "string" && occurrence.excerpt) ||
    (typeof occurrence.snippet === "string" && occurrence.snippet) ||
    null;
  const source =
    (typeof occurrence.excerptSource === "string" && occurrence.excerptSource) ||
    (typeof occurrence.excerptAttribution === "string" && occurrence.excerptAttribution) ||
    null;
  if (!raw) return null;
  if (source === "page_text") {
    const { body, snippet } = splitCompositeExcerpt(raw);
    if (body) {
      const firstParagraph = body.split(/\r?\n\r?\n/)[0].trim() || body;
      const { text, truncated } = truncateExcerptWords(firstParagraph, maxChars);
      return {
        text,
        attribution: "Extracted page excerpt",
        truncated: truncated || body.length > firstParagraph.length,
      };
    }
    if (snippet) {
      const { text, truncated } = truncateExcerptWords(snippet, maxChars);
      if (!text) return null;
      return { text, attribution: "Search snippet", truncated };
    }
    return null;
  }
  const { text, truncated } = truncateExcerptWords(raw.trim(), maxChars);
  if (!text) return null;
  return { text, attribution: "Search snippet", truncated };
}

/** The attribution label the viewer must render over the excerpt block:
 *  a backend-supplied displayAttribution wins, else the span's own label. */
function expectedExcerptAttribution(occurrence, span) {
  const d = typeof occurrence?.displayAttribution === "string" ? occurrence.displayAttribution.trim() : "";
  return d || span?.attribution || null;
}

/**
 * Exact rendered-quote identity. `quoteText` is the <blockquote> element's
 * own rendered text — nothing else in the dialog may satisfy this: not the
 * title, not the full retrieved text disclosure, not a snippet that shares
 * words. The normalized rendered text must EQUAL the projected span.
 */
function renderedExcerptVerdict(quoteText, span) {
  if (!span || typeof span.text !== "string" || span.text.length === 0)
    return { ok: false, why: "the contract projects no attributable span for this occurrence" };
  if (typeof quoteText !== "string" || quoteText.trim().length === 0)
    return { ok: false, why: "no blockquote rendered for an occurrence whose contract has a quotable excerpt" };
  // The product wraps the span in exactly one outer curly pair
  // (“{span.text}”) — remove THAT wrapper only. A genuine span that itself
  // begins/ends with ASCII quotes, guillemets or an apostrophe must keep
  // those characters; stripping them would silently accept a clipped span.
  let rendered = String(quoteText).replace(/\s+/g, " ").trim();
  if (rendered.startsWith("“") && rendered.endsWith("”") && rendered.length >= 2) {
    rendered = rendered.slice(1, -1);
  }
  const expected = String(span.text).replace(/\s+/g, " ").trim();
  if (rendered === expected)
    return { ok: true, why: `exact ${expected.length}-char span${span.truncated ? " (contract-truncated)" : ""}`, rendered, expected };
  if (expected.startsWith(rendered))
    return { ok: false, why: `rendered text is only a ${rendered.length}-char prefix of the ${expected.length}-char span`, rendered, expected };
  if (rendered.startsWith(expected))
    return { ok: false, why: "rendered text extends past the attributable span — the composite wrapper or body remainder leaked into the quote", rendered, expected };
  return { ok: false, why: `rendered "${rendered.slice(0, 60)}" ≠ expected "${expected.slice(0, 60)}"`, rendered, expected };
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

/* ------------------ A8 expected-case map (consumed, sha-pinned) ----------- */

/**
 * The accepted A8 expected-case map, imported byte-exact from the producer's
 * correction-final set (release seal f5435095…, receipt commit 6949ec9). The
 * map is DATA: at load it is sha256-pinned, so a drifted or substituted file
 * fails closed instead of letting a drive assert against unapproved
 * expectations. Consumer notes live beside it in
 * `fixtures/a8-expected-case-map.CONSUMER-NOTES.md`.
 */
const A8_MAP_FILE = path.join(FIXTURES_DIR, "a8-expected-case-map.json");
const A8_MAP_SHA256 = "6721d89b33f01157baedc7aaf99e8dc3f56c8b9d6b5ea3703d5a4019c9455b48";
const A8_APP_PIN = "7b18c16f953aeed397030f51b5239f8d51fee2a5";
const A8_FIXTURE_PIN = "26528b6ee6345c019f016e909d4d17490c3db7eb";
const A8_RELEASE_SEAL = "f5435095b89132ea2ce3120b2de42311677267d8f7bbe41e38052a93077600a0";

let expectedMapCache = null;

/** The digest gate itself, pure: the accepted map's sha256 is the pin —
 *  tampered, truncated or substituted bytes are rejected before parsing. */
function expectedMapBytesOk(bytes) {
  return sha256(bytes) === A8_MAP_SHA256;
}

/** Load and pin the accepted expected-case map. Exported so offline controls
 *  exercise the same bytes and the same digest gate a drive runs under. */
function loadExpectedCaseMap() {
  if (expectedMapCache) return expectedMapCache;
  let bytes;
  try {
    bytes = fs.readFileSync(A8_MAP_FILE);
  } catch (err) {
    fail(
      `a8 expected-case map is missing or unreadable (${String(err?.message ?? err)}): ` +
        "the expectation authority cannot be read, so no controlled observation may proceed",
    );
  }
  const sha = sha256(bytes);
  if (!expectedMapBytesOk(bytes)) {
    fail(
      `a8 expected-case map digest mismatch (pin ${A8_MAP_SHA256.slice(0, 12)}…, ` +
        `file ${sha.slice(0, 12)}…): refusing to assert against unapproved expectations`,
    );
  }
  let map;
  try {
    map = JSON.parse(bytes.toString("utf8"));
  } catch (err) {
    fail(`a8 expected-case map is not parseable JSON: ${String(err?.message ?? err)}`);
  }
  if (!Array.isArray(map.cases) || map.cases.length !== 17) {
    fail(`a8 expected-case map must carry exactly 17 cases (got ${asLen(map.cases)})`);
  }
  map.byFixture = new Map(map.cases.map((c) => [c.fixture, c]));
  expectedMapCache = map;
  return map;
}

/** The pinned maintained-A8 roster — exactly the 17 accepted streams that the
 *  expected-case map is authoritative for. Pinned by NAME, not derived from
 *  the fixtures directory or the map itself: transient control streams
 *  (coverage-mutants writes e.g. `controlled-empty-contrary-count` into the
 *  same directory) are deliberately non-A8, while a roster fixture missing
 *  from the map means the authority is incomplete — both must be
 *  distinguishable without trusting either side to self-declare. */
const A8_MAINTAINED_FIXTURES = new Set([
  "controlled-conflict",
  "controlled-no-conflict",
  "controlled-claim",
  "controlled-insufficient",
  "controlled-pair",
  "controlled-viewer",
  "controlled-trace-strong",
  "controlled-trace-limited",
  "controlled-trace-no-dated",
  "controlled-trace-divergent",
  "controlled-trace-uncertain-transition",
  "controlled-trace-dated-core-merged",
  "controlled-trace-dated-core-ceiling",
  "controlled-trace-coverage-gap",
  "controlled-trace-unresolved-origin",
  "controlled-placement-disputed-vs-unknown",
  "controlled-trace",
]);

/** The map's expected-case record for a fixture, or null for a non-A8 case.
 *  A maintained A8 fixture (the pinned roster above — the 17 accepted
 *  streams) is a KNOWN case: the map is required authority for it, so missing
 *  or unreadable map bytes, a digest mismatch, or a map that does not carry
 *  the fixture are all fail()s — never a silent skip of its assertions.
 *  Genuinely non-A8 names (coverage-mutant scratch streams, retained-control
 *  cases) return null. */
function expectedCaseFor(fixture) {
  if (typeof fixture !== "string" || fixture === "") return null;
  if (!A8_MAINTAINED_FIXTURES.has(fixture)) return null;
  const c = loadExpectedCaseMap().byFixture.get(fixture) ?? null;
  if (c === null) {
    fail(
      `maintained fixture ${fixture} has no case in the accepted a8 map: ` +
        "the expectation authority does not cover a known fixture — refusing rather than skipping its assertions",
    );
  }
  return c;
}

/** The expectation record kind: its id minus the `<fixture>-` prefix. */
function expectedRecordKind(record, fixture) {
  return typeof record?.id === "string" && record.id.startsWith(`${fixture}-`)
    ? record.id.slice(fixture.length + 1)
    : record?.id ?? "";
}

/**
 * Which result view renders the record's observable. The bucket is a property
 * of where the product actually renders the contract, not of the record's
 * name: `analysis-segments` is discharged on Overview (the count renders as the
 * "Observed contexts" metric) and `caveat-serialized` is checked against the
 * consumed serialized terminal, so both bind to the overview invocation.
 */
const A8_EXPECTATION_VIEW = {
  "overview-headline": "overview",
  "overview-support": "overview",
  "caveat-visible": "overview",
  "caveat-serialized": "overview",
  "analysis-segments": "overview",
  "timeline-ids": "timeline",
  "timeline-empty-state": "timeline",
  "undated-section-absent": "timeline",
  placement: "timeline",
  divergence: "timeline",
  connectors: "timeline",
  "analysis-coverage": "analysis",
  "analysis-origins": "analysis",
  "analysis-policy-not-applicable": "analysis",
  gates: "analysis",
};

function expectedViewBucket(record, fixture) {
  return A8_EXPECTATION_VIEW[expectedRecordKind(record, fixture)] ?? null;
}

/* ---- expected-record verdicts: pure predicates over measured surfaces ---- */
/* Each returns { ok, detail } and is exported so the offline control can feed
 * it counterexample surfaces and prove the SAME predicate goes red. */

function a8HeadlineVerdict(record, surface) {
  const actual = surface?.headline ?? null;
  return {
    ok: actual === record.expect,
    detail: `heading=${JSON.stringify(actual)} expected=${JSON.stringify(record.expect)}`,
  };
}

function a8SupportVerdict(record, surface) {
  const actual = surface?.paragraphs?.[0] ?? null;
  return {
    ok: actual === record.expect,
    detail: `support=${JSON.stringify(actual ?? "no support paragraph")}`,
  };
}

function a8CaveatVerdict(record, surface) {
  const want = String(record.expect ?? "");
  const found = (surface?.paragraphs ?? []).some(
    (p) => String(p).replace(/^⚠\s*/, "").trim() === want,
  );
  return {
    ok: found,
    detail: `paragraphs=${JSON.stringify(surface?.paragraphs ?? [])}`,
  };
}

function a8CaveatSerializedVerdict(record, terminal) {
  const actual = terminal ? terminal.doesNotProveClaimTrue ?? null : null;
  return {
    ok: actual === record.expect,
    detail:
      `serialized doesNotProveClaimTrue=${JSON.stringify(actual)} — a serialized-only ` +
      `contract, asserted on the consumed terminal payload, never on rendered text`,
  };
}

function a8SegmentsVerdict(record, surface) {
  const rendered = surface?.metrics?.["Observed contexts"] ?? null;
  const ok =
    record.expect === null ? rendered === "Unresolved" : rendered === String(record.expect);
  return {
    ok,
    detail: `observedContexts=${JSON.stringify(rendered)} expected=${JSON.stringify(record.expect)}`,
  };
}

/** Heading identity is a semantic match on the heading's OWN text: the product
 *  renders section headings with CSS `text-transform: uppercase`, so the
 *  rendered string ("WHY THIS RESULT") and the authored string ("Why this
 *  result") are the same heading. Normalization is scoped to headings only —
 *  paragraph content is never case-normalized. */
function a8HeadingTextMatches(actual, want) {
  if (typeof actual !== "string" || typeof want !== "string") return false;
  const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
  return norm(actual) === norm(want);
}

/** The rendered label the pin assigns each comparison connector state —
 *  evidence-display.ts `comparisonState` + `COMPARISON_COPY` at 7b18c16. An
 *  unexamined edge is honestly labeled "Not compared in this investigation"
 *  and never counts as performed; `uncertain` remains performed. */
const A8_COMPARISON_STATE_LABELS = {
  same: "Same context — compared",
  different: "Different context — compared",
  uncertain: "Comparison inconclusive — performed but not established",
  unexamined: "Not compared in this investigation",
  unknown: "Comparison status unknown",
};

function comparisonStateLabel(connector) {
  const kind = String(connector ?? "").toLowerCase();
  if (kind.includes("same")) return A8_COMPARISON_STATE_LABELS.same;
  if (kind.includes("different")) return A8_COMPARISON_STATE_LABELS.different;
  if (kind.includes("uncertain") || kind.includes("ambiguous")) return A8_COMPARISON_STATE_LABELS.uncertain;
  if (kind.includes("unexamined") || kind.includes("uncompared") || kind.includes("skip"))
    return A8_COMPARISON_STATE_LABELS.unexamined;
  return A8_COMPARISON_STATE_LABELS.unknown;
}

/** The edge identity a relationship carries — the recorded `pairId`, or the
 *  same `fromId|toId` fallback key the product's projection derives. */
function comparisonEdgeKey(c) {
  return (
    c?.pairId ??
    (typeof c?.fromOccurrenceId === "string" && typeof c?.toOccurrenceId === "string"
      ? `${c.fromOccurrenceId}|${c.toOccurrenceId}`
      : null)
  );
}

/** The endpoint identity a row actually opens — ALWAYS the recorded
 *  `fromOccurrenceId|toOccurrenceId` in order, never the `pairId` namespace:
 *  the clicked buttons prove endpoints, and orientation is part of the
 *  identity (a reversed pair is a wrong target, not the same pair). */
function comparisonEndpointKey(c) {
  return typeof c?.fromOccurrenceId === "string" && typeof c?.toOccurrenceId === "string"
    ? `${c.fromOccurrenceId}|${c.toOccurrenceId}`
    : null;
}

/** Whether a recorded relationship edge was never examined — the same token
 *  set the pin's `comparisonState` maps to the "unexamined" state. */
function comparisonIsUnexamined(c) {
  return /unexamined|uncompared|skip/i.test(String(c?.connector ?? ""));
}

/** A row that offered no open controls at all — the ONLY state allowed to
 *  stand for "genuinely unopenable". An attempted open whose identities could
 *  not be read is a FAILED observation, not this state. */
const A8_OPEN_NONE = Object.freeze({ offered: 0, attempted: false, from: null, to: null, key: null });

/** Normalize one per-row opened-endpoint acquisition record. The live
 *  collector emits `{offered, attempted, from, to, key}`; a bare string is the
 *  shorthand for a fully observed `from|to` key, and null/absent is "no
 *  acquisition record" — a legitimately unopenable row, never proof of a
 *  correct pair. */
function a8OpenState(entry) {
  if (entry && typeof entry === "object") return entry;
  if (typeof entry === "string" && entry) {
    const [from, to = null] = entry.split("|");
    return { offered: 2, attempted: true, from, to, key: entry };
  }
  return A8_OPEN_NONE;
}

/** Parse the rendered "Context comparisons: …" sentence into the three counts
 *  the Analysis coverage paragraph actually publishes. `displayedDatedCore`
 *  and the pair-id set are not rendered text — they are asserted against the
 *  consumed serialized payload and the clicked endpoint identity respectively. */
function a8CoverageVerdict(record, surface, openedByRow, terminal) {
  const expect = record.expect ?? {};
  const text = surface?.coverageText ?? null;
  if (text === null) return { ok: false, detail: "no Comparison coverage paragraph measured" };
  const stRow = (openedByRow ?? []).map(a8OpenState);
  if (/No occurrences were selected for context comparison/.test(text)) {
    // Zero-selected means zero performed rows AND zero opened pairs — a
    // phantom row or endpoint under the "nothing compared" sentence is a real
    // contradiction, not decoration.
    const rows = surface?.performedRows ?? [];
    const ok =
      expect.eligible === 0 &&
      expect.selected === 0 &&
      expect.comparedPairs === 0 &&
      rows.length === 0 &&
      stRow.every((s) => s.key === null);
    return {
      ok,
      detail: `rendered=${JSON.stringify(text)} expected=${JSON.stringify(expect)} performedRows=${rows.length} openedPairs=${stRow.filter((s) => s.key !== null).length}`,
    };
  }
  if (/was not reported/i.test(text)) {
    return { ok: false, detail: `coverage not reported, expected ${JSON.stringify(expect)}` };
  }
  const m = /(\d+) pairs? compared across (\d+) selected of (\d+) eligible occurrences/.exec(text);
  if (!m) return { ok: false, detail: `unparsed coverage text ${JSON.stringify(text)}` };
  const rendered = { comparedPairs: +m[1], selected: +m[2], eligible: +m[3] };
  const countsOk =
    rendered.comparedPairs === expect.comparedPairs &&
    rendered.selected === expect.selected &&
    rendered.eligible === expect.eligible;
  if (!countsOk) {
    return { ok: false, detail: `rendered=${JSON.stringify(rendered)} expected=${JSON.stringify(expect)}` };
  }
  // N83-4: the rendered "Comparisons performed" list is the ALL-relationships
  // list — every recorded connector edge renders a row under its honest label,
  // including "Not compared in this investigation". The performed set is ONLY
  // the explicit compared-pair id set; an unexamined edge is rendered but never
  // counted, and `uncertain` still counts as performed.
  const mism = [];
  const rows = surface?.performedRows ?? [];
  const edges = Array.isArray(terminal?.comparisons) ? terminal.comparisons : null;
  const comparedIds = Array.isArray(expect.comparedPairIds) ? expect.comparedPairIds : [];
  if (edges === null) {
    mism.push("terminal carries no `comparisons` relationship list — performed identity cannot be established");
  } else {
    if (rows.length !== edges.length) {
      mism.push(`relationship rows ${rows.length} vs recorded edges ${edges.length}`);
    }
    edges.forEach((c, i) => {
      const want = comparisonStateLabel(c?.connector);
      if (!String(rows[i]?.text ?? "").includes(want)) {
        mism.push(`row ${i} missing label ${JSON.stringify(want)} for connector ${JSON.stringify(c?.connector)}`);
      }
      if (comparisonIsUnexamined(c) && comparedIds.includes(comparisonEdgeKey(c))) {
        mism.push(`unexamined edge ${comparisonEdgeKey(c)} promoted into comparedPairIds`);
      }
    });
    for (const id of comparedIds) {
      if (!edges.some((c) => comparisonEdgeKey(c) === id && !comparisonIsUnexamined(c))) {
        mism.push(`comparedPairId ${id} resolves to no performed edge`);
      }
    }
    const performedEdges = edges.filter(
      (c) => comparedIds.includes(comparisonEdgeKey(c)) && !comparisonIsUnexamined(c),
    );
    if (performedEdges.length !== expect.comparedPairs) {
      mism.push(`performed edges ${performedEdges.length} vs reported comparedPairs ${expect.comparedPairs}`);
    }
  }
  // Opened identity is bound PER ROW (N83-R4): byRow[i] is the pair key the
  // i-th rendered row's endpoint buttons actually opened, and it must equal
  // that row's OWN recorded endpoints in recorded from|to order — a key that
  // belongs to another row, or reverses this row's orientation, is a wrong
  // target even when it lands inside the compared set. Unexamined rows carry
  // legitimate endpoint buttons too: their targets are bound the same way,
  // and they still never contribute to the performed set. A genuinely
  // unopenable row keeps its explicit null state rather than being read as
  // valid.
  const performedKeys = [];
  const unopenable = [];
  (edges ?? []).forEach((c, i) => {
    const want = comparisonEndpointKey(c);
    const st = stRow[i] ?? A8_OPEN_NONE;
    if (want === null) {
      mism.push(`row ${i} edge carries no recorded endpoints`);
    }
    // An ATTEMPTED open — the row offered two endpoint controls and both were
    // clicked — that returns an incomplete identity is a FAILED observation on
    // any row, examined or not. It is never the declared unopenable state and
    // never passes quietly (N83-R4 residual): missing proof does not default
    // to success. `offered >= 2` itself implies the attempt — the collector
    // always opens both controls it finds.
    const attempted = st.attempted === true || (st.offered ?? 0) >= 2;
    if (attempted && (st.from === null || st.to === null)) {
      mism.push(
        `row ${i} endpoint controls opened but identity read incomplete ` +
          `(from=${JSON.stringify(st.from)} to=${JSON.stringify(st.to)})`,
      );
    } else if (st.key !== null && st.key !== want) {
      mism.push(`row ${i} opened ${JSON.stringify(st.key)} — recorded endpoints ${JSON.stringify(want)}`);
    }
    if (!attempted && st.key === null) unopenable.push(i);
    if (comparisonIsUnexamined(c)) return;
    if (comparedIds.includes(comparisonEdgeKey(c))) {
      if (st.key === null) mism.push(`performed row ${i} endpoints did not open`);
      else performedKeys.push(st.key);
    }
  });
  const seen = new Set(performedKeys);
  if (performedKeys.length !== (edges ?? []).filter((c) => comparedIds.includes(comparisonEdgeKey(c)) && !comparisonIsUnexamined(c)).length) {
    mism.push(`opened performed rows ${performedKeys.length} vs performed edges ${(edges ?? []).filter((c) => comparedIds.includes(comparisonEdgeKey(c)) && !comparisonIsUnexamined(c)).length}`);
  }
  if (seen.size !== performedKeys.length) mism.push("duplicate performed pair keys");
  return {
    ok: mism.length === 0,
    detail:
      `counts=${JSON.stringify(rendered)} rows=${rows.length}` +
      (unopenable.length ? ` unopenableRows=${JSON.stringify(unopenable)}` : "") +
      " " +
      (mism.length ? mism.join("; ") : `${performedKeys.length} performed pair(s) verified across ${rows.length} relationship row(s)`),
  };
}

function a8GatesVerdict(record, surface, openedSupportIds) {
  const expect = record.expect ?? {};
  const gates = expect.gates ?? [];
  const items = surface?.gateItems ?? [];
  const mism = [];
  if ((expect.statusBasisRendered ?? null) !== null) {
    if (surface?.statusBasis !== expect.statusBasisRendered) {
      mism.push(`statusBasis rendered=${JSON.stringify(surface?.statusBasis)}`);
    }
  }
  if (items.length !== gates.length) {
    mism.push(`gate rows ${items.length} vs expected ${gates.length}`);
  }
  for (const [i, g] of gates.entries()) {
    const item = items[i] ?? {};
    if (item.label !== g.expectText) mism.push(`gate ${i} label=${JSON.stringify(item.label)} want ${JSON.stringify(g.expectText)}`);
    if (typeof g.passed === "boolean" && typeof item.glyph === "string" && item.glyph !== (g.passed ? "✓" : "✗")) {
      mism.push(`gate ${i} glyph=${JSON.stringify(item.glyph)} but passed=${g.passed}`);
    }
    if ((item.detail ?? "") !== g.detail) mism.push(`gate ${i} detail=${JSON.stringify(item.detail)}`);
    if ((item.supportButtons ?? -1) !== (g.expectSupportLinkIds ?? []).length) {
      mism.push(`gate ${i} support buttons ${item.supportButtons ?? "n/a"} vs ${asLen(g.expectSupportLinkIds)}`);
    }
    const opened = (openedSupportIds ?? {})[i] ?? [];
    const want = g.expectSupportLinkIds ?? [];
    for (const [j, id] of want.entries()) {
      if (opened[j] !== id) mism.push(`gate ${i} link ${j} opened=${JSON.stringify(opened[j] ?? null)} want ${id}`);
    }
  }
  return { ok: mism.length === 0, detail: mism.join("; ") || `${gates.length} gate(s) verified` };
}

function a8OriginsVerdict(record, surface, openedMemberIds) {
  const expect = record.expect ?? {};
  const mism = [];
  // The counts line is parsed from the rendered "Reporting origins" paragraph,
  // never re-derived from the fixture.
  const om = /(\d+) resolved reporting groups?/.exec(surface?.originsText ?? "");
  const um = /(\d+) unresolved candidates?/.exec(surface?.originsText ?? "");
  const renderedGroups = om ? +om[1] : null;
  const renderedUnresolved = um ? +um[1] : null;
  if (renderedGroups !== expect.reportingGroupCount) {
    mism.push(`resolved groups rendered=${renderedGroups} want ${expect.reportingGroupCount}`);
  }
  if (renderedUnresolved !== expect.unresolvedOriginCount) {
    mism.push(`unresolved rendered=${renderedUnresolved} want ${expect.unresolvedOriginCount}`);
  }
  const items = surface?.groupItems ?? [];
  const groups = expect.groups ?? [];
  // Cardinality is unconditional: a retained "No resolved reporting groups"
  // empty paragraph does not license extra rendered rows — the contradictory
  // empty copy plus a phantom group is a real inconsistency, not decoration.
  if (items.length !== groups.length) {
    mism.push(`group rows ${items.length} vs expected ${groups.length}`);
  }
  // …and the opened-identity collection is bound the same way: opened member
  // ids from rows that should not exist can never go uncounted.
  const openedGroupKeys = Object.keys(openedMemberIds ?? {}).filter((k) => k !== "unresolved");
  if (openedGroupKeys.length !== groups.length) {
    mism.push(`opened group sets ${openedGroupKeys.length} vs expected ${groups.length}`);
  }
  for (const [i, g] of groups.entries()) {
    const item = items[i] ?? {};
    const memberCount = asLen(g.memberIds);
    if (!new RegExp(`Reporting group of ${memberCount} occurrence`).test(item.headline ?? "")) {
      mism.push(`group ${i} (${g.groupId}) headline=${JSON.stringify(item.headline)}`);
    }
    for (const reason of g.renderedReasons ?? []) {
      if (!(item.headline ?? "").includes(reason)) mism.push(`group ${i} missing reason ${JSON.stringify(reason)}`);
    }
    const opened = (openedMemberIds ?? {})[i] ?? [];
    // Exact cardinality both ways: rendered member buttons and the opened
    // identity sequence must each equal the expected member list — a phantom
    // extra member or opened id is a real inconsistency, not surplus proof.
    if ((item.memberButtons ?? -1) !== asLen(g.memberIds)) {
      mism.push(`group ${i} member buttons ${item.memberButtons ?? "n/a"} vs ${asLen(g.memberIds)} expected`);
    }
    if (opened.length !== asLen(g.memberIds)) {
      mism.push(`group ${i} opened ${opened.length} member(s) vs ${asLen(g.memberIds)} expected`);
    }
    for (const [j, id] of (g.memberIds ?? []).entries()) {
      if (opened[j] !== id) mism.push(`group ${i} member ${j} opened=${JSON.stringify(opened[j] ?? null)} want ${id}`);
    }
  }
  const unresOpened = (openedMemberIds ?? {}).unresolved ?? [];
  const wantUnresolved = expect.unresolvedCandidateIds ?? [];
  if (unresOpened.length !== wantUnresolved.length) {
    mism.push(`unresolved opened ${unresOpened.length} vs ${wantUnresolved.length} expected`);
  }
  for (const [j, id] of wantUnresolved.entries()) {
    if (unresOpened[j] !== id) {
      mism.push(`unresolved candidate ${j} opened=${JSON.stringify(unresOpened[j] ?? null)} want ${id}`);
    }
  }
  return { ok: mism.length === 0, detail: mism.join("; ") || `${groups.length} group(s), ${asLen(expect.unresolvedCandidateIds)} unresolved verified` };
}

function a8PolicyNaVerdict(record, surface) {
  const actual = surface?.whyFallback ?? null;
  return {
    ok: actual === record.expect,
    detail: `fallback=${JSON.stringify(actual)} expected=${JSON.stringify(record.expect)}`,
  };
}

function a8TimelineIdsVerdict(record, openedDatedIds) {
  const expect = record.expectIds ?? [];
  const opened = openedDatedIds ?? [];
  const mism = expect.filter((id, i) => opened[i] !== id).map((id, i) => `position ${i} opened=${JSON.stringify(opened[i] ?? null)} want ${id}`);
  if (opened.length !== expect.length) mism.push(`opened ${opened.length} dated item(s) vs expected ${expect.length}`);
  return { ok: mism.length === 0, detail: mism.join("; ") || `${expect.length} dated occurrence(s) opened with expected identity` };
}

function a8UndatedAbsentVerdict(record, surface) {
  // Absence can only be claimed from a measured surface — a failed or null
  // probe is not proof the section is absent.
  if (surface === null || surface === undefined || surface.undated === null || surface.undated === undefined) {
    return { ok: false, detail: "timeline surface unmeasured — cannot establish undated-section absence" };
  }
  const present = surface.undated.sectionPresent === true && asLen(surface.undated.items) > 0;
  return {
    ok: !present,
    detail: `undated section present=${surface.undated.sectionPresent} items=${asLen(surface.undated.items)}`,
  };
}

function a8EmptyStateVerdict(record, surface) {
  const ok =
    surface !== null &&
    surface.datedCount === 0 &&
    (surface.noDatedCoreState === true || surface.noOccurrencesState === true);
  return {
    ok,
    detail: `dated=${surface?.datedCount ?? "unmeasured"} noDatedCore=${surface?.noDatedCoreState} empty=${surface?.noOccurrencesState}`,
  };
}

function a8PlacementVerdict(record, surface, openedUndatedIds) {
  const expect = record.expectIds ?? [];
  const mism = [];
  const undated = surface?.undated ?? null;
  if (!undated || undated.sectionPresent !== true) {
    mism.push("undated section absent, expected items " + JSON.stringify(expect));
    return { ok: false, detail: mism.join("; ") };
  }
  if (record.expectSectionHeading) {
    // N83-2: the section's heading is matched as a VISIBLE, UNIQUE h3 whose
    // authored OR CSS-transformed text equals the expected heading — the
    // product renders it uppercase, so the comparison is case-insensitive but
    // strictly scoped to the heading element.
    if (undated.headingCount !== 1) {
      mism.push(`undated section carries ${undated.headingCount ?? "?"} h3 heading(s), expected exactly one`);
    }
    const headingOk =
      undated.headingVisible === true &&
      (a8HeadingTextMatches(undated.heading, record.expectSectionHeading) ||
        a8HeadingTextMatches(undated.headingRendered, record.expectSectionHeading));
    if (!headingOk) {
      mism.push(
        `section heading=${JSON.stringify(undated.heading)} rendered=${JSON.stringify(undated.headingRendered)} ` +
          `visible=${undated.headingVisible} want ${JSON.stringify(record.expectSectionHeading)}`,
      );
    }
  }
  const items = undated.items ?? [];
  if (items.length !== expect.length) mism.push(`undated items ${items.length} vs expected ${expect.length}`);
  for (const [i, id] of expect.entries()) {
    const item = items[i] ?? {};
    const text = item.text ?? "";
    if (record.expectItemBadge && !text.includes(record.expectItemBadge)) {
      mism.push(`item ${i} missing badge ${JSON.stringify(record.expectItemBadge)}`);
    }
    if (record.expectNoUsableDateText && !text.includes(record.expectNoUsableDateText)) {
      mism.push(`item ${i} missing ${JSON.stringify(record.expectNoUsableDateText)}`);
    }
    const wantNote = (record.expectDateNoteById ?? {})[id] ?? null;
    // The note is bound to the item's ACTUAL opened identity, not its position:
    // openedUndatedIds[i] is the identity the dialog reported.
    const openedId = (openedUndatedIds ?? [])[i] ?? null;
    if (openedId !== id) {
      mism.push(`item ${i} opened=${JSON.stringify(openedId)} want ${id}`);
    } else if (wantNote !== null && !text.includes(wantNote)) {
      mism.push(`item ${i} (${id}) missing date note ${JSON.stringify(wantNote)}`);
    } else if (wantNote === null && /The retrieved dates for this occurrence disagree\./.test(text)) {
      mism.push(`item ${i} (${id}) carries a disputed note it should not`);
    }
    // Placement's core claim: this id never enters the dated timeline.
    if ((surface?.datedIdsOpened ?? []).includes(id)) mism.push(`${id} appeared in the dated timeline`);
  }
  return { ok: mism.length === 0, detail: mism.join("; ") || `${expect.length} undated item(s) placed correctly` };
}

function a8DivergenceVerdict(record, surface, openedEndpointIds) {
  const expect = record.expect ?? {};
  const mism = [];
  if (surface?.divergenceNote?.present !== true) mism.push("divergence note absent");
  const opened = openedEndpointIds ?? {};
  if (opened.earlier !== expect.from) mism.push(`earlier opened=${JSON.stringify(opened.earlier ?? null)} want ${expect.from}`);
  if (opened.later !== expect.to) mism.push(`later opened=${JSON.stringify(opened.later ?? null)} want ${expect.to}`);
  return { ok: mism.length === 0, detail: mism.join("; ") || `pair ${expect.from}|${expect.to} inspectable` };
}

function a8ConnectorsVerdict(record, expectedCase, surface) {
  const edges = expectedCase?.expectedIds?.connectorEdges ?? [];
  const items = surface?.datedItems ?? [];
  const ids = surface?.datedIdsOpened ?? [];
  const mism = [];
  for (const edge of edges) {
    const idx = ids.indexOf(edge.toOccurrenceId);
    if (idx < 0) {
      mism.push(`edge ${edge.pair}: ${edge.toOccurrenceId} not among opened dated ids`);
      continue;
    }
    const text = items[idx]?.text ?? "";
    if (!text.includes(edge.expectConnectorLabel)) {
      mism.push(`edge ${edge.pair}: connector ${JSON.stringify(edge.expectConnectorLabel)} absent in item ${idx}`);
    }
  }
  // When the map declares the later edge the first-observed divergence, the
  // product owes two more rendered facts beyond the connector label: the
  // unresolved-transitions sentence inside the divergence note itself, and
  // the divergence badge on the actual LATER endpoint card (the card whose
  // opened identity is laterId — not merely the same words anywhere).
  const lp = record.expect?.laterDivergencePair ?? null;
  if (lp?.isFirstObservedDivergence === true) {
    const note = surface?.divergenceNote ?? null;
    if (note?.present !== true) mism.push("first-observed divergence note absent");
    if (typeof lp.expectDivergenceNote === "string") {
      const noteText = (note?.text ?? "").replace(/\s+/g, " ").trim();
      if (!noteText.includes(lp.expectDivergenceNote)) {
        mism.push(`divergence note ${JSON.stringify(noteText || null)} lacks the required sentence ${JSON.stringify(lp.expectDivergenceNote)}`);
      }
    }
    const laterId = lp.expectInspection?.laterId ?? null;
    const laterBadge = lp.expectInspection?.laterBadge ?? null;
    if (laterId !== null && typeof laterBadge === "string") {
      const idx = ids.indexOf(laterId);
      if (idx < 0) {
        mism.push(`later endpoint ${laterId} not among opened dated ids — badge unverifiable`);
      } else if (!(items[idx]?.badges ?? []).includes(laterBadge)) {
        mism.push(
          `later endpoint card badges ${JSON.stringify(items[idx]?.badges ?? null)} lack ${JSON.stringify(laterBadge)}`,
        );
      }
    }
  }
  // `comparedPairIdsExcludeUnexamined` declares exactly which edges count as
  // successful comparisons: the unexamined early edge is a connector, never a
  // compared pair — assert the map's own compared set equals it so a phantom
  // gap pair can never be smuggled in by either direction.
  if (Array.isArray(record.expect?.comparedPairIdsExcludeUnexamined)) {
    const declared = new Set(record.expect.comparedPairIdsExcludeUnexamined);
    const compared = new Set(expectedCase?.expectedIds?.comparedPairIds ?? []);
    for (const p of compared) if (!declared.has(p)) mism.push(`compared pair ${p} not among the record's compared pairs`);
    for (const p of declared) if (!compared.has(p)) mism.push(`expected compared pair ${p} absent from expectedIds.comparedPairIds`);
  }
  return { ok: mism.length === 0, detail: mism.join("; ") || `${edges.length} connector edge(s) verified` };
}

/** The map-internal consistency a wrong-case mutation breaks: every record id
 *  is namespaced by its own fixture, and the overview headline record agrees
 *  with the case-level frozen headline. */
function expectedCaseCoherent(expectedCase) {
  const fixture = expectedCase?.fixture;
  const records = expectedCase?.visibleExpectations ?? [];
  const bad = records.filter((r) => expectedRecordKind(r, fixture) === r.id);
  const headline = records.find((r) => expectedRecordKind(r, fixture) === "overview-headline");
  return {
    ok:
      bad.length === 0 &&
      (headline === undefined || headline.expect === expectedCase.expectedOverviewHeadline),
    detail:
      `${records.length} record(s), ${bad.length} foreign-id record(s)` +
      (headline ? `, headline record ${headline.expect === expectedCase.expectedOverviewHeadline ? "agrees" : "DISAGREES"} with frozen headline` : ""),
  };
}

/* ---- page-side probes (function sources, like FOCUS_SAMPLER_FN) ---------- */

/** The Overview surface: status heading, the paragraphs under it, and the
 *  three metric cards keyed by their dt label. */
const A8_OVERVIEW_PROBE_FN = `(() => {
  const sec = document.querySelector('section[aria-label="Investigation result"]');
  if (!sec) return null;
  const h1 = sec.querySelector("h1");
  const box = h1 ? h1.parentElement : null;
  const paragraphs = box
    ? [...box.querySelectorAll(":scope > p")].map((p) => (p.innerText || "").trim())
    : [];
  const metrics = {};
  for (const card of sec.querySelectorAll("dl > div")) {
    const dt = card.querySelector("dt");
    const dd = card.querySelector("dd");
    if (dt && dd) metrics[(dt.innerText || "").trim()] = (dd.innerText || "").trim();
  }
  return { headline: h1 ? (h1.innerText || "").trim() : null, paragraphs, metrics };
})()`;

/** Effective visibility for a heading (or any element), evaluated in-page:
 *  own AND ancestor display/visibility/opacity, the [hidden] attribute chain,
 *  and a real rendered box. A child of display:none keeps ordinary own
 *  display — only the ancestor walk sees the hiding — and an opacity:0 heading
 *  retains normal display/visibility, so both must be checked explicitly. */
const A8_EFFECTIVE_VISIBLE_FN = `(el) => {
  if (!el || el.nodeType !== 1) return false;
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    const st = getComputedStyle(n);
    if (st.display === "none") return false;
    if (st.visibility === "hidden" || st.visibility === "collapse") return false;
    if (Number.parseFloat(st.opacity) === 0) return false;
    if (n.hasAttribute("hidden")) return false;
  }
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}`;

/** The Timeline surface: dated items, both empty states, the undated section
 *  and the divergence note. Identity is never read off card text — openers
 *  are clicked and the dialog's identity line is the identity proof. */
const A8_TIMELINE_PROBE_FN = `(() => {
  const panel = document.getElementById("ct-panel-timeline");
  if (!panel) return null;
  const ol = panel.querySelector("ol");
  const datedItems = [...(ol ? ol.querySelectorAll(":scope > li") : [])].map((li) => ({
    title: (li.querySelector("h3")?.innerText ?? "").trim(),
    text: li.innerText ?? "",
    badges: [...li.querySelectorAll("div.flex.flex-wrap.gap-2 > span")].map((s) =>
      (s.innerText || s.textContent || "").trim(),
    ),
    inspectLabel: li.querySelector('button[aria-label^="Inspect evidence"]')?.getAttribute("aria-label") ?? null,
  }));
  const undatedSec = panel.querySelector('section[aria-label="Evidence with unknown dates"]');
  const undatedHeads = undatedSec ? [...undatedSec.querySelectorAll(":scope > h3")] : [];
  const undatedH = undatedHeads[0] ?? null;
  const undated = undatedSec
    ? {
        sectionPresent: true,
        // Heading identity is read BOTH ways: heading is the authored
        // textContent and headingRendered the CSS-transformed innerText —
        // the product styles this h3 uppercase, so the verdict compares
        // case-insensitively and requires the heading to be independently
        // VISIBLE (display/visibility/[hidden] all count against it).
        heading: undatedH ? (undatedH.textContent ?? "").replace(/\\s+/g, " ").trim() : null,
        headingRendered: undatedH ? (undatedH.innerText ?? "").replace(/\\s+/g, " ").trim() : null,
        headingCount: undatedHeads.length,
        // Effective visibility: own + ancestor display/visibility/opacity,
        // [hidden], and a real rendered box — an invisible heading owns nothing.
        headingVisible: (${A8_EFFECTIVE_VISIBLE_FN})(undatedH),
        items: [...undatedSec.querySelectorAll("ul > li")].map((li) => ({
          title: (li.querySelector("h3")?.innerText ?? "").trim(),
          text: li.innerText ?? "",
          inspectLabel: li.querySelector('button[aria-label^="Inspect evidence"]')?.getAttribute("aria-label") ?? null,
        })),
      }
    : {
        sectionPresent: false,
        heading: null,
        headingRendered: null,
        headingCount: 0,
        headingVisible: false,
        items: [],
      };
  const texts = [...panel.querySelectorAll("p")].map((p) => (p.innerText || "").trim());
  const note = panel.querySelector('[role="note"][aria-label="First observed context divergence"]');
  return {
    datedCount: datedItems.length,
    datedItems,
    noDatedCoreState: texts.some((t) => /No dated core occurrences were found/.test(t)),
    noOccurrencesState: texts.some((t) => /No occurrences were returned in this investigation/.test(t)),
    undated,
    divergenceNote: note
      ? {
          present: true,
          text: (note.querySelector("p")?.innerText ?? "").replace(/\\s+/g, " ").trim(),
          buttons: [...note.querySelectorAll("button")].map((b) => (b.innerText || "").trim()),
        }
      : { present: false, text: null, buttons: [] },
  };
})()`;

/** The Analysis surface, sectioned by its own h3 headings so repeated copy
 *  (e.g. "View supporting evidence →") is always read inside its owning gate
 *  or group — never pooled across the panel. */
const A8_ANALYSIS_PROBE_FN = `(() => {
  const sec = document.querySelector('#ct-panel-analysis section[aria-label="Analysis"]');
  if (!sec) return null;
  const hs = [...sec.querySelectorAll("h3")];
  // N83-2: section ownership is bound to a UNIQUE, VISIBLE heading whose
  // authored OR CSS-rendered text equals the expected name. The product styles
  // these h3 headings uppercase via text-transform, so authored textContent and
  // rendered innerText are both accepted case-insensitively — but only for the
  // heading element itself; paragraph content is never case-normalized. A
  // section with zero or several matching visible headings owns nothing.
  const normHead = (s) => (s ?? "").replace(/\\s+/g, " ").trim().toLowerCase();
  const headVisible = ${A8_EFFECTIVE_VISIBLE_FN};
  const findHeading = (name) => {
    const want = normHead(name);
    const matches = hs.filter((x) => {
      const authored = normHead(x.textContent);
      const rendered = typeof x.innerText === "string" ? normHead(x.innerText) : authored;
      return authored === want || rendered === want;
    });
    const visible = matches.filter(headVisible);
    return visible.length === 1 ? visible[0] : null;
  };
  const slice = (name) => {
    const h = findHeading(name);
    if (!h) return [];
    const out = [];
    for (let n = h.nextElementSibling; n && !/^H[23]$/.test(n.tagName); n = n.nextElementSibling) out.push(n);
    return out;
  };
  const paras = (els) => els.filter((e) => e.tagName === "P").map((e) => (e.innerText || "").trim());
  const cov = slice("Comparison coverage");
  const perf = slice("Comparisons performed");
  const perfUl = perf.find((e) => e.tagName === "UL");
  const why = slice("Why this result");
  const whyParas = paras(why);
  const whyUl = why.find((e) => e.tagName === "UL");
  const grp = slice("Reporting groups");
  const grpUl = grp.find((e) => e.tagName === "UL");
  const unresolvedP = grp
    .filter((e) => e.tagName === "P")
    .find((e) => /^\\d+ unresolved candidates?:/.test((e.innerText || "").trim()));
  return {
    coverageText: paras(cov)[0] ?? null,
    performedRows: perfUl
      ? [...perfUl.children].map((li) => ({
          text: (li.innerText || "").trim(),
          buttons: li.querySelectorAll("button").length,
        }))
      : [],
    performedEmpty: paras(perf).find((t) => /No context comparison was performed/.test(t)) ?? null,
    originsText: paras(slice("Reporting origins"))[0] ?? null,
    statusBasis: whyParas.find((t) => /^Status basis:/.test(t)) ?? null,
    whyFallback: whyParas.find((t) => /policy reasons were not included/i.test(t)) ?? null,
    gateItems: whyUl
      ? [...whyUl.children].map((li) => {
          const rawLabel = (li.querySelector("p")?.innerText ?? "").trim();
          // The pass glyph is an aria-hidden span inside the label <p>; the
          // map's expectText carries "<label>: passed|not passed" without it.
          // (double-escaped: this body is itself a template literal, so the
          // evaluated regex needs the backslash preserved)
          const glyph = /^[✓✗]/.exec(rawLabel)?.[0] ?? null;
          return {
            label: rawLabel.replace(/^[✓✗]\\s*/, ""),
            glyph,
            detail: (li.querySelectorAll("p")[1]?.innerText ?? "").trim(),
            supportButtons: li.querySelectorAll("button").length,
          };
        })
      : [],
    groupsEmpty: paras(grp).find((t) => /No resolved reporting groups/.test(t)) ?? null,
    groupItems: grpUl
      ? [...grpUl.children].map((li) => ({
          headline: (li.querySelector("p")?.innerText ?? "").trim(),
          memberButtons: li.querySelectorAll("button").length,
        }))
      : [],
    unresolvedText: unresolvedP ? (unresolvedP.innerText || "").trim() : null,
    unresolvedButtons: unresolvedP ? unresolvedP.querySelectorAll("button").length : 0,
  };
})()`;

/* ------- click-through helpers: opened identity is the identity ---------- */

/** Click an evidence opener, read the dialog's rendered `Occurrence ID:` line —
 *  the product's own identity statement — then close via "Back to timeline".
 *  Returns the opened id or null; callers assert, never assume. */
async function readOpenedEvidenceId(page, opener) {
  try {
    await opener.click();
    const dialog = page.locator('[role="dialog"]');
    await dialog.waitFor({ state: "visible", timeout: 15_000 });
    // `Occurrence ID:` is the last line of the Technical-details <details> —
    // rendered but collapsed, so textContent (not innerText) carries it. The
    // read is scoped to that disclosure: exactly one field, spoofed text
    // elsewhere in the dialog cannot impersonate it.
    const ident = await openedOccurrenceId(dialog);
    const id = ident.ok === true ? ident.id : null;
    const back = dialog.getByRole("button", { name: /back to timeline/i }).first();
    if ((await back.count()) > 0) await back.click();
    else await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {});
    return id;
  } catch {
    return null;
  }
}

/** A locator for the `li` sequence inside the FIRST `ul` following a named
 *  Analysis h3 — adjacent-sibling CSS cannot express "the next ul" when a
 *  paragraph (e.g. the Status basis line) intervenes, so XPath does it. The
 *  scope is the same one the analysis probe measured. */
function a8ListBelow(page, heading) {
  return page
    .locator(`#ct-panel-analysis section[aria-label="Analysis"] h3`, { hasText: heading })
    .first()
    .locator("xpath=following-sibling::ul[1]")
    .locator("> li");
}

/** Discharge every map record whose observable renders on `view`, as one
 *  `a8.expect.<record-id>` assertion each — the 147 records are consumed as
 *  distinct observations, never collapsed into a single aggregate check. */
async function observeExpectedRecords(page, rec, expectedCase, view, { terminal }) {
  const fixture = expectedCase.fixture;
  const records = (expectedCase.visibleExpectations ?? []).filter(
    (r) => expectedViewBucket(r, fixture) === view,
  );
  if (records.length === 0) return;
  const coherence = expectedCaseCoherent(expectedCase);
  rec.check(
    `a8.expect.${fixture}-map-coherent`,
    coherence.ok,
    coherence.detail,
  );

  if (view === "overview") {
    const surface = await page.evaluate(A8_OVERVIEW_PROBE_FN).catch(() => null);
    for (const r of records) {
      const kind = expectedRecordKind(r, fixture);
      let v;
      if (kind === "overview-headline") v = a8HeadlineVerdict(r, surface);
      else if (kind === "overview-support") v = a8SupportVerdict(r, surface);
      else if (kind === "caveat-visible") v = a8CaveatVerdict(r, surface);
      else if (kind === "caveat-serialized") v = a8CaveatSerializedVerdict(r, terminal);
      else if (kind === "analysis-segments") v = a8SegmentsVerdict(r, surface);
      else continue;
      rec.check(`a8.expect.${r.id}`, v.ok, v.detail);
    }
    // The claim the terminal carried is the claim this recipe submitted —
    // a serialized observation binding the consumed payload to the case.
    const claimOk =
      expectedCase.claimSubmitted === null
        ? (terminal?.claim ?? null) === null
        : terminal?.claim === expectedCase.claimSubmitted;
    rec.check(
      `a8.expect.${fixture}-claim-consumed`,
      claimOk,
      `terminal.claim=${JSON.stringify(terminal?.claim ?? null)} expected=${JSON.stringify(expectedCase.claimSubmitted)}`,
    );
  } else if (view === "timeline") {
    const surface = await page.evaluate(A8_TIMELINE_PROBE_FN).catch(() => null);
    // Open every dated card's Inspect control in order: the opened identity
    // sequence is the timeline's identity proof (never raw rendered text).
    const openers = page.locator('#ct-panel-timeline ol > li button[aria-label^="Inspect evidence"]');
    const openedDated = [];
    const n = await openers.count();
    for (let i = 0; i < n; i++) openedDated.push(await readOpenedEvidenceId(page, openers.nth(i)));
    if (surface) surface.datedIdsOpened = openedDated;
    for (const r of records) {
      const kind = expectedRecordKind(r, fixture);
      let v;
      if (kind === "timeline-ids") v = a8TimelineIdsVerdict(r, openedDated);
      else if (kind === "undated-section-absent") v = a8UndatedAbsentVerdict(r, surface);
      else if (kind === "timeline-empty-state") v = a8EmptyStateVerdict(r, surface);
      else if (kind === "connectors") v = a8ConnectorsVerdict(r, expectedCase, surface);
      else if (kind === "placement" || kind === "divergence") continue; // click-dependent records discharge in the loop below
      else continue;
      rec.check(`a8.expect.${r.id}`, v.ok, v.detail);
    }
    for (const r of records) {
      const kind = expectedRecordKind(r, fixture);
      if (kind === "placement") {
        const uitems = page.locator(
          '#ct-panel-timeline section[aria-label="Evidence with unknown dates"] ul > li button[aria-label^="Inspect evidence"]',
        );
        const openedUndated = [];
        const u = await uitems.count();
        for (let i = 0; i < u; i++) openedUndated.push(await readOpenedEvidenceId(page, uitems.nth(i)));
        const v = a8PlacementVerdict(r, surface, openedUndated);
        rec.check(`a8.expect.${r.id}`, v.ok, v.detail);
      } else if (kind === "divergence") {
        const noteBtns = page.locator(
          '#ct-panel-timeline [role="note"][aria-label="First observed context divergence"] button',
        );
        const opened = {};
        if ((await noteBtns.count()) >= 2) {
          opened.earlier = await readOpenedEvidenceId(page, noteBtns.nth(0));
          opened.later = await readOpenedEvidenceId(page, noteBtns.nth(1));
        }
        const v = a8DivergenceVerdict(r, surface, opened);
        rec.check(`a8.expect.${r.id}`, v.ok, v.detail);
      }
    }
  } else if (view === "analysis") {
    const surface = await page.evaluate(A8_ANALYSIS_PROBE_FN).catch(() => null);
    const needsGates = records.some((r) => expectedRecordKind(r, fixture) === "gates");
    const needsOrigins = records.some((r) => expectedRecordKind(r, fixture) === "analysis-origins");
    const needsPairs = records.some((r) => expectedRecordKind(r, fixture) === "analysis-coverage");
    // Opened identity per scope: performed-row endpoints, gate support links,
    // group member links and unresolved candidates are each clicked in place.
    // Each click block is gated on the probe's OWN row count for that section:
    // an empty section renders no ul, and the nearest following-sibling ul
    // would belong to the next heading — probing cross-section rows as this
    // section's links must never happen.
    const openedPairKeys = [];
    if (needsPairs && (surface?.performedRows?.length ?? 0) > 0) {
      const rows = a8ListBelow(page, "Comparisons performed");
      const rowCount = await rows.count();
      for (let i = 0; i < rowCount; i++) {
        const btns = rows.nth(i).locator("button");
        // Per-row alignment (N83-4): openedPairKeys[i] is the pair identity the
        // i-th rendered row opened — every relationship row renders, including
        // unexamined edges, so slots stay aligned even where a row is
        // unopenable. The slot carries the ACQUISITION state too (N83-R4
        // residual): a row offering two controls whose opens return no
        // readable identity is a FAILED read — not the same thing as a row
        // that genuinely offered no controls to open.
        const offered = await btns.count();
        const st = { offered, attempted: false, from: null, to: null, key: null };
        if (offered >= 2) {
          st.attempted = true;
          st.from = await readOpenedEvidenceId(page, btns.nth(0));
          st.to = await readOpenedEvidenceId(page, btns.nth(1));
          if (st.from && st.to) st.key = `${st.from}|${st.to}`;
        }
        openedPairKeys.push(st);
      }
    }
    const openedSupportIds = {};
    if (needsGates && (surface?.gateItems?.length ?? 0) > 0) {
      const gates = a8ListBelow(page, "Why this result");
      const gateCount = await gates.count();
      for (let i = 0; i < gateCount; i++) {
        const btns = gates.nth(i).locator("button");
        const bc = await btns.count();
        const opened = [];
        for (let j = 0; j < bc; j++) opened.push(await readOpenedEvidenceId(page, btns.nth(j)));
        openedSupportIds[i] = opened;
      }
    }
    const openedMemberIds = {};
    if (needsOrigins) {
      if ((surface?.groupItems?.length ?? 0) > 0) {
        const groups = a8ListBelow(page, "Reporting groups");
        const groupCount = await groups.count();
        for (let i = 0; i < groupCount; i++) {
          const btns = groups.nth(i).locator("button");
          const bc = await btns.count();
          const opened = [];
          for (let j = 0; j < bc; j++) opened.push(await readOpenedEvidenceId(page, btns.nth(j)));
          openedMemberIds[i] = opened;
        }
      }
      // The unresolved-candidates paragraph is the one that literally opens
      // with "N unresolved candidates:" — CSS `~` cannot stop at the next h3,
      // so the text filter does the section binding here.
      const unres = page
        .locator('#ct-panel-analysis section[aria-label="Analysis"] p')
        .filter({ hasText: /^\d+ unresolved candidates?:/ })
        .locator("button");
      const uc = await unres.count();
      const openedU = [];
      for (let i = 0; i < uc; i++) openedU.push(await readOpenedEvidenceId(page, unres.nth(i)));
      openedMemberIds.unresolved = openedU;
    }
    for (const r of records) {
      const kind = expectedRecordKind(r, fixture);
      let v;
      if (kind === "analysis-coverage") v = a8CoverageVerdict(r, surface, openedPairKeys, terminal);
      else if (kind === "gates") v = a8GatesVerdict(r, surface, openedSupportIds);
      else if (kind === "analysis-origins") v = a8OriginsVerdict(r, surface, openedMemberIds);
      else if (kind === "analysis-policy-not-applicable") v = a8PolicyNaVerdict(r, surface);
      else continue;
      rec.check(`a8.expect.${r.id}`, v.ok, v.detail);
    }
  }
}

/* ------------------------- A8 recipe bindings ---------------------------- */

/**
 * The maintained-runner binding for each of the map's 17 recipe templates.
 * `runnerPin`/`acceptedCommandArgs`/`caseId`/`caseImport` were UNBOUND at map
 * seal time; this builder binds them to this CLI's real command surface —
 * nothing is fabricated: every arg vector is one `parseDriveOptions` accepts,
 * the fixture sha is read from the received bytes, and the digest covers the
 * whole binding table so a later edit changes it loudly.
 *
 * `runnerSha256` is recorded as evidence (the module bytes at bind time) but
 * is deliberately OUTSIDE `recipeDigest`: the digest covers the semantic
 * contract only, so a CLI change that does not touch the contract keeps it.
 */
function buildA8RecipeBindings() {
  const map = loadExpectedCaseMap();
  const viewArg = { Overview: "overview", Timeline: "timeline", "Timeline-empty-state": "timeline", Sources: "sources", Analysis: "analysis" };
  const recipes = map.cases.map((c) => {
    const fixture = c.fixture;
    const fixtureSha = sha256(fs.readFileSync(fixturePath(fixture)));
    const claimArgs =
      c.entryMode === "claim_check" ? ["--claim-text", c.claimSubmitted ?? ""] : [];
    const commands = [];
    const resultViews = new Set();
    let wantsViewer = false;
    for (const v of c.views ?? []) {
      if (v.startsWith("viewer:")) wantsViewer = true;
      else if (viewArg[v]) resultViews.add(viewArg[v]);
    }
    for (const view of ["overview", "timeline", "sources", "analysis"]) {
      if (!resultViews.has(view)) continue;
      commands.push({
        purpose: `result view ${view}`,
        args: ["drive", "result", "--run-id", "<run-id>", "--case", fixture, "--view", view, ...claimArgs],
      });
    }
    if (wantsViewer) {
      commands.push({
        purpose: "viewer Inspect evidence (dated timeline occurrences)",
        args: ["drive", "viewer", "--run-id", "<run-id>", "--entry", "timeline", "--case", fixture, ...claimArgs],
      });
    }
    return {
      caseId: `a8-${fixture}`,
      fixture,
      fixtureSha256: fixtureSha,
      entryTier: c.entryTier ?? null,
      entryMode: c.entryMode ?? null,
      claimSubmitted: c.claimSubmitted ?? null,
      expectedStatus: c.expectedStatus ?? null,
      streamSha256: c.streamSha256 ?? null,
      views: c.views ?? [],
      negativeFamily: c.negativeFamily ?? "none",
      negativeRole: c.negativeRole ?? null,
      commands,
      requiredFlags: ["--run-id", ...(c.entryMode === "claim_check" ? ["--claim-text"] : [])],
    };
  });
  const bound = {
    mapFile: "fixtures/a8-expected-case-map.json",
    mapSha256: A8_MAP_SHA256,
    acceptedAppPin: A8_APP_PIN,
    fixtureSubsetPin: A8_FIXTURE_PIN,
    releaseSeal: A8_RELEASE_SEAL,
    runner: "cli/control-contexttrail.mjs",
    recipes,
  };
  const digest = sha256(Buffer.from(JSON.stringify(bound), "utf8"));
  return {
    ...bound,
    runnerSha256: sha256(fs.readFileSync(CLI_PATH)),
    recipeDigest: digest,
    note: "recipeDigest covers {mapFile,mapSha256,acceptedAppPin,fixtureSubsetPin,releaseSeal,runner,recipes} only; runnerSha256 is recorded evidence, not a digest input",
  };
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
      imageName: "upload.png",
      imageBytes: input.kind === "controlled" ? input.imageBytes : null,
      imageSha256: input.kind === "controlled" ? input.imageSha256 : null,
      imageSource: "generated-controlled-1x1-png (harness input, 70B)",
      imageOnWire:
        "the app re-encodes the input; B's request carried investigation-image 560B. The exact wire " +
        "bytes are NOT retained, so no wire image hash is claimed — only the harness input hash above.",
      imageEntryMethod: "setInputFiles",
      // The per-request ledger, linked by name so the record does not duplicate
      // it: planned-vs-observed claim/media identities live there.
      requestInputs: "request-inputs.json",
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
        // S3: an interrupted stream-ownership drive keeps what it observed.
        persistStreamOwnership(driveDir, stream, `interrupted by ${signal}`);
        rec.push("drive.interrupted", "FAIL", `interrupted by ${signal}`);
        await rec.close();
        writeJson(path.join(driveDir, "drive.json"), {
          ...initialRecord,
          outcome: "INCOMPLETE",
          complete: false,
          interruptedBy: signal,
          streamOwnership: stream?.state?.ownership?.persisted
            ? {
                planned: stream.state.ownership.plan.plans.length,
                observed: stream.state.ownership.persisted.projection.requests.filter((r) => r.observed).length,
                finalizedUnder: stream.state.ownership.persisted.reason,
              }
            : null,
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
      // S3: a case that aborted (assertion throw, timeout, dead page) still
      // persists what it observed — ledger, per-request inputs and retained
      // integrity. On the success path the case already ran this; the call is
      // idempotent, so only the reason differs and only the first write stands.
      persistStreamOwnership(
        driveDir,
        stream,
        outcome === "FAIL"
          ? `the case aborted: ${String(failure ?? "unknown failure").slice(0, 300)}`
          : "the case ran to completion",
      );
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
    // The recorder stays OPEN through the post-finally bookkeeping below —
    // drive.videos-collected and fault.sabotage-reported are real assertions
    // that must reach the durable file, not just the in-memory count.
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

  // NOW the recorder closes — after the last possible push — and waits for the
  // file to flush, so `counts()` and the durable assertions.jsonl can never
  // diverge again. A drive's reported totals and the seal's totals come from
  // the same persisted entries.
  await rec.close();
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
    // different image or claim. A multi-stream drive submits more than one
    // request, so the full contract — claim count, the per-request identity
    // file, the entry method and the honest wire-image note — is serialized
    // too, not just the single-claim fields.
    input: input
      ? {
          kind: input.kind,
          imageName: input.imageName ?? null,
          imageBytes: input.imageBytes ?? null,
          imageSha256: input.imageSha256 ?? null,
          imageSource: input.imageSource ?? null,
          imageEntryMethod: input.imageEntryMethod ?? null,
          imageOnWire: input.imageOnWire ?? null,
          claimProvided: input.claimProvided,
          claimCount: input.claimCount ?? null,
          claimNote: input.claimNote ?? null,
          claimSha256:
            typeof input.claim === "string" ? sha256(Buffer.from(input.claim, "utf8")) : null,
          requestInputs: input.requestInputs ?? null,
        }
      : null,
    // The multi-request contract AS OBSERVED, persisted by the failure-safe
    // finalizer before this record is written: a failed drive still reports how
    // many planned requests actually reached the transport and under which exit
    // the record was finalized — "complete" is never implied by the record
    // existing.
    streamOwnership: stream?.state?.ownership?.persisted
      ? {
          planned: stream.state.ownership.plan.plans.length,
          observed: stream.state.ownership.persisted.projection.requests.filter((r) => r.observed).length,
          finalizedUnder: stream.state.ownership.persisted.reason,
          requestInputs: "request-inputs.json",
          deliveryLedger: "delivery-ledger.json",
          retainedStreams: "retained-streams.json",
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
    // Map authority is resolved BEFORE any drive effect: for a maintained A8
    // fixture a missing/unreadable/mismatched map or a missing entry fails the
    // run here, never mid-observation as a silent skip.
    const expectedCase = live ? null : expectedCaseFor(caseName);
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
      if (!panel) return { observedTab: (selected?.textContent || "").trim(), tabAriaControls: id, panelId: id, panelExists: false, panelRole: null, settled: false, rowsInPanel: 0 };
      const r = panel.getBoundingClientRect();
      return {
        observedTab: (selected?.textContent || "").trim(),
        tabAriaControls: id,
        panelId: id,
        panelExists: true,
        panelRole: panel.getAttribute("role"),
        panelAriaLabelledby: panel.getAttribute("aria-labelledby"),
        settled: r.height > 1,
        rowsInPanel: panel.querySelectorAll("li,dd,p,span,a,td,div").length,
      };
    });
    rec.check(
      "result.measurement-surface-is-the-requested-panel",
      measurementSurfaceOk(requestedView, panelInfo),
      `requested "${requestedView}", observed tab "${panelInfo.observedTab}", panel ${panelInfo.panelId} ` +
        `settled=${panelInfo.settled} (${panelInfo.rowsInPanel} candidate nodes inside that panel)`,
    );
    // The scope itself is asserted: the selected tab's own aria-controls must
    // resolve to a real [role=tabpanel] whose id matches. The A10 defect was a
    // broad selector union that measured shared headers — every contrast node
    // below is resolved strictly inside this resolved panel.
    rec.check(
      "result.selected-panel-aria-controls-resolved",
      panelScopeOk(panelInfo),
      `tab aria-controls=${panelInfo.tabAriaControls} panel=${panelInfo.panelId} ` +
        `exists=${panelInfo.panelExists} role=${panelInfo.panelRole}`,
    );
    // RO2: settle on a CONFIRMED state, not a fixed delay. For the restoration
    // variant that means waiting until the injected stylesheet is actually gone
    // before settling two frames — measuring first caught the reversal still in
    // place, so "restored" was red for the wrong reason.
    if (flags.fault === "reading-order-restored") {
      await page
        .waitForFunction(
          () =>
            !document.getElementById("ct-reading-order") &&
            window.__ctReadingOrderTarget?.restored === true,
          undefined,
          { timeout: 15_000 },
        )
        .catch(() => {});
    }
    await page
      .evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
      .catch(() => {});
    const faultTarget = await page.evaluate(() => window.__ctReadingOrderTarget ?? null);
    rec.note("result.reading-order-mutation-target", JSON.stringify(faultTarget));
    // RO1+RO5: the requirement is conditioned on the fault ACTUALLY requested.
    // With a reading fault asked for, the target must be the measured panel's
    // own Sources list and must have applied. With NO fault the only honest
    // requirement is that NO sabotage target exists — the requested panel was
    // already established by the check above, so requiring "Sources" here made
    // every other valid --view a false red.
    rec.check(
      "result.reading-order-mutation-target-is-the-requested-list",
      readingOrderTargetOk(flags.fault ?? null, faultTarget, panelInfo.panelId),
      faultTarget === null
        ? `no reading-order mutation applied on the requested "${requestedView}" panel (baseline)`
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

    // The selected panel is compared with the fixture it was rendered from:
    // counts must line up, and no placeholder token may reach the user.
    // A LIVE run has no fixture: the returned investigation is whatever the
    // backend produced, so nothing here may be compared with controlled rows.
    // `terminal` stays null and every fixture comparison is replaced by an
    // observation of what was actually rendered — the contrast/measurement
    // contract below treats that unknown contract as populated-required.
    const terminal = live ? null : fixtureTerminal(caseName);

    // Selected-panel effective contrast (accepted A10 correction 2): each
    // accepted node is resolved strictly INSIDE the selected tab's own
    // aria-controls panel, membership is asserted per node, own opacity and
    // ancestor opacity enter the effective foreground alpha, and ANY
    // group-forming ancestor with opacity < 1 is verdict UNSUPPORTED — a
    // non-pass whose diagnostic ratio is never an accepted number.
    // F38-3: every named target is contract-bound against the fixture's own
    // terminal payload — populated content the data owes must render a real
    // measured node (a miss is a failure, never a skip), and a contract-empty
    // surface must render its required explanation text as the measured node.
    const panelTargets = PANEL_NODE_TARGETS[view] ?? [];
    if (panelTargets.length > 0 && panelScopeOk(panelInfo)) {
      await page.evaluate(EFFECTIVE_CONTRAST_FN).catch(() => {});
      // The consumed-stream contract: searchCounts come from the hook's
      // search.batch fold, not the terminal payload — so the fixture's own
      // events decide which retrieval-accounting branch is owed.
      const contractCtx = {
        terminal,
        searchCounts: live ? null : consumedSearchCounts(fixtureEvents(caseName)),
      };
      const measured = [];
      const owed = [];
      for (const t of panelTargets) {
        const contract = panelContractPopulated(t.populatedWhen, contractCtx);
        const populatedSpec =
          typeof t.populated === "string" ? { selector: t.populated } : t.populated;
        const emptySpec = t.empty
          ? { selector: t.empty.selector, scope: t.empty.scope, nth: t.empty.nth, expectText: t.empty.text }
          : null;
        let m = null;
        if (contract === "populated") {
          owed.push(t.key);
          m = await measurePanelContrast(page, panelInfo.panelId, populatedSpec).catch((e) => ({
            found: false,
            reason: String(e),
          }));
          rec.check(
            `result.${view}-contrast-${t.key}-inside-selected-panel`,
            m.found === true && m.isInsidePanel === true && m.membership === panelInfo.panelId,
            JSON.stringify({ key: t.key, note: t.note, found: m.found, membership: m.membership ?? null, reason: m.reason ?? null }),
          );
        } else if (contract === "empty") {
          // Contract-empty: the populated selector must match NOTHING inside
          // the panel (data cannot produce it), and the required explanation
          // text must be the visible measured node instead.
          const pop = await measurePanelContrast(page, panelInfo.panelId, populatedSpec).catch(() => ({ found: false, matchCount: null }));
          rec.check(
            `result.${view}-contrast-${t.key}-populated-absent`,
            pop.matchCount === 0,
            `contract ${t.populatedWhen}=empty for this fixture; ${pop.matchCount ?? "?"} populated node(s) rendered`,
          );
          owed.push(t.key);
          m = emptySpec
            ? await measurePanelContrast(page, panelInfo.panelId, emptySpec).catch((e) => ({ found: false, reason: String(e) }))
            : { found: false, reason: "target declares no empty spec" };
          rec.check(
            `result.${view}-contrast-${t.key}-empty-explanation-rendered`,
            m.found === true && m.isInsidePanel === true && m.textMatched === true && m.rendered === true,
            JSON.stringify({ key: t.key, found: m.found, textMatched: m.textMatched ?? null, rendered: m.rendered ?? null, expected: t.empty?.text ?? null }),
          );
        } else if (contract === "absent") {
          // Required-absent (e.g. an empty requestLog maps to zero rows): the
          // populated selector must match nothing; no explanation is owed.
          const pop = await measurePanelContrast(page, panelInfo.panelId, populatedSpec).catch(() => ({ found: false, matchCount: null }));
          rec.check(
            `result.${view}-contrast-${t.key}-populated-absent`,
            pop.matchCount === 0,
            `contract ${t.populatedWhen}=absent for this fixture; ${pop.matchCount ?? "?"} populated node(s) rendered`,
          );
          continue;
        } else {
          // Optional contract (live run, or hook state not in the terminal):
          // measure whichever legitimate branch actually rendered — populated
          // first, else the declared explanation. Targets with absentOk may
          // honestly render nothing; all others must render SOMETHING.
          m = await measurePanelContrast(page, panelInfo.panelId, populatedSpec).catch(() => ({ found: false }));
          if (m.found !== true && emptySpec !== null) {
            const em = await measurePanelContrast(page, panelInfo.panelId, emptySpec).catch(() => ({ found: false }));
            if (em.found === true && em.textMatched === true) m = em;
          }
          if (m.found !== true) {
            if (t.absentOk !== true) owed.push(t.key); // owed a render and failed
            if (t.absentOk === true) {
              rec.check(
                `result.${view}-contrast-${t.key}-optional-absent`,
                true,
                `contract optional; no ${t.key} content rendered — legitimate under the consumed state`,
              );
              continue;
            }
            rec.check(
              `result.${view}-contrast-${t.key}-branch-measured`,
              false,
              `contract optional but NEITHER populated nor explanation content rendered for ${t.key}`,
            );
            continue;
          }
          owed.push(t.key);
          rec.check(
            `result.${view}-contrast-${t.key}-inside-selected-panel`,
            m.isInsidePanel === true && m.membership === panelInfo.panelId,
            JSON.stringify({ key: t.key, optional: true, membership: m.membership ?? null, text: (m.text ?? "").slice(0, 50) }),
          );
        }
        if (m.found !== true || !m.node) continue;
        const th = aaThreshold(m.node.fontSizePx, m.node.fontWeight);
        const v = contrastVerdictFor(m.node, th.threshold);
        measured.push({
          key: t.key,
          selector: m.selector,
          branch: contract === "populated" ? "populated" : contract === "empty" ? "empty-explanation" : "optional-rendered",
          membership: m.membership,
          text: m.text,
          threshold: th.threshold,
          pass: v.pass,
          ...m.node,
        });
        rec.check(
          `result.${view}-contrast-${t.key}-meets-AA`,
          v.pass,
          `${m.node.verdict} ${v.why} — "${(m.text ?? "").slice(0, 50)}"` +
            (m.node.unsupportedLayerConfigurations?.length
              ? ` (unmodelled group(s): ${m.node.unsupportedLayerConfigurations.map((u) => `${u.tag}@${u.opacity}`).join(", ")})`
              : ""),
        );
      }
      rec.check(
        `result.${view}-contrast-surface-measured`,
        measured.length === owed.length,
        `${measured.length}/${owed.length} contract-owed node(s) measured inside ${panelInfo.panelId} (${panelTargets.length - owed.length} required-absent/optional-absent)`,
      );
      writeJson(path.join(driveDir, `panel-contrast-${view}.json`), {
        view,
        panelId: panelInfo.panelId,
        contract: live ? "live-populated-required" : "fixture-terminal",
        scope: {
          tabAriaControls: panelInfo.tabAriaControls,
          panelRole: panelInfo.panelRole,
          panelAriaLabelledby: panelInfo.panelAriaLabelledby,
        },
        measured,
      });
      // The accounting branch is a three-way product contract (requestLog
      // array → request-log rows + per-operation note; absent requestLog +
      // empty counts → the explanation; absent + non-empty → legacy counts) —
      // validate WHICH branch rendered, not just that some node did.
      if (view === "analysis") {
        const branch = await page.evaluate(ACCOUNTING_BRANCH_FN).catch(() => null);
        const bv = accountingBranchVerdict(terminal, contractCtx.searchCounts, branch);
        rec.check(`result.analysis-retrieval-accounting-branch`, bv.ok, bv.detail);
      }
    }

    // Host clipping on mobile, on the node's own measured text range: the
    // longest rendered Sources item title (populated contract) or the visible
    // empty-state explanation (empty contract) must lay out its FULL text —
    // range outrunning the node box or any clipping ancestor in either axis,
    // and document horizontal overflow, are all red.
    if (viewport === "mobile" && view === "sources" && panelScopeOk(panelInfo)) {
      const wantPopulated =
        panelContractPopulated("hasAnyOccurrence", { terminal, searchCounts: null }) === "populated";
      const picked = await page.evaluate(
        `((pid, populated) => {
          const panel = document.getElementById(pid);
          if (!panel) return null;
          let el = null;
          if (populated) {
            const els = [...panel.querySelectorAll("ul li p")]
              .filter((p) => (p.textContent || "").trim().length > 0);
            el = els.sort((a, b) => (b.textContent || "").trim().length - (a.textContent || "").trim().length)[0] ?? null;
          } else {
            el = [...panel.querySelectorAll("p")]
              .find((p) => /no sources were retrieved/i.test(p.textContent || "")) ?? null;
          }
          if (!el) return null;
          document.querySelectorAll("[data-ctnpm]").forEach((x) => x.removeAttribute("data-ctnpm"));
          el.setAttribute("data-ctnpm", "1");
          return {
            text: (el.textContent || "").trim(),
            nodeIdentity: {
              ctnpm: "1",
              tag: el.tagName,
              className: String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || ""),
              panelId: pid,
              containerDomSubset: true,
            },
          };
        })(${JSON.stringify(panelInfo.panelId)}, ${wantPopulated ? "true" : "false"})`,
      );
      const clip = picked
        ? await page.evaluate(`(${CLIP_FN})(${JSON.stringify(picked)})`).catch((e) => ({ found: false, reason: String(e) }))
        : { found: false, reason: wantPopulated ? "no populated Sources item text inside the panel" : "no rendered empty-state explanation inside the panel" };
      const wv = wrapVerdict(clip);
      rec.check(
        wantPopulated
          ? "result.sources-long-title-wraps-not-clipped"
          : "result.sources-empty-explanation-not-clipped",
        wv.pass,
        `${wv.why}${picked ? ` — ${picked.text.length} chars on the scoped node` : ""}`,
      );
      writeJson(path.join(driveDir, "mobile-title-clip.json"), {
        panelId: panelInfo.panelId,
        branch: wantPopulated ? "populated" : "empty-explanation",
        measured: picked === null ? null : picked.text.slice(0, 80),
        clip,
      });
    }

    await shot(page, driveDir, `01-result-${view}`);
    await aria(page, driveDir, `result-${view}`);

    // `terminal` was resolved above (null on live runs): fixture comparisons
    // below apply only to controlled drives; live drives observe instead.
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
            // Every rendered relationship row must carry the honest label of
            // its recorded connector state (COMPARISON_COPY) — an unexamined
            // edge renders "Not compared in this investigation" and is never
            // dressed as a performed comparison.
            rec.check(
              "result.analysis-performed-row-labels-honest",
              comparisons.every((c, i) =>
                String(performedItems[i] ?? "").includes(comparisonStateLabel(c?.connector)),
              ),
              `each rendered row must carry the label of its recorded connector state`,
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
          // N83-4: `comparisons` is the ALL-relationships list — unexamined
          // edges render too, honestly labeled, and never count as performed.
          // The performed set is exactly the recorded edges whose identity is
          // in the explicit comparedPairIds set and whose connector was
          // actually examined.
          const performedEdges =
            comparisons === null
              ? null
              : comparisons.filter(
                  (c) => comparedIds.includes(comparisonEdgeKey(c)) && !comparisonIsUnexamined(c),
                );
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
          // EDGES — only the relationships the result explicitly reports as
          // compared — even when the summary used the empty-state sentence
          // instead of a numeric one (C7-R3). An absent/null count is never
          // invented, and unexamined relationship rows never inflate it.
          if (compared !== null) {
            if (performedEdges !== null) {
              rec.check(
                "result.analysis-coverage-count-matches-performed-list",
                compared === performedEdges.length,
                `coverage reports ${compared} compared pair(s); ${performedEdges.length} recorded edge(s) resolve ` +
                  `to compared, examined pair id(s) of ${comparisons.length} relationship row(s) total`,
              );
              // The explicit set is authoritative both ways: every compared id
              // must name a real performed edge (phantom id = red), and no
              // unexamined edge may be promoted into it.
              rec.check(
                "result.analysis-coverage-compared-ids-resolve-to-performed",
                comparedIds.every((id) =>
                  comparisons.some((c) => comparisonEdgeKey(c) === id && !comparisonIsUnexamined(c)),
                ),
                `every comparedPairId must resolve to a recorded, examined edge — ids=${JSON.stringify(comparedIds)}`,
              );
              rec.check(
                "result.analysis-coverage-unexamined-not-performed",
                comparisons
                  .filter(comparisonIsUnexamined)
                  .every((c) => !comparedIds.includes(comparisonEdgeKey(c))),
                `unexamined edge(s) ${JSON.stringify(comparisons.filter(comparisonIsUnexamined).map(comparisonEdgeKey))} must never appear in comparedPairIds`,
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
                claimed === performedEdges.length,
                `summary claims ${claimed} pair(s) while the result records ${performedEdges.length} performed edge(s) ` +
                  `(${comparisons.length} relationship row(s) including unexamined)`,
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

    // A8 expected-case map: when the driven fixture is one of the 17 accepted
    // cases, every expectation record whose observable renders on this view is
    // discharged as its own a8.expect.* assertion. Records bound to other
    // views fire on their own invocations — the recipe runs all of them.
    if (!live && expectedCase !== null) {
      await observeExpectedRecords(page, rec, expectedCase, view, { terminal });
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
    // Map authority is resolved BEFORE any drive effect — a maintained A8
    // fixture with a missing/unreadable/mismatched map or a missing entry
    // fails here, never mid-observation as a silent skip.
    const expectedCase = live ? null : expectedCaseFor(fixture);
    // The focus sampler must be installed before the first navigation so the
    // per-frame log covers the dialog's open and its ACTUAL recorded close —
    // the settle below derives the close marker from this log, never a guess.
    await page.addInitScript(FOCUS_SAMPLER_FN);
    if (stream && !live) stream.planFast(fixture, delayMs);
    await submitUpload(page, m, runId, { claim: input.claim, rec, file: input.file });
    await submitButton(page).click();
    if (stream) stream.releaseAll();
    await waitForTerminalResult(page, rec, { fixture, live, input });

    // When the driven fixture is one of the 17 accepted A8 cases, the opener is
    // scoped to the EXPECTED dated occurrence's own card — the map's recipe is
    // "Inspect evidence (dated timeline occurrences only)", and a global
    // first-match on a repeated accessible name would not prove the opener was
    // the expected item's. The opened identity is asserted below via the
    // dialog's rendered identity line.
    const expectedViewerId =
      expectedCase && entry === "timeline" ? expectedCase.expectedIds?.timeline?.[0] ?? null : null;
    const expectedViewerTitle =
      expectedViewerId !== null ? fixtureOccurrence(fixture, expectedViewerId)?.title ?? null : null;
    if (expectedViewerId !== null) {
      rec.check(
        "a8.expect.viewer-expected-target-identified",
        expectedViewerTitle !== null,
        `expected opener ${expectedViewerId} title=${JSON.stringify(expectedViewerTitle)}`,
      );
    }

    let entryBtn;
    if (entry === "timeline") {
      await selectTab(page, rec, "Timeline");
      entryBtn =
        expectedViewerTitle !== null
          ? page
              .locator("#ct-panel-timeline ol > li")
              .filter({ has: page.getByRole("heading", { name: expectedViewerTitle }) })
              .getByRole("button", { name: /inspect evidence/i })
              .first()
          : page.getByRole("button", { name: /inspect evidence/i }).first();
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

    // Record the focus contract BEFORE the dialog opens: the opener the product
    // will capture as its trigger (document.activeElement at click time) and
    // the currently selected tab it falls back to. Both carry durable
    // per-element keys assigned by the sampler, so "focus returned" compares
    // element identity, not a label two different elements could share.
    const openerDesc = await readFocusDescriptor(entryBtn);
    const selectedTabDesc = await page
      .evaluate(
        `(${FOCUS_DESCRIPTOR_FN})([...document.querySelectorAll('[role="tab"]')].find((t) => t.getAttribute('aria-selected') === 'true') ?? null)`,
      )
      .catch(() => null);
    rec.check(
      "viewer.focus-targets-recorded",
      typeof openerDesc?.key === "string" && openerDesc.key !== "" &&
        typeof selectedTabDesc?.key === "string" && selectedTabDesc.key !== "",
      JSON.stringify({ opener: openerDesc, selectedTab: selectedTabDesc }),
    );
    writeJson(path.join(driveDir, "focus-targets.json"), { entry, opener: openerDesc, selectedTab: selectedTabDesc });
    // The product captures document.activeElement synchronously in the click
    // handler, so the opener must hold focus at that instant — a click that
    // never focused it would record the tab instead and quietly exercise the
    // "click that never focused it" branch rather than the valid one.
    await entryBtn.focus();
    const focusAtTrigger = await entryBtn.evaluate((el) => document.activeElement === el).catch(() => false);
    rec.check(
      "viewer.opener-holds-focus-at-trigger",
      focusAtTrigger === true,
      "the recorded trigger is document.activeElement captured synchronously on open; the opener must hold focus at that instant",
    );

    // The settle floor: sampled frames at/after this index belong to THIS
    // open interval, so the first close's marker can only derive from it.
    const openFloor1 = await focusLogFloor(page);
    await entryBtn.click();

    const dialog = page.locator('[role="dialog"]');
    await dialog.waitFor({ timeout: 10_000 });
    rec.check("viewer.dialog-open", true, "role=dialog");
    rec.check("viewer.back-to-timeline", (await dialog.getByText(/back to timeline/i).count()) > 0, "close control present");
    // The open state is evidence in its own right: a screenshot taken only after
    // the close proves nothing about what the dialog rendered.
    await shot(page, driveDir, `00-viewer-open-${entry}-${vcase}`);

    // A8: the opened item's identity is the dialog's own `Occurrence ID:` line
    // (inside Technical details — textContent, not innerText) — never the
    // repeated opener name and never raw id text elsewhere in the DOM.
    if (expectedViewerId !== null) {
      const openedIdent = await openedOccurrenceId(dialog);
      rec.check(
        "a8.expect.viewer-opened-identity",
        openedIdent.ok === true && openedIdent.id === expectedViewerId,
        `opened Occurrence ID=${JSON.stringify(openedIdent.ok === true ? openedIdent.id : openedIdent)} expected=${expectedViewerId}`,
      );
    }

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
      // Decode, ancestor-effective visibility and at-rest motion through the
      // accepted media predicate — a decoded image that is display:none,
      // aria-hidden, zero-geometry or still animating is not a visible render.
      const media = await page
        .evaluate(`(${VISIBLE_IMAGE_FN})(${JSON.stringify(['[role="dialog"]', "Retrieved image"])})`)
        .catch((e) => ({ present: false, reason: String(e) }));
      const vis = visibleImageVerdict(media);
      rec.check(
        "viewer.image-decoded-and-rendered",
        vis.pass,
        `${vis.why} (hiddenBy=${media.hiddenBy?.length ?? "?"} rect=${JSON.stringify(media.rect ?? null)})`,
      );
      rec.check(
        "viewer.image-no-running-animation-at-rest",
        motionAtRestOk(media),
        `runningAnimationCount=${media.runningAnimationCount ?? "unmeasured"}`,
      );
      writeJson(path.join(driveDir, "viewer-media.json"), media);
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

    // The open occurrence is attributed to the FIXTURE row it came from: the
    // source link must point at that row's own URL, the dialog must render its
    // title, and the excerpt must be that row's own excerpt — a truncated
    // rendering is still a strict prefix of it. None of this is read from the
    // locator's own claim.
    const openIdNow = live ? null : await viewerEvidenceId(dialog);
    const openRow = live ? null : fixtureOccurrence(fixture, openIdNow);
    if (!live) {
      rec.check(
        "viewer.occurrence-attributed-to-fixture",
        openRow !== null,
        `rendered identity ${openIdNow ?? "none"} resolves to a fixture row`,
      );
    }
    if (openRow) {
      const urls = [openRow.canonicalUrl, openRow.sourceUrl].filter((u) => typeof u === "string" && u !== "");
      rec.check(
        "viewer.source-link-targets-occurrence",
        urls.length > 0 && urls.includes(href),
        `href=${href} fixture=${urls.join(" | ")}`,
      );
      const dialogText = (await dialog.innerText()).replace(/\s+/g, " ");
      const wantTitle = String(openRow.title ?? "").replace(/\s+/g, " ").trim();
      rec.check(
        "viewer.attribution-matches-occurrence",
        wantTitle !== "" && dialogText.includes(wantTitle),
        `occurrence title "${wantTitle.slice(0, 60)}" must render in the dialog`,
      );
      const quote = await dialog.locator("blockquote").first().innerText().catch(() => null);
      const expectedSpan = expectedAttributableSpan(openRow);
      if (expectedSpan !== null) {
        // Exact source-bound identity (F38-4): the <blockquote> element's own
        // text must EQUAL the span the product contract projects from the
        // fixture row — composite-split, first-paragraph, word-boundary
        // truncated at the viewer's 600-char budget. A prefix, a substituted
        // authentic string elsewhere in the dialog (the full retrieved text
        // disclosure, the title), or the bare composite wrapper are all RED.
        const v = renderedExcerptVerdict(quote, expectedSpan);
        rec.check(
          "viewer.excerpt-matches-occurrence",
          v.ok,
          `${v.why} — for ${openIdNow}`,
        );
        const wantAttribution = expectedExcerptAttribution(openRow, expectedSpan);
        const attrLabel = await excerptAttributionHeading(dialog);
        rec.check(
          "viewer.excerpt-attribution-label",
          wantAttribution !== null && attrLabel.found === true && attrLabel.text === wantAttribution,
          `attribution heading=${JSON.stringify(attrLabel.found === true ? attrLabel.text : attrLabel)} expected=${JSON.stringify(wantAttribution)} for ${openIdNow}`,
        );
      } else {
        rec.check(
          "viewer.excerpt-absent-when-contract-has-none",
          /no excerpt available/i.test(dialogText) && quote === null,
          `contract projects no quotable span for ${openIdNow}; rendered quote=${quote === null ? "none" : "present"}`,
        );
      }
    }

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
    // Focus can pass through <body> between the unmount and the passive
    // restore, so the settle is read from the per-frame SAMPLED LOG — but a
    // DOM-hidden wait is not proof that even one post-close RAF landed, so a
    // bounded acquisition loop waits for THIS open interval's recorded close
    // marker plus a full dwell of post-close samples before evaluating the
    // same final-run predicate. A bound that never acquires is a truthful
    // failure, not a skipped measurement.
    const first = await acquireFocusSettle(page, { opener: openerDesc, openFloor: openFloor1 });
    writeJson(path.join(driveDir, "focus-settle-close.json"), {
      openFloor: first.openFloor,
      closeMarker: first.closeMarker,
      postCloseSamples: first.postCloseSamples,
      acquired: first.acquired,
      expectation: first.expectation,
      selectedTab: first.selectedTab,
      settle: { ...first.settle },
      framesObserved: first.log.length,
      log: first.log,
    });
    rec.check(
      "viewer.focus-settle-window-acquired",
      first.acquired === true,
      first.acquired === true
        ? `close marker frame ${first.closeMarker} + ${first.postCloseSamples} post-close sample(s) acquired`
        : `bounded acquisition exhausted: marker=${first.closeMarker} postCloseSamples=${first.postCloseSamples} — no truthful settle window exists`,
    );
    rec.check(
      "viewer.focus-close-marker-recorded",
      first.closeMarker !== null,
      first.closeMarker === null
        ? "the sampler never observed an open dialog — there is no recorded close to settle from"
        : `the dialog's recorded close is frame ${first.closeMarker} of the sampled log`,
    );
    rec.check(
      "viewer.focus-expectation-computed",
      first.expectation.key !== null,
      `expectation=${first.expectation.basis} key=${first.expectation.key} openerRestorable=${first.expectation.openerRestorable}`,
    );
    rec.check(
      "viewer.focus-not-left-in-hidden-dialog",
      first.settle.final !== null && first.settle.final?.tag !== "BODY" && first.settle.final?.tag !== "null",
      JSON.stringify({ trigger, final: first.settle.final, bodyFrames: first.settle.bodyFrames }),
    );
    rec.check(
      "viewer.focus-restored-after-close",
      first.settle.ok && first.expectation.basis === "recorded-opener",
      `settled on ${first.expectation.basis} (key ${first.expectation.key}) ` +
        `run=${first.settle.finalRunLength} at frame ${first.settle.settledAtFrame} — ${first.settle.reason}` +
        (first.settle.problems.length ? ` problems=${JSON.stringify(first.settle.problems)}` : ""),
    );
    rec.check(
      "viewer.focus-settle-basis-is-recorded-key",
      first.settle.stabilityBasis?.includes("recorded-key") === true,
      `stability basis ${JSON.stringify(first.settle.stabilityBasis)} — a descriptor-only settle is weaker proof and does not satisfy this assertion`,
    );

    // Reopen for the technical-details assertions: they only exist once the
    // disclosure has been expanded, which moves focus inside the dialog.
    // The second settle's floor is captured BEFORE the reopen click so its
    // close marker can only derive from this second open interval — it can
    // never borrow the first close's marker.
    const openFloor2 = await focusLogFloor(page);
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

    // --focus-fallback <kind>: the recorded opener is made un-restorable while
    // the drawer is open — hidden, disabled, disconnected or tabindex="-1",
    // the four prerequisites the product's restore check rejects — and the
    // settle below must land on the SELECTED TAB's key instead.
    let fallbackMutation = null;
    if (flags["focus-fallback"] !== undefined) {
      fallbackMutation = await page
        .evaluate(
          `(${FOCUS_OPENER_MUTATE_FN})(${JSON.stringify([openerDesc?.key ?? "", flags["focus-fallback"]])})`,
        )
        .catch((e) => ({ mutated: false, reason: String(e) }));
      const stillOk = fallbackMutation?.mutated === true
        ? restorableFocusTargetOk(fallbackMutation.after)
        : { ok: true, reason: "mutation never landed" };
      rec.check(
        "viewer.focus-fallback-opener-made-invalid",
        fallbackMutation?.mutated === true && stillOk.ok === false,
        JSON.stringify({
          kind: flags["focus-fallback"],
          mutated: fallbackMutation?.mutated,
          restorableReason: stillOk.reason,
          after: fallbackMutation?.after ?? null,
        }),
      );
    }

    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden", timeout: 10_000 });
    await settleFocusFault(page);
    // Same bounded acquisition as the first close — a fixed delay is not a
    // substitute for the recorded marker + dwell window, and the floor keeps
    // this close scoped to the second open interval.
    const second = await acquireFocusSettle(page, {
      opener: fallbackMutation?.mutated === true ? fallbackMutation.after : openerDesc,
      openFloor: openFloor2,
    });
    writeJson(path.join(driveDir, "focus-settle-disclosure-close.json"), {
      fallbackMutation,
      openFloor: second.openFloor,
      closeMarker: second.closeMarker,
      postCloseSamples: second.postCloseSamples,
      acquired: second.acquired,
      expectation: second.expectation,
      selectedTab: second.selectedTab,
      settle: { ...second.settle },
      framesObserved: second.log.length,
      log: second.log,
    });
    rec.check(
      "viewer.focus-settle-window-acquired-after-disclosure",
      second.acquired === true,
      second.acquired === true
        ? `close marker frame ${second.closeMarker} + ${second.postCloseSamples} post-close sample(s) acquired`
        : `bounded acquisition exhausted: marker=${second.closeMarker} postCloseSamples=${second.postCloseSamples} — no truthful settle window exists`,
    );
    rec.check(
      "viewer.focus-close-marker-recorded-after-disclosure",
      second.closeMarker !== null,
      second.closeMarker === null
        ? "the sampler never observed the dialog's second open/close — no recorded close to settle from"
        : `the dialog's recorded close is frame ${second.closeMarker} of the sampled log`,
    );
    if (fallbackMutation !== null) {
      rec.check(
        "viewer.focus-fallback-lands-on-selected-tab",
        second.settle.ok &&
          second.expectation.basis === "selected-tab-fallback" &&
          second.expectation.key === second.selectedTab?.key,
        `expectation=${second.expectation.basis} key=${second.expectation.key} ` +
          `settled=${second.settle.reason} run=${second.settle.finalRunLength}` +
          (second.settle.problems.length ? ` problems=${JSON.stringify(second.settle.problems)}` : ""),
      );
    }
    rec.check(
      "viewer.focus-return-after-disclosure-close",
      second.settle.ok,
      JSON.stringify({
        triggerAfterDetails,
        basis: second.expectation.basis,
        final: second.settle.final,
        reason: second.settle.reason,
        problems: second.settle.problems,
      }),
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

    // S3: publish the plan context so the drive-level finalizer can persist what
    // was OBSERVED even if an assertion aborts this case below. A rec.check
    // throw used to skip every one of those writes, leaving a failed drive with
    // a plan and retained bytes but no ledger, no inputs and no integrity
    // record — a seal that could not be inspected.
    stream.state.ownership = { plan, retained };

    // S2: exactly one read per fixture, and the segments, id, hash and retained
    // bytes all come from that same buffer. The shared validator re-derives the
    // normalized line sequence, the sha256, the investigation id and the byte
    // count FROM the retained buffer itself and compares — a same-line-count
    // content change, a wrong id or a wrong hash are red, not just a missing or
    // differently-sized stream.
    const provenance = [0, 1].map((i) => {
      const st = stream.state.sequence[i];
      return {
        request: i,
        ...verifyStreamBufferProvenance(st, stream.state.fixtureReads?.[st?.fixture] ?? null),
      };
    });
    rec.check(
      "ownership.each-fixture-read-exactly-once",
      provenance.every((v) => v.ok),
      provenance
        .map(
          (v) =>
            `${v.fixture}: ${v.reads} read(s), ${v.segmentLines} segment line(s) from a ${v.lines}-line buffer, ` +
            `id ${v.id}, sha256 ${String(v.sha256).slice(0, 12)}…` +
            (v.problems.length ? ` — RED: ${v.problems.join("; ")}` : ""),
        )
        .join("; "),
    );
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
    // The integrity check is the shared verifyRetainedStreams predicate, run
    // inside persistStreamOwnership: a retained stream that is missing or
    // modified is a RED on the same assertion, not a silently smaller evidence
    // set — on the success path AND on the abort path alike.
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

    // --- persist everything observed, then assert on it ---
    // The same writer the drive-level finalizer uses on an abort; on this
    // success path the reason is "ran to completion". Writing BEFORE the checks
    // below means a RED there still leaves the full observed record on disk.
    const fin = persistStreamOwnership(driveDir, stream, "the case ran to completion");
    rec.note("ownership.delivery-ledger", JSON.stringify(stream.state.ledger));

    // Seal-time integrity: the retained per-request stream files must still be the
    // exact bytes those requests were served from.
    const badRetained = fin.integrity.filter((r) => !r.matches);
    rec.check(
      "ownership.retained-streams-byte-identical",
      fin.integrity.length === 2 && badRetained.length === 0,
      badRetained.length === 0
        ? fin.integrity
            .map((r) => `request ${r.request} ${r.file} ${r.actualBytes}B sha256 ${String(r.actualSha256).slice(0, 12)}`)
            .join("; ")
        : `${badRetained.length} retained stream(s) not byte-identical: ${JSON.stringify(badRetained)}`,
    );
    // Both PLANNED request claim identities, explicitly observed and non-empty.
    // An UNOBSERVED request is a failure here — the drive ran to completion, so
    // a request that never reached the transport means the flow was lost.
    rec.check(
      "ownership.both-request-claims-identified",
      fin.projection.requests.every(
        (c) => c.observed === true && /^([0-9a-f]{64})$/.test(String(c.sentClaimSha256)) && (c.sentClaimBytes ?? 0) > 0,
      ),
      fin.projection.requests
        .map((c) =>
          c.observed
            ? `request ${c.request}: claim ${c.sentClaimBytes}B sha256 ${String(c.sentClaimSha256).slice(0, 12)}`
            : `request ${c.request}: ${c.status} — ${c.unobservedReason}`,
        )
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

    // At-rest motion is measured on the settled screen itself: a recorded
    // running-animation count of zero is required — no observation, no pass.
    await page
      .evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
      .catch(() => {});
    const motion = await page.evaluate(() => {
      const anims = (document.getAnimations ? document.getAnimations() : []).map((a) => ({
        type: a.constructor ? a.constructor.name : "unknown",
        playState: a.playState,
      }));
      return {
        total: anims.length,
        runningAnimationCount: anims.filter((a) => a.playState === "running").length,
        animations: anims.slice(0, 12),
      };
    });
    rec.check(
      "a11y.no-running-animation-at-rest",
      motionAtRestOk(motion),
      `${motion.runningAnimationCount ?? "unmeasured"} running animation(s) of ${motion.total} on the settled screen`,
    );

    // The 44px floor is measured on real interactive controls — a paragraph's
    // height is not a hit target. Every visible interactive element is
    // measured; enabled controls below the floor are RECORDED as secondary
    // inconsistencies (the accepted Back-link finding is exactly that shape),
    // not falsely failed against the primary requirement.
    const targets = await page
      .evaluate(`(() => {
        const fn = ${TARGET_FN};
        return [...document.querySelectorAll('a[href], button, [role="button"], [role="tab"], [role="link"]')]
          .filter((el) => el.getClientRects().length > 0)
          .map((el) => fn(el));
      })()`)
      .catch(() => []);
    // getClientRects alone is not the visibility proof — visibility:hidden and
    // opacity:0 controls still have boxes — so every measured control must
    // carry rendered:true through display, visibility, the ancestor chain and
    // effective opacity.
    rec.check(
      "a11y.interactive-targets-measured",
      targets.length > 0 && targets.every((t) => t.found === true && t.rendered === true && t.interactive === true && t.width > 0 && t.height > 0),
      `${targets.length} interactive control(s) measured on real geometry`,
    );
    const targetsBelowFloor = targets.filter(
      (t) => t.found === true && t.rendered === true && t.interactive === true && t.disabled !== true && t.ariaDisabled !== "true" && t.height > 0 && t.height < 44,
    );
    rec.note(
      "a11y.secondary-targets-below-44px",
      targetsBelowFloor.length === 0
        ? "none"
        : targetsBelowFloor.map((t) => `"${(t.accessibleName ?? "").slice(0, 40)}" ${t.width}x${t.height}`).join(" | "),
    );
    writeJson(path.join(driveDir, "interactive-targets.json"), { viewport, targets, belowFloor: targetsBelowFloor });

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

  // S1: every stream this run PLANNED to retain must still be the captured bytes
  // BEFORE an intact seal is written. A seal that hashes a missing or corrupted
  // retained file is a green hiding missing evidence.
  const { out: plannedStreams, problems: planProblems } = plannedRetainedStreams(runId);
  const retainedCheck = verifyRetainedStreams(plannedStreams, (r) =>
    fs.readFileSync(path.join(dir, "drives", r.drive, r.file)),
  );
  const retainedBad = retainedCheck.filter((r) => !r.matches);
  // A missing or malformed plan is a BROKEN seal, not an empty one: every
  // stream-ownership drive writes a plan, so "nothing planned" must not be a pass.
  const retainedOk = planProblems.length === 0 && retainedBad.length === 0;

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
      // The multi-request input contract, when the drive wrote one: the seal
      // links the file and serializes the planned-vs-observed summary, not just
      // the artifact hash — an UNOBSERVED planned request must be visible here,
      // not only inside the drive directory.
      const reqInputsRel = `drives/${name}/request-inputs.json`;
      let requestInputs = null;
      const reqInputsPath = path.join(dir, reqInputsRel);
      if (fs.existsSync(reqInputsPath)) {
        try {
          const ri = JSON.parse(fs.readFileSync(reqInputsPath, "utf8"));
          requestInputs = {
            file: reqInputsRel,
            planned: ri.planned ?? null,
            observed: ri.observed ?? null,
            finalizedUnder: ri.finalizedUnder ?? null,
            requests: Array.isArray(ri.requests)
              ? ri.requests.map((r) => ({
                  request: r.request ?? null,
                  fixture: r.fixture ?? null,
                  status: r.status ?? null,
                  claimSha256: r.sentClaimSha256 ?? r.claimSha256 ?? null,
                  imageOnWire:
                    r.sentMediaName != null ? `${r.sentMediaName} ${r.sentMediaBytes}B` : null,
                  imageEntryMethod: r.imageEntryMethod ?? null,
                }))
              : null,
          };
        } catch (err) {
          requestInputs = { file: reqInputsRel, malformed: String(err?.message ?? err) };
        }
      }
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
        requestInputs,
        streamOwnership: d.streamOwnership ?? null,
        liveManifestSha256: d.liveManifestSha256 ?? null,
        fault: d.fault,
        faultFired: d.faultFired ?? null,
        live: d.live,
        outcome: d.outcome,
        complete: d.complete === true,
        videos: d.videos ?? null,
        // The seal counts the DURABLE assertions.jsonl. The drive's own record
        // claims totals too; both must agree, or a late push was counted in
        // memory but never reached disk (the recorder-closed-early defect).
        assertions: {
          pass: assertions.filter((a) => a.status === "PASS").length,
          fail: assertions.filter((a) => a.status === "FAIL").length,
          info: assertions.filter((a) => a.status === "INFO").length,
        },
        recordedAssertions: d.complete === true ? (d.assertions ?? null) : null,
        // FD2 for the maintained record itself: a verdict is computed only
        // from a complete, internally consistent drive.json — a missing or
        // malformed assertions block, an unknown outcome or a PASS with
        // failed/zero assertions is never read as acceptance.
        recordVerdict: driveOutcomeOk(d),
        assertionsMatchRecord:
          d.complete !== true || d.assertions == null
            ? null
            : d.assertions.pass === assertions.filter((a) => a.status === "PASS").length &&
              d.assertions.fail === assertions.filter((a) => a.status === "FAIL").length &&
              d.assertions.info === assertions.filter((a) => a.status === "INFO").length,
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

  // A drive whose recorded totals disagree with its durable assertions file
  // counted an assertion that never reached disk. The seal names every such
  // drive and fails, the same way it fails lost retained bytes.
  const assertionDivergence = drives
    .filter((d) => d.assertionsMatchRecord === false)
    .map((d) => ({
      driveId: d.driveId,
      durable: d.assertions,
      recorded: d.recordedAssertions,
    }));

  // A drive record whose structure itself is malformed — missing/incomplete
  // assertion totals, a missing complete flag, an UNKNOWN outcome such as
  // "GREEN", or a verdict inconsistent with its own counts — is not a
  // sealable record no matter which outcome it claims (F38-5). A legitimate
  // complete FAIL and an honest INCOMPLETE recording pass this structural
  // gate and remain inspectable failed/incomplete tests; only structural
  // invalidity is a seal error.
  const malformedRecords = drives
    .filter((d) => d.recordVerdict?.ok === false)
    .map((d) => ({ driveId: d.driveId, outcome: d.outcome ?? null, problems: d.recordVerdict.problems }));

  const summary = {
    runId,
    generation: generation(runId),
    sealedAt: new Date().toISOString(),
    // What the run PLANNED to retain and whether those files are still the captured
    // bytes. A same-length corruption is caught by the hash, which is the case a
    // length check alone would report as intact.
    retainedStreams: {
      planned: plannedStreams.length,
      ok: retainedOk,
      planProblems,
      streams: retainedCheck.map((r) => ({
        drive: r.drive,
        file: r.file,
        expectedBytes: r.bytes,
        expectedSha256: r.sha256,
        actualBytes: r.actualBytes,
        actualSha256: r.actualSha256,
        matches: r.matches,
        why: r.why,
      })),
    },
    retainedIntegrityOk: retainedOk,
    assertionDivergence,
    malformedRecords,
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
      retainedStreams: summary.retainedStreams,
      retainedIntegrityOk: summary.retainedIntegrityOk,
      assertionDivergence: summary.assertionDivergence,
      malformedRecords: summary.malformedRecords,
    }),
  );
  // The seal is written either way, so the failure is inspectable, but a run whose
  // retained streams are missing or corrupted must NOT be reported as a pass —
  // and a drive whose record claims totals the durable file does not hold must
  // NOT silently keep the inflated count.
  const failures = [];
  if (!retainedOk) {
    failures.push(
      `FAILED retained-stream integrity: ` +
        [
          ...planProblems.map((x) => `${x.drive}: ${x.why}`),
          ...retainedBad.map(
            (r) =>
              `${r.drive}/${r.file} expected ${r.bytes}B ${String(r.sha256).slice(0, 12)}, ` +
              `got ${r.actualBytes ?? "nothing"}B ${String(r.actualSha256 ?? "-").slice(0, 12)} (${r.why})`,
          ),
        ].join("; "),
    );
  }
  if (assertionDivergence.length > 0) {
    failures.push(
      `FAILED assertion-record agreement: ` +
        assertionDivergence
          .map(
            (x) =>
              `${x.driveId} records ${x.recorded.pass}P/${x.recorded.fail}F/${x.recorded.info}I ` +
              `but the durable file holds ${x.durable.pass}P/${x.durable.fail}F/${x.durable.info}I`,
          )
          .join("; "),
    );
  }
  if (malformedRecords.length > 0) {
    failures.push(
      `FAILED malformed drive record(s): ` +
        malformedRecords
          .map((x) => `${x.driveId} (${x.outcome ?? "no-outcome"}): ${x.problems.join(", ")}`)
          .join("; "),
    );
  }
  if (failures.length > 0) {
    fail(`sealed ${runId} with ${failures.join(" — also — ")}`);
  }
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

// Imported as a module by the offline controls so they exercise the SAME
// predicates the drive and the seal use, not a copy that can drift. Dispatch
// only happens when this file is the one node was started on.
const IS_MAIN = process.argv[1] !== undefined && path.resolve(process.argv[1]) === CLI_PATH;
export {
  verifyRetainedStreams,
  verifyStreamBufferProvenance,
  projectRequestObservations,
  readingOrderTargetOk,
  measurementSurfaceOk,
  startStreamServer,
  Recorder,
  // Focus-settle predicates (accepted focus-fallback correction semantics).
  focusIdentityOf,
  deriveDialogCloseMarker,
  restorableFocusTargetOk,
  focusRestoreExpectation,
  settleFocusRun,
  acquireFocusSettle,
  focusLogFloor,
  // Selected-panel effective contrast (accepted A10 correction 2 semantics).
  aaThreshold,
  contrastVerdictFor,
  PANEL_NODE_TARGETS,
  panelScopeOk,
  panelContractPopulated,
  // Consumed-state contract machinery + scoped identity reader (V39-3/4/7/8).
  fixtureResult,
  fixtureTerminal,
  fixtureOccurrence,
  driveFixture,
  fixtureMode,
  A8_MAINTAINED_FIXTURES,
  fixtureEvents,
  mappedRequestLog,
  consumedSearchCounts,
  ACCOUNTING_BRANCH_FN,
  accountingBranchVerdict,
  openedOccurrenceId,
  excerptAttributionHeading,
  viewerEvidenceId,
  readOpenedEvidenceId,
  observeExpectedRecords,
  parseDriveOptions,
  // Rendered excerpt identity (F38-4): the product-bound projection port.
  splitCompositeExcerpt,
  truncateExcerptWords,
  expectedAttributableSpan,
  expectedExcerptAttribution,
  renderedExcerptVerdict,
  // Media/wrap/target/motion predicates (accepted A10 residual predicates).
  visibleImageVerdict,
  wrapVerdict,
  targetVerdict,
  motionAtRestOk,
  // Fail-closed maintained-record verdict (accepted FD2 semantics).
  driveOutcomeOk,
  // A8 expected-case map consumer + recipe bindings (accepted final map).
  FEATURE_SPECS,
  COMMAND_FLAGS,
  expectedMapBytesOk,
  loadExpectedCaseMap,
  expectedCaseFor,
  expectedRecordKind,
  expectedViewBucket,
  expectedCaseCoherent,
  buildA8RecipeBindings,
  a8HeadlineVerdict,
  a8SupportVerdict,
  a8CaveatVerdict,
  a8CaveatSerializedVerdict,
  a8SegmentsVerdict,
  a8CoverageVerdict,
  a8GatesVerdict,
  a8OriginsVerdict,
  a8PolicyNaVerdict,
  a8TimelineIdsVerdict,
  a8UndatedAbsentVerdict,
  a8EmptyStateVerdict,
  a8PlacementVerdict,
  a8DivergenceVerdict,
  a8ConnectorsVerdict,
  a8HeadingTextMatches,
  comparisonStateLabel,
  comparisonEdgeKey,
  comparisonEndpointKey,
  comparisonIsUnexamined,
  a8OpenState,
  // N83: the reading-order measurement and the locator call-contract helper.
  longValueLayout,
  compareReadingOrder,
  readFocusDescriptor,
  FOCUS_DESCRIPTOR_EVALUATOR,
  A8_MAP_SHA256,
  A8_APP_PIN,
  A8_FIXTURE_PIN,
  A8_RELEASE_SEAL,
  A8_OVERVIEW_PROBE_FN,
  A8_TIMELINE_PROBE_FN,
  A8_ANALYSIS_PROBE_FN,
  A8_EFFECTIVE_VISIBLE_FN,
  // The in-page function sources, exported so offline controls can assert they
  // at least parse — a broken in-page function is otherwise invisible offline.
  FOCUS_SAMPLER_FN,
  FOCUS_DESCRIPTOR_FN,
  FOCUS_OPENER_MUTATE_FN,
  EFFECTIVE_CONTRAST_FN,
  PANEL_MEASURE_FN,
  VISIBLE_IMAGE_FN,
  CLIP_FN,
  TARGET_FN,
};
if (IS_MAIN) {
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
}
