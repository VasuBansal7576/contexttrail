/**
 * Server-only, single-host live-use gate. No provider balance is queried here.
 * Allowances are operator-supplied limits, not a promise about provider billing.
 *
 * Every run permanently charges its worst-case allocation before any network
 * work. One exclusive lock is held until that work settles. A crash leaves the
 * lock and reservation in place; neither the API nor a restart resets them.
 * This is deliberately unsuitable for serverless or multiple independent disks.
 */
import { constants } from "node:fs";
import { open, readFile, realpath, stat, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { JEV_ENDPOINT, JEV_MAX_BYTES, JEV_MODEL } from "../jev/client";
import { evidenceQuestions } from "../jev/questions";
import { SERPAPI_IMAGE_UPLOAD_URL, SERPAPI_SEARCH_URL, SEARCH_MAX_BYTES, UPLOAD_MAX_BYTES } from "../serpapi/client";
import { ProviderError, readBodyCapped } from "../providers/http";
import {
  CLAIM_MAX_SEARCHES,
  TRACE_MAX_SEARCHES,
  MAX_IMAGE_UPLOAD_ATTEMPTS,
  MAX_JEV_CANDIDATES,
  MAX_DEEP_READ_PAGES,
  MAX_DIVERGENCE_OCCURRENCES,
} from "./limits";

export interface LiveAllowance {
  searches: number;
  uploads: number;
  jevRequests: number;
  jevQuestions: number;
}

export interface LiveUsageConfig {
  ledgerPath: string;
  period: string;
  allowance: LiveAllowance;
}

export class LiveUsageError extends Error {
  constructor(message: string, readonly code: "LIVE_USAGE_DISABLED" | "LIVE_USAGE_UNAVAILABLE" = "LIVE_USAGE_UNAVAILABLE") {
    super(message);
    this.name = "LiveUsageError";
  }
}

const STORAGE_ERROR = "Live usage storage is unavailable or invalid. No provider requests were authorized. The operator must inspect the persistent ledger and lock.";
const MAX_LEDGER_BYTES = 1_048_576;
const ALLOWANCE_KEYS = ["searches", "uploads", "jevRequests", "jevQuestions"] as const;
const SERVERLESS_MARKERS = [
  "VERCEL", "VERCEL_ENV", "NETLIFY", "AWS_LAMBDA_FUNCTION_NAME",
  "AWS_EXECUTION_ENV", "FUNCTIONS_WORKER_RUNTIME", "K_SERVICE", "CLOUD_RUN_JOB",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCap(raw: string | undefined): number {
  if (raw === undefined || !/^(0|[1-9]\d*)$/.test(raw)) {
    throw new LiveUsageError("Live use needs explicit, finite integer free-allowance limits for both providers.");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new LiveUsageError("Live use needs explicit, finite integer free-allowance limits for both providers.");
  }
  return value;
}

/** Reads only server environment. Request fields cannot choose quotas or model. */
export function readLiveUsageConfig(env: Readonly<Record<string, string | undefined>>): LiveUsageConfig {
  if (env.CONTEXTTRAIL_LIVE_ENABLED !== "true") {
    throw new LiveUsageError("Live investigations are disabled. This preview does not contact providers.", "LIVE_USAGE_DISABLED");
  }
  if (
    env.CONTEXTTRAIL_LIVE_DEPLOYMENT !== "single-host-persistent" ||
    SERVERLESS_MARKERS.some((key) => env[key] !== undefined)
  ) {
    throw new LiveUsageError("Live use requires one host with shared persistent local storage. Vercel and serverless live use are disabled until a shared durable atomic quota store is implemented.");
  }
  if (env.CONTEXTTRAIL_FREE_ALLOWANCE_ACKNOWLEDGED !== "true") {
    throw new LiveUsageError("The operator must confirm an available free allocation covering every configured usage unit. This application cannot verify provider balances or guarantee free billing.");
  }
  if (env.TYPESAFE_MODEL !== undefined && env.TYPESAFE_MODEL !== JEV_MODEL) {
    throw new LiveUsageError("Live use requires the pinned Jev model. Model overrides are disabled.");
  }
  const ledgerPath = env.CONTEXTTRAIL_USAGE_LEDGER_PATH;
  if (ledgerPath === undefined || !isAbsolute(ledgerPath) || ledgerPath !== resolve(ledgerPath)) {
    throw new LiveUsageError("Live use requires an absolute, normalized path to an existing persistent usage ledger.");
  }
  const period = env.CONTEXTTRAIL_FREE_ALLOWANCE_PERIOD;
  if (period === undefined || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(period)) {
    throw new LiveUsageError("Live use requires an explicit free-allocation period identifier. Periods never reset automatically.");
  }
  return {
    ledgerPath,
    period,
    allowance: {
      searches: parseCap(env.CONTEXTTRAIL_FREE_SERPAPI_SEARCHES),
      uploads: parseCap(env.CONTEXTTRAIL_FREE_SERPAPI_UPLOADS),
      jevRequests: parseCap(env.CONTEXTTRAIL_FREE_JEV_REQUESTS),
      jevQuestions: parseCap(env.CONTEXTTRAIL_FREE_JEV_QUESTIONS),
    },
  };
}

/**
 * run.ts has one initial batch, at most one adaptive batch (failed admitted
 * candidates may be retried), five page refinements, then seven adjacent pairs.
 * The conservative ceiling is 60 requests, not merely 24 distinct candidates.
 */
export function liveRunAllocation(claim: string | null, publicImage = false): LiveAllowance {
  const claimMode = claim !== null && claim.trim().length > 0;
  const evidenceCalls = 2 * MAX_JEV_CANDIDATES + MAX_DEEP_READ_PAGES;
  const pairwiseCalls = Math.max(0, MAX_DIVERGENCE_OCCURRENCES - 1);
  const questionsPerEvidence = Object.keys(evidenceQuestions({ claimMode, claimHasLocation: claimMode })).length;
  return {
    searches: claimMode ? CLAIM_MAX_SEARCHES : TRACE_MAX_SEARCHES,
    uploads: publicImage ? 0 : MAX_IMAGE_UPLOAD_ATTEMPTS,
    jevRequests: evidenceCalls + pairwiseCalls,
    jevQuestions: evidenceCalls * questionsPerEvidence + pairwiseCalls,
  };
}

/** Topic retrieval has a distinct fixed ceiling. No caller-supplied quota is accepted. */
export function topicRunAllocation(): LiveAllowance {
  return { searches: 6, uploads: 0, jevRequests: 12, jevQuestions: 60 };
}

/** Three sampled frame searches share one reservation and one provider counter. */
export function videoRunAllocation(claim: string | null): LiveAllowance {
  const frame = liveRunAllocation(claim);
  const speech = topicRunAllocation();
  return { searches: frame.searches * 3 + speech.searches, uploads: frame.uploads * 3, jevRequests: frame.jevRequests * 3 + speech.jevRequests, jevQuestions: frame.jevQuestions * 3 + speech.jevQuestions };
}

/** Existing reservations/grants keep their original charge; old topic allocations never authorize the expanded workflow. */
const LEGACY_TOPIC_ALLOCATION: LiveAllowance = { searches: 3, uploads: 0, jevRequests: 8, jevQuestions: 8 };
const PREVIOUS_VIDEO_ALLOCATIONS: LiveAllowance[] = [null, 'claim'].map(claim => { const frame = liveRunAllocation(claim); return { searches: frame.searches * 3, uploads: frame.uploads * 3, jevRequests: frame.jevRequests * 3, jevQuestions: frame.jevQuestions * 3 }; });
const PREVIOUS_TOPIC_ALLOCATION: LiveAllowance = { searches: 3, uploads: 0, jevRequests: 8, jevQuestions: 40 };

function validAllowance(value: unknown): value is LiveAllowance {
  return isRecord(value) && Object.keys(value).length === ALLOWANCE_KEYS.length &&
    ALLOWANCE_KEYS.every((key) => typeof value[key] === "number" && Number.isSafeInteger(value[key]) && value[key] >= 0);
}

function sameAllowance(a: LiveAllowance, b: LiveAllowance): boolean {
  return ALLOWANCE_KEYS.every((key) => a[key] === b[key]);
}

function withinAllowance(a: LiveAllowance, b: LiveAllowance): boolean {
  return ALLOWANCE_KEYS.every((key) => a[key] <= b[key]);
}

function validRunAllocation(value: unknown): value is LiveAllowance {
  return validAllowance(value) &&
    [liveRunAllocation(null), liveRunAllocation("claim"), liveRunAllocation(null, true), liveRunAllocation("claim", true), topicRunAllocation(), LEGACY_TOPIC_ALLOCATION, PREVIOUS_TOPIC_ALLOCATION, ...PREVIOUS_VIDEO_ALLOCATIONS, videoRunAllocation(null), videoRunAllocation('claim')]
      .some((allocation) => sameAllowance(value, allocation));
}

function parseLedger(raw: string, config: LiveUsageConfig): LiveAllowance {
  if (!raw.endsWith("\n")) throw new LiveUsageError(STORAGE_ERROR);
  const lines = raw.slice(0, -1).split("\n");
  const header: unknown = JSON.parse(lines[0]);
  if (!isRecord(header) || Object.keys(header).length !== 5 ||
    header.type !== "contexttrail-live-usage" || header.version !== 1 ||
    header.model !== JEV_MODEL || header.period !== config.period ||
    !validAllowance(header.allowance) || !withinAllowance(header.allowance, config.allowance)) {
    throw new LiveUsageError(STORAGE_ERROR);
  }
  const total: LiveAllowance = { searches: 0, uploads: 0, jevRequests: 0, jevQuestions: 0 };
  const effective = { ...header.allowance };
  const ids = new Set<string>();
  for (const line of lines.slice(1)) {
    const entry: unknown = JSON.parse(line);
    if (isRecord(entry) && entry.type === "grant") {
      if (Object.keys(entry).length !== 4 || typeof entry.id !== "string" || !/^[0-9a-f-]{36}$/.test(entry.id) || ids.has(entry.id) ||
          typeof entry.reason !== "string" || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(entry.reason) || !validAllowance(entry.allocation) ||
          ![liveRunAllocation(null, true),liveRunAllocation("claim", true), liveRunAllocation(null), liveRunAllocation("claim"), topicRunAllocation(), LEGACY_TOPIC_ALLOCATION, PREVIOUS_TOPIC_ALLOCATION, {searches:6,uploads:0,jevRequests:0,jevQuestions:0}].some((a) => sameAllowance(a, entry.allocation as LiveAllowance))) {
        throw new LiveUsageError(STORAGE_ERROR);
      }
      ids.add(entry.id);
      for (const key of ALLOWANCE_KEYS) {
        effective[key] += entry.allocation[key];
        if (!Number.isSafeInteger(effective[key]) || effective[key] > config.allowance[key]) throw new LiveUsageError(STORAGE_ERROR);
      }
      continue;
    }
    if (!isRecord(entry) || Object.keys(entry).length !== 3 || entry.type !== "reserve" ||
      typeof entry.id !== "string" || !/^[0-9a-f-]{36}$/.test(entry.id) || ids.has(entry.id) ||
      !validRunAllocation(entry.allocation)) {
      throw new LiveUsageError(STORAGE_ERROR);
    }
    ids.add(entry.id);
    for (const key of ALLOWANCE_KEYS) {
      total[key] += entry.allocation[key];
      if (!Number.isSafeInteger(total[key]) || total[key] > effective[key]) {
        throw new LiveUsageError(STORAGE_ERROR);
      }
    }
  }
  if (!sameAllowance(effective, config.allowance)) throw new LiveUsageError(STORAGE_ERROR);
  return total;
}

async function persistentLedgerPath(path: string): Promise<string> {
  const parent = await realpath(dirname(path));
  // Explicit operator attestation is still required: a filesystem pathname
  // alone cannot prove a mounted volume survives host replacement.
  if (["/tmp", "/var/tmp", "/dev", "/proc", "/sys", "/run"].some((root) => parent === root || parent.startsWith(`${root}/`))) {
    throw new LiveUsageError(STORAGE_ERROR);
  }
  if (join(parent, basename(path)) !== path) throw new LiveUsageError(STORAGE_ERROR);
  return parent;
}

interface OwnedLock {
  release(): Promise<void>;
}

async function acquireLock(path: string, parent: string): Promise<OwnedLock> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (isRecord(error) && error.code === "EEXIST") {
      throw new LiveUsageError("Another live investigation owns the usage lock, or a previous run stopped unexpectedly. Live use stays blocked until that run settles or the operator reconciles the lock.");
    }
    throw new LiveUsageError(STORAGE_ERROR);
  }
  const token = randomUUID();
  try {
    await handle.writeFile(token);
    await handle.sync();
    const directory = await open(parent, constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } catch {
    await handle.close();
    // Keep uncertain ownership on disk. Never silently heal or reset it.
    throw new LiveUsageError(STORAGE_ERROR);
  }
  let released = false;
  return {
    async release() {
      if (released) return;
      const [owned, current, contents] = await Promise.all([handle.stat(), stat(path), readFile(path, "utf8")]);
      if (owned.ino !== current.ino || owned.dev !== current.dev || contents !== token) {
        await handle.close();
        throw new LiveUsageError(STORAGE_ERROR);
      }
      await unlink(path);
      released = true;
      await handle.close();
    },
  };
}

/** Read-only admission snapshot. The run still reserves atomically at submission. */
export async function inspectLiveAllowance(config: LiveUsageConfig, allocation: LiveAllowance): Promise<'ready' | 'busy' | 'exhausted'> {
  await persistentLedgerPath(config.ledgerPath);
  try { await stat(`${config.ledgerPath}.lock`); return 'busy'; }
  catch (error) { if (!isRecord(error) || error.code !== 'ENOENT') throw new LiveUsageError(STORAGE_ERROR); }
  const ledger = await open(config.ledgerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await ledger.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size <= 0 || info.size > MAX_LEDGER_BYTES) throw new LiveUsageError(STORAGE_ERROR);
    const total = parseLedger(await ledger.readFile('utf8'), config);
    return ALLOWANCE_KEYS.some(key => allocation[key] > config.allowance[key] - total[key]) ? 'exhausted' : 'ready';
  } finally { await ledger.close(); }
}

