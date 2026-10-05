import { afterEach, describe, expect, it, vi } from 'vitest';
import { SerpapiClient } from './client';

afterEach(() => vi.useRealTimers());
describe('separate bounded search timing', () => {
  it('accepts a delayed topic response while image search retains its 12s cutoff', async () => {
    vi.useFakeTimers();
    const fetchImpl: typeof fetch = async (_url, init) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(Response.json({ organic_results: [] })), 15_000);
      init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal?.reason); }, { once: true });
    });
    const image = new SerpapiClient('offline-only', { fetchImpl }).search({ engine: 'google', q: 'offline' });
    const imageFailure = expect(image).rejects.toMatchObject({ kind: 'timeout' });
    const topic = new SerpapiClient('offline-only', { fetchImpl, searchProfile: 'topic' }).search({ engine: 'google', q: 'offline' });
    await vi.advanceTimersByTimeAsync(15_000);
    await imageFailure;
    expect(await topic).toEqual({ organic_results: [] });
  });
  it('still cuts a stalled topic request off at 60s and never retries', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    const pending = new SerpapiClient('offline-only', { fetchImpl, searchProfile: 'topic' }).search({ engine: 'google', q: 'offline' });
    let settled = false;
    const failure = expect(pending.finally(() => { settled = true; })).rejects.toMatchObject({ kind: 'timeout' });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await failure;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('propagates caller cancellation immediately within the longer topic deadline', async () => {
    const controller = new AbortController();
    const fetchImpl: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
    });
    const pending = new SerpapiClient('offline-only', { fetchImpl, searchProfile: 'topic' }).search({ engine: 'google', q: 'offline' }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
  });
});
