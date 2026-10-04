import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { watchService } from './service';
import { compareWatch, parseWatchStore, type Watch } from './model';
import { savedTopicFixture } from '../research/saved-topic-fixture';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
it('persists a watch and concurrent lifecycle edits without erasing its evidence history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contexttrail-watch-')); roots.push(root);
  const service = watchService(root), watch = await service.apply({ kind: 'create', question: 'What changed in the UPI ecosystem?', intervalHours: 24 });
  await service.change(store => { store.watches[0].checks.push({ id: 'check-1', at: new Date().toISOString(), caseId: 'case-1', error: null, changes: [] }); });
  await service.apply({ kind: 'pause', id: watch.id });
  const reopened = await watchService(root).read();
  expect(reopened.watches[0].state).toBe('paused'); expect(reopened.watches[0].checks[0].caseId).toBe('case-1');
  await service.apply({ kind: 'resume', id: watch.id }); expect((await service.read()).watches[0].checks).toHaveLength(1);
});
it('preserves unreadable state and fails closed when a writer is interrupted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contexttrail-watch-')); roots.push(root);
  const service = watchService(root);
  await writeFile(join(root, 'watches.json'), '{broken');
  await expect(service.apply({ kind: 'create', question: 'A new question', intervalHours: 1 })).rejects.toThrow();
  await writeFile(join(root, 'store.lock'), 'interrupted');
  await expect(service.apply({ kind: 'create', question: 'A new question', intervalHours: 1 })).rejects.toThrow('interrupted writer');
});
it('ignores regenerated IDs and retrieval dates, keeps missing sources, and labels snippet changes as sample changes', () => {
  const { caseRecord } = savedTopicFixture('watch-test');
  const watch: Pick<Watch, 'seen' | 'lastCaseId'> = { seen: [], lastCaseId: null };
  const first = compareWatch(watch, caseRecord, digest); expect(first.changes[0].kind).toBe('new_lead');
  watch.seen = first.seen; watch.lastCaseId = 'case-1';
  const repeated = structuredClone(caseRecord); repeated.evidence[0].id = 'different-id'; repeated.evidence[0].provenance.retrievedAt = '2026-10-05T00:00:00Z';
  expect(compareWatch(watch, repeated, digest).changes).toEqual([]);
  const absent = structuredClone(caseRecord); absent.evidence = [];
  expect(compareWatch(watch, absent, digest).seen).toEqual(first.seen);
  repeated.evidence[0].content = { kind: 'text', attribution: 'search_snippet', text: 'A newly selected snippet' };
  expect(compareWatch(watch, repeated, digest).changes).toEqual([{ kind: 'changed_sample', url: repeated.evidence[0].sourceUrl, priorCaseId: 'case-1' }]);
});
it('rejects oversized and ambiguous persisted scheduling state', () => {
  expect(() => parseWatchStore({ version: 1, watches: Array(101).fill({}) })).toThrow();
  expect(() => parseWatchStore({ version: 1, watches: [{ intervalHours: 0 }] })).toThrow();
});