export interface LiveRunLease {
  /** Provider requests are counted before dispatch, including failed attempts. */
  fetchFor(provider: "serpapi" | "jev", fetchImpl?: typeof fetch): typeof fetch;
  /** Call only after all provider work settles. No allocation is refunded. */
  release(): Promise<void>;
}

export async function reserveLiveRun(config: LiveUsageConfig, claim: string | null, signal?: AbortSignal, publicImage = false): Promise<LiveRunLease> {
  return reserveAllocation(config, liveRunAllocation(claim, publicImage), signal);
}

export async function reserveTopicRun(config: LiveUsageConfig, signal?: AbortSignal): Promise<LiveRunLease> {
  return reserveAllocation(config, topicRunAllocation(), signal);
}

export async function reserveVideoRun(config: LiveUsageConfig, claim: string | null, signal?: AbortSignal): Promise<LiveRunLease> {
  return reserveAllocation(config, videoRunAllocation(claim), signal);
}

async function reserveAllocation(config: LiveUsageConfig, allocation: LiveAllowance, signal?: AbortSignal): Promise<LiveRunLease> {
  let lock: OwnedLock | undefined;
  let ledger: FileHandle | undefined;
  let reservationWritten = false;
  try {
    if (signal?.aborted) throw new ProviderError("aborted", "Investigation cancelled before live admission");
    const parent = await persistentLedgerPath(config.ledgerPath);
    lock = await acquireLock(`${config.ledgerPath}.lock`, parent);
    ledger = await open(config.ledgerPath, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW);
    const info = await ledger.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size <= 0 || info.size > MAX_LEDGER_BYTES) throw new LiveUsageError(STORAGE_ERROR);
    const total = parseLedger(await ledger.readFile("utf8"), config);
    if (ALLOWANCE_KEYS.some((key) => allocation[key] > config.allowance[key] - total[key])) {
      throw new LiveUsageError("The configured free allocation cannot cover another worst-case investigation. No provider requests were authorized.");
    }
    if (signal?.aborted) throw new ProviderError("aborted", "Investigation cancelled before live admission");
    const entry = `${JSON.stringify({ type: "reserve", id: randomUUID(), allocation })}\n`;
    if (info.size + Buffer.byteLength(entry) > MAX_LEDGER_BYTES) throw new LiveUsageError(STORAGE_ERROR);
    // Once an append starts, any uncertainty preserves the lock for inspection.
    reservationWritten = true;
    await ledger.writeFile(entry);
    await ledger.sync();
    await ledger.close();
    ledger = undefined;
  } catch (error) {
    await ledger?.close().catch(() => undefined);
    if (!reservationWritten) await lock?.release().catch(() => undefined);
    if (error instanceof LiveUsageError || error instanceof ProviderError) throw error;
    throw new LiveUsageError(STORAGE_ERROR);
  }
  const ownedLock = lock;
  let closed = false;
  let releasePromise: Promise<void> | undefined;
  let inFlight = 0;
  const settled: Array<() => void> = [];
  const used: LiveAllowance = { searches: 0, uploads: 0, jevRequests: 0, jevQuestions: 0 };
  const consume = (delta: LiveAllowance) => {
    if (closed || signal?.aborted) throw new ProviderError("aborted", "Live investigation is closed or cancelled");
    if (ALLOWANCE_KEYS.some((key) => delta[key] > allocation[key] - used[key])) {
      throw new ProviderError("unconfigured", "Live investigation exceeded its reserved request or question allowance");
    }
    for (const key of ALLOWANCE_KEYS) used[key] += delta[key];
  };
  return {
    fetchFor(provider, fetchImpl = fetch) {
      return async (input, init) => {
        if (init?.signal?.aborted || (input instanceof Request && input.signal.aborted)) {
          throw new ProviderError("aborted", "Provider request cancelled before dispatch");
        }
        const url = new URL(input instanceof Request ? input.url : input.toString());
        const delta: LiveAllowance = { searches: 0, uploads: 0, jevRequests: 0, jevQuestions: 0 };
        if (provider === "serpapi" && url.origin + url.pathname === SERPAPI_SEARCH_URL) delta.searches = 1;
        else if (provider === "serpapi" && url.href === SERPAPI_IMAGE_UPLOAD_URL) delta.uploads = 1;
        else if (provider === "jev" && url.href === JEV_ENDPOINT && typeof init?.body === "string") {
          let payload: unknown;
          try { payload = JSON.parse(init.body); } catch { throw new ProviderError("unconfigured", "Invalid live Jev request"); }
          if (!isRecord(payload) || payload.model !== JEV_MODEL || !isRecord(payload.questions)) {
            throw new ProviderError("unconfigured", "Invalid live Jev model or questions");
          }
          delta.jevRequests = 1;
          delta.jevQuestions = Object.keys(payload.questions).length;
          if (delta.jevQuestions < 1 || delta.jevQuestions > 5) throw new ProviderError("unconfigured", "Invalid live Jev question count");
        } else throw new ProviderError("unconfigured", "Unexpected live provider endpoint");
        consume(delta);
        inFlight += 1;
        try {
          const response = await fetchImpl(input, { ...init, redirect: "error" });
          // fetch resolves at headers. Keep ownership through the whole bounded
          // body, including providers whose callers reject HTTP errors early.
          if (!response.ok) {
            await response.body?.cancel();
            return response;
          }
          if (response.body === null) return response;
          try {
            const maxBytes = provider === "jev" ? JEV_MAX_BYTES : delta.uploads > 0 ? UPLOAD_MAX_BYTES : SEARCH_MAX_BYTES;
            const body = await readBodyCapped(response, maxBytes, provider);
            return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
          } catch (error) {
            if (!response.body.locked) await response.body.cancel().catch(() => undefined);
            throw error;
          }
        } finally {
          inFlight -= 1;
          if (inFlight === 0) settled.splice(0).forEach((resolve) => resolve());
        }
      };
    },
    release() {
      if (releasePromise !== undefined) return releasePromise;
      closed = true;
      releasePromise = (async () => {
        if (inFlight > 0) await new Promise<void>((resolve) => settled.push(resolve));
        await ownedLock.release();
      })();
      return releasePromise;
    },
  };
}
