/** Server-only assembly. Automatic flows share the image gate and durable lock. */
import { JevClient, JEV_MODEL } from '../jev/client';
import { SerpapiClient } from '../serpapi/client';
import { fetchPageDocument } from '../pages/fetch';
import { LiveUsageError, readLiveUsageConfig, reserveVideoRun, reserveTopicRun } from '../investigation/live-usage';
import { VideoIngestError } from '../video/ingest';
import { runAutomaticResearch, type AutomaticResearchDeps } from './automatic';
import type { AutomaticResearchInput, AutomaticResearchEvent } from './automatic-contract';

export function automaticConfiguration(): void {
  readLiveUsageConfig(process.env);
  if (!process.env.SERPAPI_API_KEY?.trim() || !process.env.TYPESAFE_API_KEY?.trim()) throw new LiveUsageError('Live investigations require server-only SerpApi and TypeSafe keys. No provider requests were made.');
}
export async function automaticProductionDeps(input: AutomaticResearchInput, signal: AbortSignal): Promise<{ deps: AutomaticResearchDeps; release: () => Promise<void> }> {
  automaticConfiguration();
  const config = readLiveUsageConfig(process.env);
  const serpapiKey = process.env.SERPAPI_API_KEY?.trim();
  const jevKey = process.env.TYPESAFE_API_KEY?.trim();
  if (!serpapiKey || !jevKey) throw new LiveUsageError('Provider configuration unavailable.');
  // One reservation covers the entire workflow. No ledger resets, nested image
  // admissions, per-frame refunds, or independent request counters are allowed.
  const lease = input.kind !== 'video' ? await reserveTopicRun(config, signal) : await reserveVideoRun(config, input.claim ?? null, signal);
  return { deps: { serpapi: new SerpapiClient(serpapiKey, { fetchImpl: lease.fetchFor('serpapi') }),
    jev: new JevClient({ apiKey: jevKey, model: JEV_MODEL, fetchImpl: lease.fetchFor('jev') }),
    fetchPage: fetchPageDocument, signal }, release: () => lease.release() };
}
export function automaticFailure(error: unknown): string {
  if (error instanceof LiveUsageError) return error.message;
  if (error instanceof VideoIngestError) {
    if (error.code === 'decoder_unavailable') return 'Local FFmpeg/FFprobe is unavailable. No video frames were searched.';
    if (error.code === 'limit_exceeded') return 'Video exceeded the bounded decoder size, duration, dimensions or time limits.';
    return 'The supplied video could not be decoded within the supported formats. No evidence was fabricated.';
  }
  return 'The investigation could not complete. No evidence was fabricated to fill the gap.';
}
export function createAutomaticResponse(input: AutomaticResearchInput, options: {
  signal: AbortSignal;
  onSettled?: () => void;
  /** Dependency injection for offline verification; never selected by request data. */
  production?: typeof automaticProductionDeps;
}): Response {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal.addEventListener('abort', abort, { once: true });
  if (options.signal.aborted) abort();
  let deadlineHit = false;
  const deadlineMs = input.kind === 'video' ? 420_000 : input.kind === 'audio' ? 300_000 : 180_000;
  const deadline = setTimeout(() => { if (!controller.signal.aborted) { deadlineHit = true; abort(); } }, deadlineMs);
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      const emit = (event: AutomaticResearchEvent, terminalDeadline = false) => {
        if (controller.signal.aborted && !terminalDeadline) return;
        try { streamController.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`)); }
        catch { controller.abort(); }
      };
      void (async () => {
        let production: Awaited<ReturnType<typeof automaticProductionDeps>> | undefined;
        try {
          controller.signal.throwIfAborted();
          production = await (options.production ?? automaticProductionDeps)(input, controller.signal);
          const result = await runAutomaticResearch(input, emit, production.deps);
          emit({ type: 'research.completed', result });
        } catch (error) {
          emit({ type: 'research.error', message: deadlineHit ? `The investigation exceeded its ${input.kind === 'video' ? 'seven' : input.kind === 'audio' ? 'five' : 'three'}-minute deadline. No complete result was produced; its reservation is not refunded.` : automaticFailure(error) }, deadlineHit);
        }
        finally {
          try { await production?.release(); } catch { console.warn('[research] live lock release failed; further live use remains blocked'); }
          clearTimeout(deadline); options.signal.removeEventListener('abort', abort);
          options.onSettled?.();
          try { streamController.close(); } catch { /* The client has cancelled. */ }
        }
      })();
    },
    cancel() { controller.abort(); },
  });
  return new Response(stream, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-accel-buffering': 'no' } });
}
