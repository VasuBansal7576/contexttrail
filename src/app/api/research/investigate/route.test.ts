import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';
import { parseAutomaticForm } from '@/lib/research/automatic-input';

const form = (kind = 'topic') => { const value = new FormData(); value.set('kind', kind); if (kind === 'topic') value.set('topic', 'Coral recovery evidence'); return value; };
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe('automatic route boundary (no live provider calls)', () => {
  it('fails closed before providers or body parsing when live use is disabled', async () => {
    vi.stubEnv('CONTEXTTRAIL_RESEARCH_LOCAL', '1'); vi.stubEnv('CONTEXTTRAIL_LIVE_ENABLED', 'false');
    const fetch = vi.fn(() => { throw new Error('Network forbidden'); }); vi.stubGlobal('fetch', fetch);
    const response = await POST(new Request('http://localhost:3000/api/research/investigate', { method: 'POST', body: form(), headers: { origin: 'http://localhost:3000' } }));
    expect(response.status).toBe(503); expect(await response.text()).toContain('disabled'); expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects foreign origins and non-loopback without accessing providers', async () => {
    vi.stubEnv('CONTEXTTRAIL_RESEARCH_LOCAL', '1');
    for (const [url, origin] of [['http://localhost:3000/api/research/investigate', 'https://other.example'], ['https://public.example/api/research/investigate', 'https://public.example']]) {
      const response = await POST(new Request(url, { method: 'POST', body: form(), headers: { origin } }));
      expect(response.status).toBe(403);
    }
  });
  it('parses one bounded topic and rejects input/model/quota/provider override fields', async () => {
    expect(await parseAutomaticForm(form())).toEqual({ kind: 'topic', topic: 'Coral recovery evidence' });
    for (const field of ['video', 'model', 'quota', 'provider', 'topic']) {
      const value = form(); value.append(field, 'unexpected'); await expect(parseAutomaticForm(value)).rejects.toThrow('exactly one');
    }
    const short = form(); short.set('topic', 'abcd'); await expect(parseAutomaticForm(short)).rejects.toThrow('between 5 and 500');
    short.set('topic', 'a'.repeat(501)); await expect(parseAutomaticForm(short)).rejects.toThrow('between 5 and 500');
  });
  it('requires video decoder opt-in, rights and supported bytes before orchestration', async () => {
    const value = form('video'); value.set('rights', 'user_provided'); value.set('video', new Blob(['invalid']), 'video.mp4');
    vi.stubEnv('CONTEXTTRAIL_MEDIA_LOCAL', '0'); await expect(parseAutomaticForm(value)).rejects.toThrow('explicitly enabled');
    vi.stubEnv('CONTEXTTRAIL_MEDIA_LOCAL', '1'); value.set('rights', 'no'); await expect(parseAutomaticForm(value)).rejects.toThrow('Confirm');
    value.set('rights', 'user_provided'); await expect(parseAutomaticForm(value)).rejects.toThrow('self-contained');
    value.set('video', new Blob([new Uint8Array([0, 0, 0, 12, 102, 116, 121, 112, 0, 0, 0, 0])]), 'video.mp4');
    await expect(parseAutomaticForm(value)).rejects.toThrow('self-contained');
    // This test isolates form/caption admission; generated container decoding
    // and real MOV signature validation run in automatic-input.test.ts.
    value.set('video', new Blob([new Uint8Array([26, 69, 223, 163])]), 'video.webm');
    expect(await parseAutomaticForm(value)).toMatchObject({ kind: 'video', rights: 'user_provided' });
    value.set('claim', 'This shows a current incident.');
    expect(await parseAutomaticForm(value)).toMatchObject({ kind: 'video', claim: 'This shows a current incident.' });
    value.set('claim', 'x'.repeat(501));
    await expect(parseAutomaticForm(value)).rejects.toThrow('500 characters');
  });
});
