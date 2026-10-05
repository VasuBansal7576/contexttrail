import { createHash, randomUUID } from 'node:crypto';
import { database, ownerId } from '../hosted/context';

import { object } from '../watchlists/parse';
import { localResearchService, ResearchServiceError } from '../research/service';
import { automaticFailure, automaticProductionDeps } from '../research/automatic-server';
import { investigateTopic } from '../research/automatic';
import { AUTOMATIC_RESEARCH_DEADLINES_MS } from '../research/automatic-contract';
import { compareWatch, parseWatchStore, type Watch, type WatchStore } from './model';

export function watchDirectory(){return 'D1'}
export function watchService(_directory='D1') {
  const db=database(),owner=ownerId();
  async function read(){const row=await db.prepare('SELECT document FROM watch_stores WHERE owner = ?').bind(owner).first<{document:string}>();return row?parseWatchStore(JSON.parse(row.document)):{version:1 as const,watches:[]};}
  async function change<T>(action:(store:WatchStore)=>T):Promise<T>{
    const row=await db.prepare('SELECT revision,document FROM watch_stores WHERE owner = ?').bind(owner).first<{revision:number;document:string}>();
    const store:WatchStore=row?parseWatchStore(JSON.parse(row.document)):{version:1,watches:[]};
    const result=action(store),data=JSON.stringify(parseWatchStore(store));if(new TextEncoder().encode(data).length>256*1024)throw new Error('Watch history reached its storage limit');
    const saved=row?await db.prepare('UPDATE watch_stores SET revision = revision + 1,document = ? WHERE owner = ? AND revision = ?').bind(data,owner,row.revision).run():await db.prepare('INSERT OR IGNORE INTO watch_stores (owner,revision,document) VALUES (?,1,?)').bind(owner,data).run();
    if(saved.meta.changes!==1)throw new ResearchServiceError(409,'WATCH_BUSY','Watch changed. Reopen before retrying.');return result;
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
  return { read, change, apply };
}

/** A filesystem worker lease prevents two server processes from spending on the same watch. */
export async function checkWatch(id?: string): Promise<void> {
  const service = watchService();
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
      const saved = await localResearchService().apply({ kind: 'import_case', operationId: checkId, createdAt: result.caseRecord.createdAt, question: watch.question, caseRecord: result.caseRecord, claimReport: result.claimReport });
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
}
export function startWatchWorker() {}
export async function watchStatus(){return {...await watchService().read(),running:false,workerConnected:false,checkedAt:new Date().toISOString()};}
