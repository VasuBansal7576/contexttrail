/** Isolated offline ledgers and dummy keys. Dependency construction dispatches no provider requests. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { automaticProductionDeps } from './automatic-server';
import { videoRunAllocation, topicRunAllocation } from '../investigation/live-usage';
import { JEV_MODEL } from '../jev/client';
import type { AutomaticResearchInput } from './automatic-contract';
const directories: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
it.each([null, 'This video depicts a current incident.'])('reserves a shared three-frame trace or caption ceiling without provider dispatch: %s', async claim => {
  const allocation = videoRunAllocation(claim);
  await mkdir(resolve('.verify'), { recursive: true });
  const directory = await mkdtemp(join(resolve('.verify'), 'offline-video-admission-')); directories.push(directory);
  const ledgerPath = join(directory, 'ledger.ndjson');
  await writeFile(ledgerPath, JSON.stringify({ type: 'contexttrail-live-usage', version: 1, model: JEV_MODEL, period: 'offline-only', allowance: allocation }) + '\n');
  for (const [key, value] of Object.entries({ CONTEXTTRAIL_LIVE_ENABLED: 'true', CONTEXTTRAIL_LIVE_DEPLOYMENT: 'single-host-persistent', CONTEXTTRAIL_FREE_ALLOWANCE_ACKNOWLEDGED: 'true', CONTEXTTRAIL_USAGE_LEDGER_PATH: ledgerPath, CONTEXTTRAIL_FREE_ALLOWANCE_PERIOD: 'offline-only', CONTEXTTRAIL_FREE_SERPAPI_SEARCHES: String(allocation.searches), CONTEXTTRAIL_FREE_SERPAPI_UPLOADS: String(allocation.uploads), CONTEXTTRAIL_FREE_JEV_REQUESTS: String(allocation.jevRequests), CONTEXTTRAIL_FREE_JEV_QUESTIONS: String(allocation.jevQuestions), SERPAPI_API_KEY: 'offline-dummy', TYPESAFE_API_KEY: 'offline-dummy' })) vi.stubEnv(key, value);
  const fetch = vi.fn(async () => { throw new Error('External dispatch forbidden in this test'); }); vi.stubGlobal('fetch', fetch);
  const input: AutomaticResearchInput = { kind: 'video', bytes: new Uint8Array([1]), rights: 'user_provided', claim };
  const production = await automaticProductionDeps(input, new AbortController().signal);
  try {
    const entries = (await readFile(ledgerPath, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
    expect(entries[1].allocation).toEqual(claim ? { searches: 24, uploads: 3, jevRequests: 192, jevQuestions: 876 } : { searches: 18, uploads: 3, jevRequests: 192, jevQuestions: 399 });
    expect(fetch).not.toHaveBeenCalled();
  } finally { await production.release(); }
});
it('declares bounded five-question topic classification without additional requests', () => {
  expect(topicRunAllocation()).toEqual({ searches: 6, uploads: 0, jevRequests: 12, jevQuestions: 60 });
});
