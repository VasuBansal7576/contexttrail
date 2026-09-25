import { describe, expect, it } from "vitest";
import { readNdjsonStream } from "./ndjson";

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("readNdjsonStream", () => {
  it("reassembles events split across chunks", async () => {
    const line1 = JSON.stringify({ type: "stage.started", stage: "INITIAL_RETRIEVAL" });
    const line2 = JSON.stringify({ type: "search.batch", engine: "google_lens", count: 18 });
    const received = [];
    for await (const event of readNdjsonStream(
      streamFromChunks([line1.slice(0, 20), line1.slice(20) + "\n" + line2.slice(0, 10), line2.slice(10) + "\n"]),
    )) {
      received.push(event);
    }
    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({ type: "stage.started" });
    expect(received[1]).toMatchObject({ type: "search.batch", count: 18 });
  });

  it("skips malformed lines without aborting the stream", async () => {
    const good = JSON.stringify({ type: "investigation.started", investigationId: "abc" });
    const received = [];
    for await (const event of readNdjsonStream(
      streamFromChunks([`{broken\n${good}\n\n[1,2]\n`]),
    )) {
      received.push(event);
    }
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ type: "investigation.started" });
  });

  it("yields a final line without a trailing newline", async () => {
    const line = JSON.stringify({ type: "investigation.error", code: "x", message: "y" });
    const received = [];
    for await (const event of readNdjsonStream(streamFromChunks([line]))) {
      received.push(event);
    }
    expect(received).toHaveLength(1);
  });
});
