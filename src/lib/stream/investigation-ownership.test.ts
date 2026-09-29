/**
 * A9 stale-run ownership controls — UNIT tier, deterministic, not browser.
 *
 * These tests drive the actual `useInvestigation` hook (public start/cancel/
 * reset surface only) and the actual `readNdjsonStream` reader through
 * react-dom inside a jsdom document. Transport is a controlled
 * `ReadableStream`: a superseded run's late/close/error continuation is
 * replayed asynchronously exactly where Astra's source review identified the
 * phase-only ownership gap. Nothing here claims the wire can deliver this in
 * a browser — it proves the client library honours its own
 * cancellation/supersession contract when it can.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useInvestigation } from "./useInvestigation";

const encoder = new TextEncoder();
const line = (event: object) => encoder.encode(`${JSON.stringify(event)}\n`);
const discovered = (id: string) => ({
  type: "evidence.discovered",
  evidence: { id, canonicalUrl: `https://unit.example/${id}` },
});
const completed = (marker: string) => ({
  type: "investigation.completed",
  result: { mode: "trace", headline: "LIMITED_MEDIA_HISTORY_FOUND", marker },
});

type ControlledBody = {
  stream: ReadableStream<Uint8Array>;
  ctrl: ReadableStreamDefaultController<Uint8Array>;
};
const controlledBody = (): ControlledBody => {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  return { stream, ctrl };
};

type HookApi = ReturnType<typeof useInvestigation>;
let api!: HookApi;
function Probe() {
  api = useInvestigation();
  return null;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("stale-run ownership — a superseded stream cannot touch its successor", () => {
  let dom: JSDOM;
  let root: Root;
  let container: HTMLElement;
  let activeBody: ControlledBody | null;
  const g = globalThis as Record<string, unknown>;

  beforeEach(async () => {
    dom = new JSDOM("<!doctype html><html><body></body></html>", {
      url: "http://localhost/",
    });
    g.IS_REACT_ACT_ENVIRONMENT = true;
    g.document = dom.window.document;
    g.window = dom.window;
    g.sessionStorage = dom.window.sessionStorage;
    activeBody = null;
    g.fetch = vi.fn(async () => ({
      ok: true,
      headers: { get: () => "application/x-ndjson" },
      body: activeBody?.stream ?? null,
    }));
    container = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(Probe));
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    dom.window.close();
    delete g.fetch;
    delete g.document;
    delete g.window;
    delete g.sessionStorage;
  });

  /** Start a run through the public surface and let it reach `streaming`. */
  const start = async (body: ControlledBody) => {
    activeBody = body;
    await act(async () => {
      void api.start({ media: new Blob([new Uint8Array([1])]), claim: null });
      await tick();
    });
    await act(async () => {
      await tick();
    });
    expect(api.phase).toBe("streaming");
  };

  it("a stale run's stream-completion bookkeeping cannot fail run B", async () => {
    const a = controlledBody();
    await start(a);
    a.ctrl.enqueue(line(discovered("a-evidence")));
    await act(async () => {
      await tick();
    });
    expect(api.evidence.map((e) => e.id)).toContain("a-evidence");

    await act(async () => {
      api.cancel();
    });
    expect(api.phase).toBe("cancelled");

    const b = controlledBody();
    await start(b);
    b.ctrl.enqueue(line({ type: "investigation.started", investigationId: "b-run" }));
    b.ctrl.enqueue(line(discovered("b-evidence")));
    await act(async () => {
      await tick();
    });
    expect(api.investigationId).toBe("b-run");

    // The superseded stream closes: A's suspended read settles, its for-await
    // exits, and its completion bookkeeping runs against the shared snapshot.
    a.ctrl.close();
    await act(async () => {
      await tick();
    });

    // B must remain streaming, unharmed, with only its own identity/evidence.
    expect(api.phase).toBe("streaming");
    expect(api.investigationId).toBe("b-run");
    expect(api.error).toBeNull();
    expect(api.evidence.map((e) => e.id)).not.toContain("a-evidence");

    // And B can still complete normally, owned end to end.
    b.ctrl.enqueue(line(completed("b-result")));
    await act(async () => {
      await tick();
    });
    expect(api.phase).toBe("completed");
    expect((api.result as { marker: string }).marker).toBe("b-result");
    const cached = JSON.parse(
      dom.window.sessionStorage.getItem("contexttrail.latest-result") ?? "{}",
    ) as { marker?: string };
    expect(cached.marker).toBe("b-result");
  });

  it("a stale run's transport failure cannot cancel run B", async () => {
    const a = controlledBody();
    await start(a);
    await act(async () => {
      api.cancel();
    });
    const b = controlledBody();
    await start(b);

    // A's suspended read rejects: its catch path classifies against ITS OWN
    // aborted controller and must not rewrite B's phase.
    a.ctrl.error(new Error("stale transport failure"));
    await act(async () => {
      await tick();
    });

    expect(api.phase).toBe("streaming");
    expect(api.error).toBeNull();
  });

  it("a late event on a superseded stream cannot contaminate B's state", async () => {
    const a = controlledBody();
    await start(a);
    await act(async () => {
      api.cancel();
    });
    const b = controlledBody();
    await start(b);
    b.ctrl.enqueue(line({ type: "investigation.started", investigationId: "b-run" }));
    await act(async () => {
      await tick();
    });

    // A chunk arrives for the superseded stream — the post-abort yield window.
    // A's completed event would otherwise mark B completed and write B's
    // sessionStorage cache with A's result.
    a.ctrl.enqueue(line(completed("a-result")));
    await act(async () => {
      await tick();
    });

    expect(api.phase).toBe("streaming");
    expect(api.result).toBeNull();
    expect(api.investigationId).toBe("b-run");
    expect(dom.window.sessionStorage.getItem("contexttrail.latest-result")).toBeNull();
  });

  it("a live run's own cancel still classifies as user cancellation", async () => {
    // Opposing control: the ownership token must not swallow a TRUE cancel on
    // the current run — cancelled phase, no error, no fabricated result.
    const a = controlledBody();
    await start(a);
    a.ctrl.enqueue(line(discovered("a-evidence")));
    await act(async () => {
      await tick();
    });
    await act(async () => {
      api.cancel();
      await tick();
    });
    expect(api.phase).toBe("cancelled");
    expect(api.error).toBeNull();
    expect(api.result).toBeNull();
    // The cancelled run's own stream ends; no stale state is left to migrate.
    a.ctrl.close();
    await act(async () => {
      await tick();
    });
    expect(api.phase).toBe("cancelled");
  });
});
