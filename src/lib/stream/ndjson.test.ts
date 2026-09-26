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

  it("does not yield a chunk that lands during an aborted read (A9 post-abort window)", async () => {
    // UNIT tier: a controlled body, not a browser wire. The pending
    // reader.read() is satisfied by a chunk enqueued AFTER the signal fired —
    // the abort landed inside the read, and nothing may be yielded for it.
    const encoder = new TextEncoder();
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
      },
    });
    const ac = new AbortController();
    const it = readNdjsonStream(stream, ac.signal);
    const pending = it.next(); // suspended inside await reader.read()
    ac.abort();
    ctrl.enqueue(
      encoder.encode('{"type":"evidence.discovered","evidence":{"id":"late-a"}}\n'),
    );
    const first = await pending;
    expect(first.done).toBe(true);
  });

  it("stops yielding events already buffered once the signal fires", async () => {
    // One chunk carries two complete lines; aborting after the first yield
    // must stop the second — a yield is a deliverable, not a flush buffer.
    const ac = new AbortController();
    const e1 = JSON.stringify({ type: "stage.started", stage: "INITIAL_RETRIEVAL" });
    const e2 = JSON.stringify({ type: "evidence.discovered", evidence: { id: "queued" } });
    const received = [];
    for await (const event of readNdjsonStream(
      streamFromChunks([`${e1}\n${e2}\n`]),
      ac.signal,
    )) {
      received.push(event);
      ac.abort();
    }
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ type: "stage.started" });
  });
});
