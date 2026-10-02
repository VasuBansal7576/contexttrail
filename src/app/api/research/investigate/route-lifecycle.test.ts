/** Offline HTTP boundary tests: production gate/client construction replaced, real route and stream retained. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as server from '@/lib/research/automatic-server';
import type { AutomaticResearchDeps } from '@/lib/research/automatic';
import { POST } from './route';

const actualResponse = server.createAutomaticResponse;
function request(): Request {
  const form = new FormData(); form.set('kind', 'topic'); form.set('topic', 'Coral recovery evidence');
  return new Request('http://localhost:3000/api/research/investigate', { method: 'POST', body: form, headers: { origin: 'http://localhost:3000' } });
}
function install(search: NonNullable<AutomaticResearchDeps['serpapi']>['search'] = async () => ({ search_metadata: { status: 'Success' }, organic_results: [], news_results: [] })) {
  vi.stubEnv('CONTEXTTRAIL_RESEARCH_LOCAL', '1');
  vi.spyOn(server, 'automaticConfiguration').mockImplementation(() => {});
  const release = vi.fn(async () => {});
  vi.spyOn(server, 'createAutomaticResponse').mockImplementation((input, options) => actualResponse(input, { ...options,
    production: async (_, signal) => ({ deps: { serpapi: { search, uploadImage: async () => { throw new Error('No upload in topic route'); } }, jev: null, fetchPage: async () => { throw new Error('No sources'); }, signal }, release }) }));
  return release;
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });
describe('automatic POST lifecycle without provider access', () => {
  it('streams successful POST and admits a subsequent request after settlement', async () => {
    const release = install();
    const first = await POST(request()); expect(first.status).toBe(200);
    expect(await first.text()).toContain('research.completed');
    expect(release).toHaveBeenCalledTimes(1);
    const second = await POST(request()); expect(second.status).toBe(200);
    expect(await second.text()).toContain('research.completed');
    expect(release).toHaveBeenCalledTimes(2);
  });
  it('keeps immediate retry blocked after stream cancellation until outstanding work settles', async () => {
    let settle: (() => void) | undefined;
    const blocked = new Promise<void>(resolve => { settle = resolve; });
    const release = install(async () => { await blocked; return { organic_results: [], news_results: [] }; });
    const first = await POST(request());
    const reader = first.body!.getReader(); await reader.read(); await reader.cancel();
    const busy = await POST(request()); expect(busy.status).toBe(429); expect(release).not.toHaveBeenCalled();
    settle?.(); await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    const next = await POST(request()); expect(next.status).toBe(200); expect(await next.text()).toContain('research.completed');
  });
  it('times out a stalled multipart body and admits the next bounded request', async () => {
    install(); vi.useFakeTimers();
    const body = new ReadableStream<Uint8Array>({ start() { /* Intentionally never supplies or closes bytes. */ } });
    const init = { method: 'POST', body, duplex: 'half', headers: { origin: 'http://localhost:3000', 'content-type': 'multipart/form-data; boundary=test' } };
    const pending = POST(new Request('http://localhost:3000/api/research/investigate', init));
    await vi.advanceTimersByTimeAsync(30_000);
    const timedOut = await pending; expect(timedOut.status).toBe(408); expect(await timedOut.text()).toContain('30-second deadline');
    vi.useRealTimers();
    const next = await POST(request()); expect(next.status).toBe(200); expect(await next.text()).toContain('research.completed');
  });
  it('rejects declared or streamed oversized bodies before orchestration', async () => {
    install();
    const tooLarge = request(); tooLarge.headers.set('content-length', String(33 * 1024 * 1024));
    expect((await POST(tooLarge)).status).toBe(413);
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(33 * 1024 * 1024)); controller.close(); } });
    const init = { method: 'POST', body, duplex: 'half', headers: { 'content-type': 'multipart/form-data; boundary=test' } };
    expect((await POST(new Request('http://localhost:3000/api/research/investigate', init))).status).toBe(413);
    expect(server.createAutomaticResponse).not.toHaveBeenCalled();
  });
});
