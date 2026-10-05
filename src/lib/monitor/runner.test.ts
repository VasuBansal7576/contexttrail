import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { savedTopicFixture } from '../research/saved-topic-fixture';
const provider = vi.hoisted(() => ({ prepare: vi.fn(), investigate: vi.fn(), release: vi.fn() }));
vi.mock('../research/automatic-server', async importOriginal => {
  const original = await importOriginal<typeof import('../research/automatic-server')>();
  return { ...original, automaticProductionDeps: provider.prepare };
});
vi.mock('../research/automatic', () => ({ investigateTopic: provider.investigate }));
import { checkWatch, watchService } from './service';
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'contexttrail-watch-run-'));
  vi.stubEnv('CONTEXTTRAIL_RESEARCH_DATA_DIR', directory);
  vi.stubEnv('CONTEXTTRAIL_RESEARCH_LOCAL', '1');
  provider.prepare.mockResolvedValue({ deps: {}, release: provider.release });
  provider.release.mockResolvedValue(undefined);
});
afterEach(async () => { vi.unstubAllEnvs(); vi.clearAllMocks(); await rm(directory, { recursive: true, force: true }); });
it('pauses recurring spending after admission failure and keeps prior evidence', async () => {
  const service = watchService(join(directory, 'watches'));
  const watch = await service.apply({ kind: 'create', question: 'What changed in monthly payments?', intervalHours: 24 });
  provider.prepare.mockRejectedValueOnce(new Error('allowance exhausted'));
  await checkWatch(watch.id);
  const saved = (await service.read()).watches[0];
  expect(saved.state).toBe('paused'); expect(saved.checks[0].error).toBeTruthy();
  expect(saved.lastCaseId).toBeNull(); expect(provider.investigate).not.toHaveBeenCalled();
});
it('does not treat all failed searches as a quiet successful check and releases the reservation', async () => {
  const service = watchService(join(directory, 'watches'));
  const watch = await service.apply({ kind: 'create', question: 'What changed in monthly payments?', intervalHours: 24 });
  const result = savedTopicFixture('runner-failure');
  provider.investigate.mockResolvedValueOnce(result);
  await checkWatch(watch.id);
  expect((await service.read()).watches[0].state).toBe('paused');
  expect(provider.release).toHaveBeenCalledOnce();
});
it('saves a successful baseline without resuming a watch paused during its check', async () => {
  const service = watchService(join(directory, 'watches'));
  const watch = await service.apply({ kind: 'create', question: 'What changed in monthly payments?', intervalHours: 24 });
  const actual = await vi.importActual<typeof import('../research/automatic')>('../research/automatic');
  const result = await actual.investigateTopic(watch.question, () => {}, {
    serpapi: { search: async params => ({ search_metadata: { status: 'Success' }, [params.engine === 'google_news' ? 'news_results' : 'organic_results']: [] }), uploadImage: async () => 'unused' },
    jev: null, fetchPage: async () => { throw new Error('No sources to read'); },
  });
  provider.investigate.mockImplementationOnce(async () => {
    await service.apply({ kind: 'pause', id: watch.id });
    return result;
  });
  await checkWatch(watch.id);
  const saved = (await service.read()).watches[0];
  expect(saved.state).toBe('paused');
  expect(saved.checks[0]).toMatchObject({ baseline: true, error: null, changes: [] });
  expect(saved.lastCaseId).toBeTruthy();
  expect(provider.release).toHaveBeenCalledOnce();
});
