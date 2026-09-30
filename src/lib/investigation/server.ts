/** Server-only live assembly. Keyless previews never contact providers. */
import type { InvestigationInput } from "./contracts/investigation";
import { encodeEvent, type InvestigationEvent } from "./contracts/events";
import { runInvestigation, type RunDeps } from "./run";
import { JevClient, JEV_MODEL } from "../jev/client";
import { SerpapiClient } from "../serpapi/client";
import { fetchPageHtml } from "../pages/fetch";
import { LiveUsageError, readLiveUsageConfig, reserveLiveRun } from "./live-usage";
import { isPublicImageId } from "../media/public-images";

export const NDJSON_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";

/** Admission and durable worst-case reservation happen before client creation. */
export async function productionDeps(input: InvestigationInput, externalSignal?: AbortSignal): Promise<{
  deps: RunDeps;
  release: () => Promise<void>;
}> {
  const config = readLiveUsageConfig(process.env);
  if (input.publicImageId !== undefined && !isPublicImageId(input.publicImageId)) {
    throw new LiveUsageError("The public image is not in the reviewed catalogue. No provider requests were made.");
  }
  const serpapiKey = process.env.SERPAPI_API_KEY?.trim();
  const jevKey = process.env.TYPESAFE_API_KEY?.trim();
  if (!serpapiKey || !jevKey) {
    throw new LiveUsageError("Live investigations require server-only SerpApi and TypeSafe keys. No provider requests were made.");
  }
  const lease = await reserveLiveRun(config, input.claim, externalSignal, input.publicImageId !== undefined);
  return {
    deps: {
      serpapi: new SerpapiClient(serpapiKey, { fetchImpl: lease.fetchFor("serpapi") }),
      jev: new JevClient({ apiKey: jevKey, model: JEV_MODEL, fetchImpl: lease.fetchFor("jev") }),
      fetchPage: (url, signal) => fetchPageHtml(url, signal),
      signal: externalSignal,
    },
    release: () => lease.release(),
  };
}

/** Request data has no provider, model, quota, or storage override surface. */
export function createInvestigationResponse(
  input: InvestigationInput,
  options: { signal?: AbortSignal } = {},
): Response {
  const encoder = new TextEncoder();
  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });

  const stream = new ReadableStream<Uint8Array>({
    start(streamCtl) {
      const emit = (event: InvestigationEvent) => {
        try {
          streamCtl.enqueue(encoder.encode(encodeEvent(event)));
        } catch {
          controller.abort();
        }
      };
      void (async () => {
        let production: Awaited<ReturnType<typeof productionDeps>> | undefined;
        try {
          if (controller.signal.aborted) return;
          production = await productionDeps(input, controller.signal);
          if (!controller.signal.aborted) await runInvestigation(input, emit, production.deps);
        } catch (error) {
          if (!controller.signal.aborted) {
            emit({
              type: "investigation.error",
              code: error instanceof LiveUsageError ? error.code : "INTERNAL_ERROR",
              message: error instanceof LiveUsageError
                ? error.message
                : "The investigation failed unexpectedly. No evidence was fabricated to fill the gap.",
            });
          }
        } finally {
          // Cancellation stops dispatch; ownership lasts until provider work settles.
          try { await production?.release(); } catch {
            // Failed release leaves the durable lock in place and fails closed.
            // Do not leak ledger paths, keys, or raw filesystem exceptions.
            console.warn("[investigate] live usage lock release failed; further live use remains blocked");
          }
          options.signal?.removeEventListener("abort", onAbort);
          try { streamCtl.close(); } catch { /* client already gone */ }
        }
      })();
    },
    cancel() {
      controller.abort();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": NDJSON_CONTENT_TYPE,
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}
