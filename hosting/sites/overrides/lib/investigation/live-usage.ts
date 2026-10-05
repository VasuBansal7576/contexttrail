import { randomUUID } from 'node:crypto';
import { database, ownerId } from '../hosted/context';
import { JEV_ENDPOINT, JEV_MAX_BYTES, JEV_MODEL } from '../jev/client';
import { SERPAPI_SEARCH_URL, SERPAPI_IMAGE_UPLOAD_URL, SEARCH_MAX_BYTES, UPLOAD_MAX_BYTES } from '../serpapi/client';
import { ProviderError, readBodyCapped } from '../providers/http';
import { MAX_JEV_CANDIDATES, MAX_DEEP_READ_PAGES, MAX_DIVERGENCE_OCCURRENCES, CLAIM_MAX_SEARCHES, TRACE_MAX_SEARCHES, MAX_IMAGE_UPLOAD_ATTEMPTS } from './limits';
import { evidenceQuestions } from '../jev/questions';
const ALLOWANCE_KEYS = ['searches','uploads','jevRequests','jevQuestions'] as const;
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
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

function cap(value: string | undefined): number {
  if (!value || !/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new LiveUsageError('Public usage limits are unavailable. No provider requests were made.');
  return Number(value);
}
export function readLiveUsageConfig(env: Readonly<Record<string,string | undefined>>): LiveUsageConfig {
  if (env.CONTEXTTRAIL_LIVE_ENABLED !== 'true') throw new LiveUsageError('Live investigations are disabled.','LIVE_USAGE_DISABLED');
  if (env.CONTEXTTRAIL_FREE_ALLOWANCE_ACKNOWLEDGED !== 'true' || env.CONTEXTTRAIL_LIVE_DEPLOYMENT !== 'sites-d1') throw new LiveUsageError('Public usage configuration is unavailable.');
  if (env.TYPESAFE_MODEL && env.TYPESAFE_MODEL !== JEV_MODEL) throw new LiveUsageError('The pinned assessment model is required.');
  const expires = Date.parse(env.CONTEXTTRAIL_PUBLIC_ALLOWANCE_EXPIRES_AT ?? '');
  if (!Number.isFinite(expires) || Date.now() >= expires) throw new LiveUsageError('The public trial has ended. Your saved cases remain available.');
  const period = env.CONTEXTTRAIL_FREE_ALLOWANCE_PERIOD;
  if (!period || !/^[a-zA-Z0-9._-]{1,80}$/.test(period)) throw new LiveUsageError('Public allowance identity unavailable.');
  return {ledgerPath:'D1',period,allowance:{searches:cap(env.CONTEXTTRAIL_FREE_SERPAPI_SEARCHES),uploads:cap(env.CONTEXTTRAIL_FREE_SERPAPI_UPLOADS),jevRequests:cap(env.CONTEXTTRAIL_FREE_JEV_REQUESTS),jevQuestions:cap(env.CONTEXTTRAIL_FREE_JEV_QUESTIONS)}};
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
export async function inspectLiveAllowance(config: LiveUsageConfig, allocation: LiveAllowance): Promise<'ready'|'busy'|'exhausted'> {
  const row = await database().prepare('SELECT caps,searches,uploads,requests,questions,busy FROM public_usage WHERE period = ?').bind(config.period).first<{caps:string;searches:number;uploads:number;requests:number;questions:number;busy:string|null}>();
  if (!row) return 'ready';
  if (row.caps !== JSON.stringify(config.allowance)) throw new LiveUsageError('The public allocation changed. An operator must reconcile it.');
  if (row.busy) return 'busy';
  return allocation.searches > config.allowance.searches-row.searches || allocation.uploads > config.allowance.uploads-row.uploads || allocation.jevRequests > config.allowance.jevRequests-row.requests || allocation.jevQuestions > config.allowance.jevQuestions-row.questions ? 'exhausted' : 'ready';
}
async function reserveAllocation(config: LiveUsageConfig, allocation: LiveAllowance, signal?: AbortSignal): Promise<LiveRunLease> {
  signal?.throwIfAborted();
  const db = database(), owner = ownerId(), id = randomUUID(), day = new Date().toISOString().slice(0,10), caps = JSON.stringify(config.allowance);
  await db.prepare('INSERT OR IGNORE INTO public_usage (period,caps) VALUES (?,?)').bind(config.period,caps).run();
  const results = await db.batch([
    db.prepare('INSERT INTO daily_usage (owner,day,runs,nonce) VALUES (?,?,1,?) ON CONFLICT (owner,day) DO UPDATE SET runs = runs + 1, nonce = excluded.nonce WHERE runs < 3').bind(owner,day,id),
    db.prepare('UPDATE public_usage SET searches = searches + ?, uploads = uploads + ?, requests = requests + ?, questions = questions + ?, busy = ? WHERE period = ? AND caps = ? AND busy IS NULL AND searches + ? <= ? AND uploads + ? <= ? AND requests + ? <= ? AND questions + ? <= ? AND EXISTS (SELECT 1 FROM daily_usage WHERE owner = ? AND day = ? AND nonce = ?)').bind(allocation.searches,allocation.uploads,allocation.jevRequests,allocation.jevQuestions,id,config.period,caps,allocation.searches,config.allowance.searches,allocation.uploads,config.allowance.uploads,allocation.jevRequests,config.allowance.jevRequests,allocation.jevQuestions,config.allowance.jevQuestions,owner,day,id),
    db.prepare('INSERT INTO usage_reservations (id,period,owner,allocation,created_at) SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM public_usage WHERE period = ? AND busy = ?)').bind(id,config.period,owner,JSON.stringify(allocation),new Date().toISOString(),config.period,id),
  ]);
  if (results[1].meta.changes !== 1 || results[2].meta.changes !== 1) throw new LiveUsageError('The public trial is busy, has reached its shared allowance, or you have used your three daily attempts. Saved investigations remain available.');
  const ownedLock = {async release() {
    const result = await db.batch([
      db.prepare('UPDATE public_usage SET busy = NULL WHERE period = ? AND busy = ?').bind(config.period,id),
      db.prepare('UPDATE usage_reservations SET released_at = ? WHERE id = ? AND released_at IS NULL').bind(new Date().toISOString(),id),
    ]);
    if (result[0].meta.changes !== 1) throw new LiveUsageError('Public reservation recovery required.');
  }};
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
          const response = await fetchImpl(input, { ...init, redirect: "manual" });
          // fetch resolves at headers. Keep ownership through the whole bounded
          // body, including providers whose callers reject HTTP errors early.
          if (response.status >= 300 && response.status < 400) {
            await response.body?.cancel();
            throw new ProviderError("http", "Provider redirect rejected; credentials were not forwarded.", response.status);
          }
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

