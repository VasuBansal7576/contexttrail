/**
 * NDJSON stream reader for `POST /api/investigate`.
 *
 * The server responds with `application/x-ndjson`: one JSON event per line
 * (spec section 24.1). This reader yields parsed events incrementally and
 * skips malformed lines so one bad chunk never kills an investigation.
 */
import { parseEventLine, type InvestigationEvent } from "./events";

export async function* readNdjsonStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<InvestigationEvent, void, void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const event = parseEventLine(line);
        if (event) yield event;
      }
      if (done) break;
    }
    const tail = parseEventLine(buffer);
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}
