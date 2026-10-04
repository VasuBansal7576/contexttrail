import { describe, expect, it, vi } from 'vitest';
import { createAutomaticResponse } from './automatic-server';
import type { AutomaticResearchDeps } from './automatic';

const deps = (): AutomaticResearchDeps => ({ serpapi: { search: async () => ({ search_metadata: { status: 'Success' }, organic_results: [], news_results: [] }), uploadImage: async () => { throw new Error('No uploads in topic research'); } }, jev: null, fetchPage: async () => { throw new Error('No sources'); } });
describe('automatic response lifecycle', () => {
  it('holds the lease after cancellation until every dispatched search has settled', async () => {
    const deferred = Array.from({ length: 3 }, () => Promise.withResolvers<unknown>());
    const search = vi.fn(async () => deferred[search.mock.calls.length - 1].promise);
    const controller = new AbortController();
    const release = vi.fn(async () => {});
    const response = createAutomaticResponse({ kind: 'topic', topic: 'Coral recovery evidence' }, { signal: controller.signal,
      production: async (_, signal) => ({ deps: { ...deps(), signal, topicSerpapi: { search } }, release }) });
    const read = response.text();
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(3));
    controller.abort();
    deferred[0].reject(new Error('cancelled')); deferred[1].resolve({ organic_results: [] });
    await Promise.resolve(); await Promise.resolve();
    expect(release).not.toHaveBeenCalled();
    deferred[2].resolve({ organic_results: [] });
    const body = await read;
    expect(body).not.toContain('research.completed');
    expect(release).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledTimes(3);
  });
  it('streams a genuine empty result and releases the lease once after completion', async () => {
    const release = vi.fn(async () => {});
    const response = createAutomaticResponse({ kind: 'topic', topic: 'Coral recovery evidence' }, { signal: new AbortController().signal,
      production: async (_, signal) => ({ deps: { ...deps(), signal }, release }) });
    const body = await response.text();
    expect(body).toContain('research.progress'); expect(body).toContain('research.completed'); expect(body).toContain('remains unresolved');
    expect(release).toHaveBeenCalledTimes(1);
  });
  it('never completes a cancelled stream and waits for in-flight work before releasing', async () => {
    let settle: (() => void) | undefined;
    const blocked = new Promise<void>(resolve => { settle = resolve; });
    const controller = new AbortController(); const release = vi.fn(async () => {});
    const dependencies = deps();
    dependencies.serpapi = { search: async () => { await blocked; return {}; }, uploadImage: async () => '' };
    const response = createAutomaticResponse({ kind: 'topic', topic: 'Coral recovery evidence' }, { signal: controller.signal,
      production: async (_, signal) => ({ deps: { ...dependencies, signal }, release }) });
    const read = response.text();
    await vi.waitFor(() => expect(settle).toBeDefined());
    controller.abort(); expect(release).not.toHaveBeenCalled(); settle?.();
    const body = await read; expect(body).not.toContain('research.completed'); expect(release).toHaveBeenCalledTimes(1);
  });
});

it('reports a terminal deadline error, aborts work and releases without completing', async () => {
  vi.useFakeTimers();
  try {
    const release = vi.fn(async () => {});
    const response = createAutomaticResponse({ kind: 'topic', topic: 'Coral recovery evidence' }, { signal: new AbortController().signal,
      production: async (_, signal) => ({ deps: { ...deps(), signal, serpapi: { uploadImage: async () => '', search: async () => new Promise((_, reject) => { signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); }) } }, release }) });
    const body = response.text();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(await body).toContain('5-minute deadline');
    expect(release).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});
