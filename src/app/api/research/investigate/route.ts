import { automaticConfiguration, automaticFailure, createAutomaticResponse } from '@/lib/research/automatic-server';
import { parseAutomaticForm } from '@/lib/research/automatic-input';
import { requireLocalResearchRequest } from '@/lib/research/local-boundary';
import { ResearchServiceError } from '@/lib/research/service';
import { LiveUsageError } from '@/lib/investigation/live-usage';
import { VIDEO_LIMITS } from '@/lib/video/ingest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
let active = false;
const REQUEST_BYTES = VIDEO_LIMITS.bytes + 64 * 1024;
const json = (error: string, status: number) => Response.json({ error }, { status, headers: { 'cache-control': 'no-store' } });

/** Bounded streaming body reader. No form parser sees an unbounded upload. */
async function readForm(request: Request, signal: AbortSignal): Promise<FormData> {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > REQUEST_BYTES)) throw new ResearchServiceError(413, 'TOO_LARGE', 'Request exceeds the 32 MB video limit plus multipart framing.');
  const reader = request.body?.getReader();
  if (!reader) throw new ResearchServiceError(400, 'MISSING_INPUT', 'Supply a topic or video.');
  const chunks: Uint8Array[] = []; let size = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > REQUEST_BYTES) { await reader.cancel(); throw new ResearchServiceError(413, 'TOO_LARGE', 'Request exceeds the bounded video upload limit.'); }
      chunks.push(value);
    }
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new Response(bytes, { headers: { 'content-type': request.headers.get('content-type') ?? '' } }).formData();
}
export async function POST(request: Request): Promise<Response> {
  try { requireLocalResearchRequest(request); automaticConfiguration(); }
  catch (error) { return json(error instanceof ResearchServiceError ? error.message : automaticFailure(error), error instanceof ResearchServiceError ? error.status : error instanceof LiveUsageError ? 503 : 400); }
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data;')) return json('Expected multipart/form-data.', 415);
  if (active) return json('One automatic investigation is already running. Cancel it or wait before trying again.', 429);
  active = true;
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener('abort', abort, { once: true });
  if (request.signal.aborted) abort();
  const timeout = setTimeout(abort, 30_000);
  try {
    const form = await readForm(request, controller.signal);
    const input = await parseAutomaticForm(form);
    controller.signal.throwIfAborted();
    return createAutomaticResponse(input, { signal: request.signal, onSettled: () => { active = false; } });
  } catch (error) {
    active = false;
    return json(controller.signal.aborted ? 'Upload cancelled or exceeded its 30-second deadline.' : error instanceof ResearchServiceError ? error.message : 'The supplied request could not be read.', controller.signal.aborted ? 408 : error instanceof ResearchServiceError ? error.status : 400);
  } finally { clearTimeout(timeout); request.signal.removeEventListener('abort', abort); }
}
