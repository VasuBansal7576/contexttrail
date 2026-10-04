import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { object } from '../watchlists/parse';
import { localResearchService, ResearchServiceError } from '../research/service';
import { automaticFailure, automaticProductionDeps } from '../research/automatic-server';
import { investigateTopic } from '../research/automatic';
import { AUTOMATIC_RESEARCH_DEADLINES_MS } from '../research/automatic-contract';
import { compareWatch, parseWatchStore, type Watch, type WatchStore } from './model';

function missing(error: unknown) { return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'; }
export function watchDirectory() { return resolve(process.env.CONTEXTTRAIL_RESEARCH_DATA_DIR || 'data/research', 'watches'); }
export function watchService(directory = watchDirectory()) {
  const root = resolve(directory), path = join(root, 'watches.json');
  async function read(): Promise<WatchStore> {
    try {
      const file = await open(path, 'r');
      try { if ((await file.stat()).size > 4 * 1024 * 1024) throw new Error('Watch store exceeds its limit'); return parseWatchStore(JSON.parse(await file.readFile('utf8'))); }
      finally { await file.close(); }
    } catch (error) { if (missing(error)) return { version: 1, watches: [] }; throw error; }
  }
  async function change<T>(action: (store: WatchStore) => T): Promise<T> {
    await mkdir(root, { recursive: true, mode: 0o700 });
    let lock;
    try { lock = await open(join(root, 'store.lock'), 'wx', 0o600); }
    catch { throw new ResearchServiceError(409, 'WATCH_BUSY', 'Watch storage has an active or interrupted writer. Retry after it finishes; preserve unexplained locks.'); }
    try {
      const store = await read(), result = action(store), validated = parseWatchStore(store);
      const bytes = JSON.stringify(validated); if (Buffer.byteLength(bytes) > 4 * 1024 * 1024) throw new Error('Watch store exceeds its limit');
      const temporary = join(root, `watches-${randomUUID()}.tmp`), file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path);
      const dir = await open(root, 'r'); try { await dir.sync(); } finally { await dir.close(); }
      return result;
    } finally { await lock.close(); await unlink(join(root, 'store.lock')); }
  }
  async function apply(input: unknown): Promise<Watch> {
    const request = object(input);
    if (request.kind === 'create') {
      if (typeof request.question !== 'string' || request.question.trim().length < 5 || request.question.length > 500 || (request.intervalHours !== 1 && request.intervalHours !== 24)) throw new Error('Enter a question between 5 and 500 characters and an hourly or daily interval.');
      const question = request.question.trim(), intervalHours = request.intervalHours;
      return change(store => {
        if (store.watches.length >= 100) throw new Error('The local watchlist has reached its 100-watch limit. Pause an existing watch and retain its history.');
        const now = new Date().toISOString();
        const watch: Watch = { id: `watch-${randomUUID()}`, question, intervalHours, state: 'active', createdAt: now, nextCheckAt: now, lastCaseId: null, seen: [], checks: [] };
        store.watches.push(watch); return watch;
      });
    }
    if (request.kind !== 'pause' && request.kind !== 'resume') throw new Error('Unknown watch action');
    const kind = request.kind;
    return change(store => {
      const watch = store.watches.find(w => w.id === request.id); if (!watch) throw new ResearchServiceError(404, 'NOT_FOUND', 'Watch not found');
      watch.state = kind === 'pause' ? 'paused' : 'active';
      if (kind === 'resume') watch.nextCheckAt = new Date().toISOString();
      return watch;
    });
  }
  return { read, change, apply, root };
}

