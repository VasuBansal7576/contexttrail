import type { CaseRecord } from '../cases/model';
import { object } from '../watchlists/parse';

export interface SeenSource { url: string; digest: string; attribution: string }
export interface WatchCheck {
  id: string; at: string; caseId: string | null; error: string | null; baseline?: boolean;
  changes: Array<{ url: string; kind: 'new_passage' | 'new_lead' | 'changed_sample'; priorCaseId: string | null }>;
}
export interface Watch {
  id: string; question: string; intervalHours: 1 | 24; state: 'active' | 'paused';
  createdAt: string; nextCheckAt: string; lastCaseId: string | null;
  seen: SeenSource[]; checks: WatchCheck[];
}
export interface WatchStore { version: 1; watches: Watch[] }

function text(value: unknown, max = 500): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Invalid watch text');
  return value;
}
function timestamp(value: unknown): string {
  const result = text(value); if (!Number.isFinite(Date.parse(result))) throw new Error('Invalid watch date'); return result;
}
function url(value: unknown): string {
  const result = text(value, 8192), parsed = new URL(result);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Invalid watch source');
  return result;
}
export function parseWatchStore(value: unknown): WatchStore {
  const store = object(value);
  if (store.version !== 1 || !Array.isArray(store.watches) || store.watches.length > 100) throw new Error('Invalid watch store; preserve the original file');
  const watches = store.watches.map((value): Watch => {
    const w = object(value);
    if ((w.intervalHours !== 1 && w.intervalHours !== 24) || (w.state !== 'active' && w.state !== 'paused') || !Array.isArray(w.seen) || w.seen.length > 1000 || !Array.isArray(w.checks) || w.checks.length > 50) throw new Error('Invalid watch');
    const seen = w.seen.map(value => { const s = object(value), digest = text(s.digest); if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid source digest'); return { url: url(s.url), digest, attribution: text(s.attribution) }; });
    const checks = w.checks.map((value): WatchCheck => {
      const c = object(value);
      if (!Array.isArray(c.changes) || c.changes.length > 1000) throw new Error('Invalid watch changes');
      const changes = c.changes.map((value): WatchCheck['changes'][number] => {
        const change = object(value);
        if (change.kind !== 'new_passage' && change.kind !== 'new_lead' && change.kind !== 'changed_sample') throw new Error('Invalid watch change');
        return { url: url(change.url), kind: change.kind, priorCaseId: change.priorCaseId === null ? null : text(change.priorCaseId) };
      });
      if (c.baseline !== undefined && typeof c.baseline !== 'boolean') throw new Error('Invalid watch baseline');
      return { baseline: c.baseline === true || (c.baseline === undefined && c.caseId !== null && changes.length > 0 && changes.every(change => change.priorCaseId === null)), id: text(c.id), at: timestamp(c.at), caseId: c.caseId === null ? null : text(c.caseId), error: c.error === null ? null : text(c.error, 2000), changes };
    });
    return { id: text(w.id), question: text(w.question), intervalHours: w.intervalHours, state: w.state, createdAt: timestamp(w.createdAt), nextCheckAt: timestamp(w.nextCheckAt), lastCaseId: w.lastCaseId === null ? null : text(w.lastCaseId), seen, checks };
  });
  if (new Set(watches.map(w => w.id)).size !== watches.length) throw new Error('Duplicate watch identity');
  return { version: 1, watches };
}
/** Retrieval time and regenerated IDs cannot manufacture a change. Missing search hits cannot erase history. */
export function compareWatch(watch: Pick<Watch, 'seen' | 'lastCaseId'>, record: CaseRecord, digestOf: (value: string) => string) {
  const seen = new Map(watch.seen.map(source => [source.url, source]));
  const changes: WatchCheck['changes'] = [];
  for (const evidence of record.evidence) {
    const attribution = evidence.content.kind === 'text' ? evidence.content.attribution : 'reference';
    const digest = digestOf(JSON.stringify([evidence.title, evidence.content, evidence.publicationDate]));
    const previous = seen.get(evidence.sourceUrl);
    if (!previous || previous.digest !== digest) changes.push({ url: evidence.sourceUrl, kind: previous ? 'changed_sample' : attribution === 'page_quote' ? 'new_passage' : 'new_lead', priorCaseId: watch.lastCaseId });
    seen.set(evidence.sourceUrl, { url: evidence.sourceUrl, digest, attribution });
  }
  if (seen.size > 1000) throw new Error('This watch reached its 1,000-source history limit. Start a new watch after reviewing the retained history.');
  return { changes, seen: [...seen.values()] };
}
