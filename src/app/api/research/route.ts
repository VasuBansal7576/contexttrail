import { requireLocalResearchRequest } from '@/lib/research/local-boundary';
import { resolve } from 'node:path';
import { localResearchService, MAX_RESEARCH_BYTES, ResearchServiceError } from '@/lib/research/service';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function service(request: Request) {
  requireLocalResearchRequest(request);
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
    return json(id === null ? await store.list() : await store.get(id));
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
