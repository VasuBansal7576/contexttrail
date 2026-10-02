import { requireLocalResearchRequest } from '@/lib/research/local-boundary';
import { ResearchServiceError } from '@/lib/research/service';
import { VideoIngestError } from '@/lib/video/ingest';
import { FrameMatchError } from '@/lib/video/matching/model';
import { compareSuppliedMedia, LOCAL_COMPARISON_FORMATS, LOCAL_COMPARISON_LIMITS, LocalComparisonError, parseComparisonForm } from '@/lib/video/matching/application';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// One admitted upload/decode/comparison in this long-running local Node process.
let active = false;
function boundary(request: Request): void {
  requireLocalResearchRequest(request);
  if (process.env.CONTEXTTRAIL_MEDIA_LOCAL !== '1') throw new LocalComparisonError(503, 'LOCAL_MEDIA_DISABLED', 'Local media comparison is disabled. Enable the local decoder explicitly to compare supplied files.');
  if (['VERCEL', 'VERCEL_ENV', 'NETLIFY', 'AWS_LAMBDA_FUNCTION_NAME', 'AWS_EXECUTION_ENV', 'FUNCTIONS_WORKER_RUNTIME', 'K_SERVICE', 'CLOUD_RUN_JOB'].some(key => process.env[key])) throw new LocalComparisonError(503, 'LOCAL_MEDIA_ONLY', 'This decoder bridge is only for a single-user loopback Node server, not hosted or serverless operation.');
}
function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
function failure(error: unknown): Response {
  if (error instanceof ResearchServiceError || error instanceof LocalComparisonError) return json({ error: error.message, code: error.code }, error.status);
  if (error instanceof FrameMatchError || error instanceof VideoIngestError) {
    if (error.code === 'cancelled') return json({ error: 'Comparison cancelled. No case was changed.', code: 'CANCELLED' }, 499);
    if (error.code === 'decoder_unavailable') return json({ error: 'The local FFmpeg/FFprobe decoder is unavailable.', code: 'DECODER_UNAVAILABLE' }, 503);
    if (error.code === 'limit_exceeded') return json({ error: 'Media exceeded a decoder time, size, duration, dimension or output limit.', code: 'DECODE_LIMIT' }, 413);
    return json({ error: 'The supplied media could not be decoded within the supported formats.', code: 'INVALID_MEDIA' }, 422);
  }
  // Never expose filesystem paths, native decoder diagnostics or parser internals.
  return json({ error: 'Could not read or compare the supplied files. No case was changed.', code: 'INVALID_INPUT' }, 400);
}
async function readBody(request: Request, signal: AbortSignal): Promise<ArrayBuffer> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > LOCAL_COMPARISON_LIMITS.requestBytes)) throw new LocalComparisonError(413, 'REQUEST_TOO_LARGE', 'The upload exceeds the two-file request limit.');
  const reader = request.body?.getReader();
  if (!reader) throw new LocalComparisonError(400, 'INVALID_INPUT', 'Missing multipart upload.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new LocalComparisonError(499, 'CANCELLED', 'Upload cancelled.');
      const next = await reader.read();
      if (signal.aborted) throw new LocalComparisonError(499, 'CANCELLED', 'Upload cancelled.');
      if (next.done) break;
      size += next.value.byteLength;
      if (size > LOCAL_COMPARISON_LIMITS.requestBytes) {
        await reader.cancel();
        throw new LocalComparisonError(413, 'REQUEST_TOO_LARGE', 'The upload exceeds the two-file request limit.');
      }
      chunks.push(next.value);
    }
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.buffer;
}
export async function GET(request: Request): Promise<Response> {
  try { boundary(request); return json({ schemaVersion: 'contexttrail-local-media-capabilities-v1', mode: 'local_supplied_media_only', limits: LOCAL_COMPARISON_LIMITS, formats: LOCAL_COMPARISON_FORMATS, persistence: 'not_saved', busy: active }); }
  catch (error) { return failure(error); }
}
export async function POST(request: Request): Promise<Response> {
  try { boundary(request); } catch (error) { return failure(error); }
  const contentType = request.headers.get('content-type');
  if (!contentType?.toLowerCase().startsWith('multipart/form-data;')) return json({ error: 'Expected a multipart file upload.', code: 'CONTENT_TYPE' }, 415);
  if (active) return json({ error: 'One local comparison is already running. Cancel it or wait before retrying.', code: 'COMPARISON_BUSY' }, 429);
  active = true;
  const controller = new AbortController();
  let timeout: 'upload' | 'comparison' | null = null;
  const cancel = () => controller.abort();
  request.signal.addEventListener('abort', cancel, { once: true });
  if (request.signal.aborted) cancel();
  const deadline = setTimeout(() => { timeout = 'comparison'; controller.abort(); }, LOCAL_COMPARISON_LIMITS.deadlineMs);
  const uploadDeadline = setTimeout(() => { timeout = 'upload'; controller.abort(); }, LOCAL_COMPARISON_LIMITS.uploadMs);
  try {
    const bytes = await readBody(request, controller.signal);
    const form = await new Response(bytes, { headers: { 'content-type': contentType } }).formData();
    clearTimeout(uploadDeadline);
    const inputs = await parseComparisonForm(form, controller.signal);
    const result = await compareSuppliedMedia(inputs, controller.signal);
    if (controller.signal.aborted) throw new LocalComparisonError(499, 'CANCELLED', 'Comparison cancelled.');
    const output = JSON.stringify(result);
    if (Buffer.byteLength(output) > LOCAL_COMPARISON_LIMITS.responseBytes) throw new LocalComparisonError(413, 'RESPONSE_TOO_LARGE', 'Compared frames exceed the response limit. No case was changed.');
    return new Response(output, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  } catch (error) {
    if (timeout) return json({ error: timeout === 'upload' ? 'Upload exceeded 30 seconds. Retry with the files selected again.' : 'Local comparison exceeded its total deadline. No case was changed.', code: 'DEADLINE_EXCEEDED' }, 408);
    if (controller.signal.aborted) return failure(new LocalComparisonError(499, 'CANCELLED', 'Comparison cancelled. No case was changed.'));
    return failure(error);
  } finally {
    clearTimeout(deadline); clearTimeout(uploadDeadline);
    request.signal.removeEventListener('abort', cancel);
    active = false;
  }
}