/** A filesystem worker lease prevents two server processes from spending on the same watch. */
export async function checkWatch(id?: string): Promise<void> {
  const service = watchService(); await mkdir(service.root, { recursive: true, mode: 0o700 });
  const lockPath = join(service.root, 'worker.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch { throw new ResearchServiceError(409, 'WATCH_RUNNING', 'A watch check is running or an interrupted worker needs recovery. Existing evidence is preserved.'); }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const store = await service.read();
    const watch = id ? store.watches.find(w => w.id === id) : store.watches.find(w => w.state === 'active' && Date.parse(w.nextCheckAt) <= Date.now());
    if (!watch) { if (id) throw new ResearchServiceError(404, 'NOT_FOUND', 'Watch not found'); return; }
    const at = new Date().toISOString(), checkId = `check-${randomUUID()}`;
    const signal = AbortSignal.timeout(AUTOMATIC_RESEARCH_DEADLINES_MS.topic);
    let production: Awaited<ReturnType<typeof automaticProductionDeps>> | undefined;
    try {
      production = await automaticProductionDeps({ kind: 'topic', topic: watch.question }, signal);
      const result = await investigateTopic(watch.question, () => {}, production.deps);
      // If all searches failed, an empty sample is a failed check, not reassuring silence.
      if (!result.caseRecord.coverage.topicCandidateAudit?.searches.some(search => search.outcome === 'succeeded')) throw new Error('All watch searches unavailable');
      const difference = compareWatch(watch, result.caseRecord, value => createHash('sha256').update(value).digest('hex'));
      const saved = await localResearchService(resolve(process.env.CONTEXTTRAIL_RESEARCH_DATA_DIR || 'data/research')).apply({ kind: 'import_case', operationId: checkId, createdAt: result.caseRecord.createdAt, question: watch.question, caseRecord: result.caseRecord, claimReport: result.claimReport });
      await service.change(store => {
        const latest = store.watches.find(w => w.id === watch.id); if (!latest) throw new Error('Watch disappeared');
        latest.seen = difference.seen; latest.lastCaseId = saved.document.workspace.inquiry.caseId;
        latest.checks = [{ id: checkId, at, caseId: latest.lastCaseId, error: null, baseline: watch.lastCaseId === null, changes: difference.changes }, ...latest.checks].slice(0, 50);
        latest.nextCheckAt = new Date(Date.now() + latest.intervalHours * 3_600_000).toISOString();
        // Retain a concurrent pause; finishing a check must not resume the watch.
      });
    } catch (error) {
      await service.change(store => {
        const latest = store.watches.find(w => w.id === watch.id); if (!latest) return;
        latest.checks = [{ id: checkId, at, caseId: null, error: automaticFailure(error), changes: [] }, ...latest.checks].slice(0, 50);
        latest.nextCheckAt = new Date(Date.now() + latest.intervalHours * 3_600_000).toISOString();
        // Fail closed: configuration, budget, parsing and provider failures need review before recurring spending.
        latest.state = 'paused';
      });
    } finally { await production?.release(); }
  } finally { await lock.close(); await unlink(lockPath); }
}

let timer: ReturnType<typeof setInterval> | undefined;
export function startWatchWorker() {
  if (timer || process.env.CONTEXTTRAIL_RESEARCH_LOCAL !== '1') return;
  const tick = async () => {
    try {
      await mkdir(watchDirectory(), { recursive: true, mode: 0o700 });
      await writeFile(join(watchDirectory(), 'heartbeat.txt'), new Date().toISOString(), { mode: 0o600 });
      await checkWatch();
    }
    catch (error) { if (!(error instanceof ResearchServiceError && error.code === 'WATCH_RUNNING')) console.warn('[watch] worker unavailable; retained history is unchanged'); }
  };
  timer = setInterval(() => { void tick(); }, 30_000); timer.unref();
}
export async function watchStatus() {
  const service = watchService(), store = await service.read();
  let running: string | null = null, heartbeat: string | null = null;
  try { running = (await readFile(join(service.root, 'worker.lock'), 'utf8')).slice(0, 500); } catch (error) { if (!missing(error)) throw error; }
  try { heartbeat = (await readFile(join(service.root, 'heartbeat.txt'), 'utf8')).slice(0, 100); } catch (error) { if (!missing(error)) throw error; }
  return { ...store, running: running !== null, workerConnected: heartbeat !== null && Number.isFinite(Date.parse(heartbeat)) && Date.now() - Date.parse(heartbeat) < 75_000, checkedAt: new Date().toISOString() };
}
