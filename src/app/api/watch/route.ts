import { requireLocalResearchRequest } from '@/lib/research/local-boundary';
import { ResearchServiceError } from '@/lib/research/service';
import { checkWatch, watchService, watchStatus } from '@/lib/monitor/service';
import { object } from '@/lib/watchlists/parse';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
function failure(error: unknown) {
  return Response.json({ error: error instanceof ResearchServiceError ? error.message : 'Watch storage or input could not be validated. Retained history is preserved.' }, { status: error instanceof ResearchServiceError ? error.status : 400 });
}
export async function GET(request: Request) {
  try { requireLocalResearchRequest(request); return Response.json(await watchStatus(), { headers: { 'cache-control': 'no-store' } }); }
  catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    requireLocalResearchRequest(request);
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return Response.json({ error: 'Expected JSON' }, { status: 415 });
    // Stream limit applies even when a caller omits Content-Length.
    const reader = request.body?.getReader(); if (!reader) throw new Error('Missing body');
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 8192) { await reader.cancel(); return Response.json({ error: 'Watch request exceeds 8 KiB' }, { status: 413 }); } chunks.push(next.value); }
    const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')), action = object(input);
    if (action.kind === 'check') { if (typeof action.id !== 'string' || action.id.length > 200) throw new Error('Invalid watch ID'); await checkWatch(action.id); }
    else await watchService().apply(input);
    return Response.json(await watchStatus(), { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return failure(error); }
}
