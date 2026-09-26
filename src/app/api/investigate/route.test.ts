import { describe, expect, it } from "vitest";
import { POST } from "./route";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function req(form?: FormData): Request {
  return new Request("http://localhost/api/investigate", {
    method: "POST",
    body: form ?? new FormData(),
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
  it("rejects missing media with 400", async () => {
    const res = await POST(req(formWith(undefined)));
    expect(res.status).toBe(400);
  });

  it("rejects empty media with 400", async () => {
    const res = await POST(req(formWith(new Blob([], { type: "image/png" }))));
    expect(res.status).toBe(400);
  });

  it("rejects oversized media with 413 (500 KB bound)", async () => {
    const big = new Blob([new Uint8Array(500 * 1024 + 1)], { type: "image/png" });
    const res = await POST(req(formWith(big)));
    expect(res.status).toBe(413);
  });

  it("rejects non-image media types with 400", async () => {
    const res = await POST(req(formWith(new Blob([PNG], { type: "application/pdf" }))));
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

describe("POST /api/investigate — NDJSON stream contract", () => {
  it("streams application/x-ndjson events ending in a terminal event", async () => {
    const res = await POST(req(formWith(new Blob([PNG], { type: "image/png" }))));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");

    const events = await readNdjson(res);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].type).toBe("investigation.started");
    const terminalTypes = new Set(["investigation.completed", "investigation.error"]);
    expect(terminalTypes.has(String(events[events.length - 1].type))).toBe(true);
  });

  it("without provider keys the stream reports an honest provider failure", async () => {
    const res = await POST(req(formWith(new Blob([PNG], { type: "image/png" }))));
    const events = await readNdjson(res);
    const last = events[events.length - 1] as { type?: string; code?: string; message?: string };
    expect(last.type).toBe("investigation.error");
    expect(last.code).toBe("VISUAL_SEARCH_FAILED");
    // Names the missing key only — never a value, never fabricated evidence.
    expect(last.message).toContain("SERPAPI_API_KEY");
    expect(events.every((e) => e.type !== "evidence.discovered")).toBe(true);
  });
});
