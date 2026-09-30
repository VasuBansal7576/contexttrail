import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

// Independent public request-size contract, including multipart framing.
const MAX_REQUEST_BYTES = 600 * 1024;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

async function req(form?: FormData): Promise<Request> {
  const encoded = new Response(form ?? new FormData());
  return new Request("http://localhost/api/investigate", {
    method: "POST", headers: encoded.headers, body: await encoded.arrayBuffer(),
  });
}

function formWith(media?: Blob): FormData {
  const f = new FormData();
  if (media) f.set("media", media, "upload.png");
  f.set("claim", "test claim");
  f.set("timezone", "UTC");
  f.set("locale", "en");
  return f;
}

async function readNdjson(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text();
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("POST /api/investigate — multipart validation", () => {
  it("accepts only the reviewed public image and preserves default live-off behavior", async () => {
    const form=formWith();form.set("public_image","nasa-earthrise");
    const res=await POST(await req(form));expect(res.status).toBe(200);
    const events=await readNdjson(res);
    expect(events[0]).toMatchObject({type:"investigation.error"});
  });
  it("rejects arbitrary public URLs, duplicate IDs, and mixing URL media with uploads", async () => {
    const arbitrary=formWith();arbitrary.set("public_image","https://private.invalid/image.jpg");
    expect((await POST(await req(arbitrary))).status).toBe(400);
    const duplicate=formWith();duplicate.append("public_image","nasa-earthrise");duplicate.append("public_image","nasa-earthrise");
    expect((await POST(await req(duplicate))).status).toBe(400);
    const mixed=formWith(new Blob([PNG],{type:"image/png"}));mixed.set("public_image","nasa-earthrise");
    expect((await POST(await req(mixed))).status).toBe(400);
  });
  it("caps the complete multipart including ignored fields before parsing", async () => {
    const form = formWith(new Blob([PNG], { type: "image/png" }));
    form.set("ignored", new Blob([new Uint8Array(2 * 1024 * 1024)]), "extra.bin");
    const request = await req(form);
    const parse = vi.spyOn(request, "formData");
    expect((await POST(request)).status).toBe(413);
    expect(parse).not.toHaveBeenCalled();
  });

  it("rejects missing media with 400", async () => {
    const res = await POST(await req(formWith(undefined)));
    expect(res.status).toBe(400);
  });

  it("rejects empty media with 400", async () => {
    const res = await POST(await req(formWith(new Blob([], { type: "image/png" }))));
    expect(res.status).toBe(400);
  });

  it("rejects oversized media with 413 (500 KB bound)", async () => {
    const big = new Blob([new Uint8Array(500 * 1024 + 1)], { type: "image/png" });
    const res = await POST(await req(formWith(big)));
    expect(res.status).toBe(413);
  });

  it("rejects non-image media types with 400", async () => {
    const res = await POST(await req(formWith(new Blob([PNG], { type: "application/pdf" }))));
    expect(res.status).toBe(400);
  });

  it("rejects non-multipart bodies with 400", async () => {
    const res = await POST(
      new Request("http://localhost/api/investigate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ claim: "x" }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("complete request stream boundary", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([null, "0", "64"])("caps ignored multipart data with declared length %s before any parser", async (length) => {
    const form = formWith(new Blob([PNG], { type: "image/png" }));
    form.set("ignored", new Blob([new Uint8Array(2 * 1024 * 1024)]), "ignored.bin");
    const encoded = new Response(form);
    const bytes = new Uint8Array(await encoded.arrayBuffer());
    let offset = 0;
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(c) { const next = Math.min(offset + 32 * 1024, bytes.length); c.enqueue(bytes.slice(offset, next)); offset = next; if (offset === bytes.length) c.close(); },
      cancel: cancelled,
    }, { highWaterMark: 0 });
    const headers = new Headers(encoded.headers);
    if (length !== null) headers.set("content-length", length);
    const request = new Request("http://localhost/api/investigate", { method: "POST", body, headers, duplex: "half" } as RequestInit);
    const parse = vi.spyOn(Response.prototype, "formData");
    expect((await POST(request)).status).toBe(413);
    expect(parse).not.toHaveBeenCalled();
    expect(cancelled).toHaveBeenCalledOnce();
    expect(offset).toBeLessThan(bytes.length);
    expect(offset).toBeLessThanOrEqual(MAX_REQUEST_BYTES + 32 * 1024);
    expect(body.locked).toBe(false);
  });

  it("rejects oversized declared length and cancels without reading or parsing", async () => {
    const pull = vi.fn(); const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const request = new Request("http://localhost/api/investigate", {
      method: "POST", body, duplex: "half", headers: { "content-length": String(MAX_REQUEST_BYTES + 1) },
    } as RequestInit);
    const parse = vi.spyOn(Response.prototype, "formData");
    expect((await POST(request)).status).toBe(413);
    expect(pull).not.toHaveBeenCalled(); expect(parse).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("accepts legitimate 500 KB media in chunked multipart with no length", async () => {
    const encoded = new Response(formWith(new Blob([new Uint8Array(500 * 1024)], { type: "image/png" })));
    const bytes = new Uint8Array(await encoded.arrayBuffer()); let offset = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) {
      const next = Math.min(offset + 8192, bytes.length); c.enqueue(bytes.slice(offset, next)); offset = next;
      if (offset === bytes.length) c.close();
    } }, { highWaterMark: 0 });
    vi.stubEnv("CONTEXTTRAIL_LIVE_ENABLED", "false");
    try {
      const response = await POST(new Request("http://localhost/api/investigate", { method: "POST", body, headers: encoded.headers, duplex: "half" } as RequestInit));
      expect(response.status).toBe(200); expect((await response.text())).toContain("LIVE_USAGE_DISABLED");
      expect(body.locked).toBe(false);
    } finally { vi.unstubAllEnvs(); }
  });

  it("aborted pending upload cancels source, releases reader and does not parse", async () => {
    const cancel = vi.fn(); const abort = new AbortController();
    const body = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
    const request = new Request("http://localhost/api/investigate", { method: "POST", body, signal: abort.signal, duplex: "half" } as RequestInit);
    const parse = vi.spyOn(Response.prototype, "formData"); const pending = POST(request);
    abort.abort(); expect((await pending).status).toBe(400);
    expect(cancel).toHaveBeenCalledOnce(); expect(parse).not.toHaveBeenCalled(); expect(body.locked).toBe(false);
  });

  it("failed upload stream releases its reader without parsing", async () => {
    const body = new ReadableStream<Uint8Array>({ pull(c) { c.error(new Error("synthetic upload failure")); } });
    const request = new Request("http://localhost/api/investigate", { method: "POST", body, duplex: "half" } as RequestInit);
    const parse = vi.spyOn(Response.prototype, "formData"); expect((await POST(request)).status).toBe(400);
    expect(parse).not.toHaveBeenCalled(); expect(body.locked).toBe(false);
  });
});

describe("POST /api/investigate — NDJSON stream contract", () => {
  beforeEach(() => {
    vi.stubEnv("CONTEXTTRAIL_LIVE_ENABLED", "false");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected network access")));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("streams an explicit admission rejection without claiming the DAG started", async () => {
    const res = await POST(await req(formWith(new Blob([PNG], { type: "image/png" }))));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");

    const events = await readNdjson(res);
    expect(events).toEqual([{
      type: "investigation.error",
      code: "LIVE_USAGE_DISABLED",
      message: "Live investigations are disabled. This preview does not contact providers.",
    }]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keyless preview never fabricates evidence or attempts a provider request", async () => {
    const res = await POST(await req(formWith(new Blob([PNG], { type: "image/png" }))));
    const events = await readNdjson(res);
    const last = events[events.length - 1] as { type?: string; code?: string; message?: string };
    expect(last.type).toBe("investigation.error");
    expect(last.code).toBe("LIVE_USAGE_DISABLED");
    expect(last.message).toContain("disabled");
    expect(events.every((e) => e.type !== "evidence.discovered")).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
});
