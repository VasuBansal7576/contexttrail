import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './route';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'contexttrail-research-route-'));
  vi.stubEnv('CONTEXTTRAIL_RESEARCH_LOCAL', '1');
  vi.stubEnv('CONTEXTTRAIL_RESEARCH_DATA_DIR', directory);
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
function request(input: unknown, headers = {}, host = '127.0.0.1:3119') {
  return new Request(`http://${host}/api/research`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(input) });
}
const start = { kind: 'start', operationId: 'route-start', question: 'How did this change?', createdAt: '2026-10-01T00:00:00.000Z' };

describe('research application HTTP boundary', () => {
  it('creates and reopens a persisted case and returns uncached validated reports', async () => {
    const result = await POST(request(start));
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    const body = await result.json();
    const reopened = await GET(new Request(`http://127.0.0.1:3119/api/research?caseId=${encodeURIComponent(body.document.workspace.inquiry.caseId)}`));
    expect(await reopened.json()).toEqual(body);
    expect((await readdir(directory)).length).toBe(1);
  });
  it('does not access saved cases when disabled or called cross-origin/nonlocal', async () => {
    vi.stubEnv('CONTEXTTRAIL_RESEARCH_LOCAL', '0');
    expect((await POST(request(start))).status).toBe(503);
    vi.stubEnv('CONTEXTTRAIL_RESEARCH_LOCAL', '1');
    expect((await POST(request(start, {}, 'research.example'))).status).toBe(403);
    expect((await POST(request(start, { host: 'research.example' }))).status).toBe(403);
    expect((await POST(request(start, { host: 'localhost:3119/path' }))).status).toBe(403);
    expect((await POST(request(start, { host: 'malformed[' }))).status).toBe(403);
    expect((await POST(request(start, { origin: 'https://external.example' }))).status).toBe(403);
    expect((await POST(request(start, { 'sec-fetch-site': 'cross-site' }))).status).toBe(403);
    expect((await GET(new Request('http://127.0.0.1:3119/api/research', { headers: { origin: 'https://external.example' } }))).status).toBe(403);
    expect(await readdir(directory)).toEqual([]);
  });
  it('rejects wrong content, oversized requests, unsupported commands and bad dates without a write', async () => {
    expect((await POST(request(start, { 'content-type': 'text/plain' }))).status).toBe(415);
    expect((await POST(request({ ...start, padding: 'x'.repeat(5 * 1024 * 1024) }))).status).toBe(413);
    expect((await POST(request({ kind: 'read', document: {} }))).status).toBe(400);
    expect((await POST(request({ ...start, createdAt: 'not-a-date' }))).status).toBe(400);
    const malformedUtf8 = await POST(new Request('http://127.0.0.1:3119/api/research', { method: 'POST', headers: { 'content-type': 'application/json' }, body: new Uint8Array([255, 254]) }));
    expect(malformedUtf8.status).toBe(400);
    expect((await malformedUtf8.json()).code).toBe('INVALID_INPUT');
    expect(await readdir(directory)).toEqual([]);
  });
  it('returns explicit missing-case and conflicting-revision results', async () => {
    expect((await GET(new Request('http://127.0.0.1:3119/api/research?caseId=missing'))).status).toBe(404);
    const initial = await (await POST(request(start))).json();
    const result = await POST(request({ kind: 'update', operationId: 'stale', caseId: initial.document.workspace.inquiry.caseId, expectedRevision: 20, change: { kind: 'subquestion', value: { kind: 'subquestion', id: 'q2', question: 'Why?' } } }));
    expect(result.status).toBe(409);
    expect((await result.json()).code).toBe('REVISION_CONFLICT');
    const reuse = await POST(request({ kind: 'update', operationId: start.operationId, caseId: initial.document.workspace.inquiry.caseId, expectedRevision: 1, change: { kind: 'subquestion', value: { kind: 'subquestion', id: 'q2', question: 'Why?' } } }));
    expect(reuse.status).toBe(409);
    expect((await reuse.json()).code).toBe('OPERATION_CONFLICT');
  });
});

it('returns readable cases and recovery warnings together through the HTTP boundary', async () => {
  await POST(request(start));
  const file = 'a'.repeat(64) + '.json';
  await writeFile(join(directory, file), '{broken');
  const response = await GET(new Request('http://127.0.0.1:3119/api/research'));
  expect(response.status).toBe(200);
  const listing = await response.json();
  expect(listing.cases).toHaveLength(1);
  expect(listing.warnings).toEqual([{ file, code: 'RECOVERY_REQUIRED', message: expect.stringContaining('not been changed') }]);
});
