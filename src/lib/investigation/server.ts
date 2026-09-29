/**
 * Server assembly for POST /api/investigate (spec §24).
 *
 * Builds the real provider clients from server-only env, then streams
 * §24.2 NDJSON events produced by `runInvestigation`. There is no fixture,
 * simulation, or demo fallback anywhere in this path (§40): missing
 * configuration surfaces as honest provider failure events.
 */

import type { InvestigationInput } from "./contracts/investigation";
import { encodeEvent, type InvestigationEvent } from "./contracts/events";
import { runInvestigation, type RunDeps } from "./run";
import { JevClient } from "../jev/client";
import { SerpapiClient } from "../serpapi/client";
import { fetchPageHtml } from "../pages/fetch";

export const NDJSON_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";

/** Build provider deps from server-only env. Never reads NEXT_PUBLIC_*. */
export function productionDeps(externalSignal?: AbortSignal): RunDeps {
  const serpapiKey = process.env.SERPAPI_API_KEY;
  const jevKey = process.env.TYPESAFE_API_KEY;
  return {
    serpapi:
      typeof serpapiKey === "string" && serpapiKey.length > 0
        ? new SerpapiClient(serpapiKey)
        : null,
    jev:
      typeof jevKey === "string" && jevKey.length > 0
        ? new JevClient({
            apiKey: jevKey,
            model: process.env.TYPESAFE_MODEL || undefined,
          })
        : null,
    fetchPage: (url, signal) => fetchPageHtml(url, signal),
    signal: externalSignal,
  };
}

/**
 * Create the streamed NDJSON response for one investigation.
 * `deps` may be overridden in tests; production uses `productionDeps`.
 */
export function createInvestigationResponse(
  input: InvestigationInput,
  deps?: Partial<RunDeps>,
): Response {
  const encoder = new TextEncoder();
  const controller = new AbortController();

  const stream = new ReadableStream<Uint8Array>({
    start(streamCtl) {
      const emit = (event: InvestigationEvent) => {
        try {
          streamCtl.enqueue(encoder.encode(encodeEvent(event)));
        } catch {
          // Stream already closed (client gone) — stop producing work.
          controller.abort();
        }
      };
      let prod: RunDeps | null = null;
      const prodDeps = () => (prod ??= productionDeps(controller.signal));
      const runDeps: RunDeps = {
        serpapi: deps?.serpapi !== undefined ? deps.serpapi : prodDeps().serpapi,
        jev: deps?.jev !== undefined ? deps.jev : prodDeps().jev,
        fetchPage: deps?.fetchPage ?? ((url, signal) => fetchPageHtml(url, signal)),
        signal: controller.signal,
      };
      // Link the incoming request's abort into the shared controller,
      // including the already-aborted case the listener would miss.
      if (deps?.signal?.aborted) controller.abort(deps.signal.reason);
      else
        deps?.signal?.addEventListener("abort", () => controller.abort(deps.signal?.reason), {
          once: true,
        });
      void runInvestigation(input, emit, runDeps)
        .catch(() => {
          emit({
            type: "investigation.error",
            code: "INTERNAL_ERROR",
            message: "The investigation failed unexpectedly. No evidence was fabricated to fill the gap.",
          });
        })
        .finally(() => {
          try {
            streamCtl.close();
          } catch {
            // already closed
          }
        });
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
