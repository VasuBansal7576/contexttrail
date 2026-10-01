import { resolve } from 'node:path';
import { localResearchService, MAX_RESEARCH_BYTES, ResearchServiceError } from '@/lib/research/service';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Disabled by default. Bind the opt-in server to loopback; this is not hosted multi-user storage. */
function service(request: Request) {
  if (process.env.CONTEXTTRAIL_RESEARCH_LOCAL !== '1') throw new ResearchServiceError(503, 'LOCAL_SERVICE_DISABLED', 'Local research storage is disabled. No case was read or changed.');
  const url = new URL(request.url);
  // Next may rebuild request.url using the bound hostname, so check the original Host too.
  const host = request.headers.get('host') ?? url.host;
  let requestedOrigin: URL;
  try { requestedOrigin = new URL(`${url.protocol}//${host}`); }
  catch { throw new ResearchServiceError(403, 'LOCAL_ONLY', 'Invalid local request host.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'];
  if (!loopback.includes(url.hostname) || !loopback.includes(requestedOrigin.hostname) || requestedOrigin.host.toLowerCase() !== host.toLowerCase() || requestedOrigin.username || requestedOrigin.password || requestedOrigin.pathname !== '/' || requestedOrigin.search || requestedOrigin.hash) throw new ResearchServiceError(403, 'LOCAL_ONLY', 'Research storage is available only through the local loopback server.');
  // Prevent a third-party browser page from reading or changing local cases.
  const origin = request.headers.get('origin');
  if ((origin && origin !== requestedOrigin.origin) || request.headers.get('sec-fetch-site') === 'cross-site') throw new ResearchServiceError(403, 'ORIGIN_REJECTED', 'Cross-origin research requests are not allowed.');
  return localResearchService(resolve(process.env.CONTEXTTRAIL_RESEARCH_DATA_DIR || 'data/research'));
}
function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}
function failure(error: unknown): Response {
  if (error instanceof ResearchServiceError) return json({ error: error.message, code: error.code }, error.status);
  // Parser messages are bounded domain errors; filesystem errors can contain local paths.
  if (error && typeof error === 'object' && 'code' in error && 'syscall' in error) return json({ error: 'Local research storage failed. Reopen the case to inspect the last committed revision before retrying.', code: 'STORAGE_ERROR' }, 500);
  return json({ error: error instanceof Error ? error.message : 'Research request could not be validated', code: 'INVALID_INPUT' }, 400);
}
export async function GET(request: Request): Promise<Response> {
  try {
    const store = service(request), id = new URL(request.url).searchParams.get('caseId');
    return json(id === null ? { cases: await store.list() } : await store.get(id));
  } catch (error) { return failure(error); }
}
export async function POST(request: Request): Promise<Response> {
  try {
    const store = service(request);
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return json({ error: 'Expected JSON', code: 'CONTENT_TYPE' }, 415);
    const reader = request.body?.getReader();
    if (!reader) throw new Error('Missing request body');
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_RESEARCH_BYTES) { await reader.cancel(); return json({ error: 'Research request exceeds 5 MiB', code: 'REQUEST_TOO_LARGE' }, 413); }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const input: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return json(await store.apply(input));
  } catch (error) { return failure(error); }
}
