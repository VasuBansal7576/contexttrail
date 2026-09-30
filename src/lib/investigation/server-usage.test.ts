import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInvestigationResponse, productionDeps } from "./server";
import { JEV_MODEL } from "../jev/client";
import { SERPAPI_IMAGE_UPLOAD_URL } from "../serpapi/client";
import { readLiveUsageConfig, reserveLiveRun } from "./live-usage";

let dir: string;
let ledgerPath: string;
const input = { claim: null, timezone: "UTC", locale: "en", media: new Uint8Array([1, 2, 3]) };
const allowance = { searches: 40, uploads: 10, jevRequests: 600, jevQuestions: 1130 };
const configured = {
  CONTEXTTRAIL_LIVE_ENABLED: "true",
  CONTEXTTRAIL_LIVE_DEPLOYMENT: "single-host-persistent",
  CONTEXTTRAIL_FREE_ALLOWANCE_ACKNOWLEDGED: "true",
  CONTEXTTRAIL_FREE_ALLOWANCE_PERIOD: "test-period",
  CONTEXTTRAIL_FREE_SERPAPI_SEARCHES: "40",
  CONTEXTTRAIL_FREE_SERPAPI_UPLOADS: "10",
  CONTEXTTRAIL_FREE_JEV_REQUESTS: "600",
  CONTEXTTRAIL_FREE_JEV_QUESTIONS: "1130",
  SERPAPI_API_KEY: "test-only-serpapi",
  TYPESAFE_API_KEY: "test-only-typesafe",
};

beforeEach(async () => {
  await mkdir(resolve(".verify"), { recursive: true });
  dir = await mkdtemp(resolve(".verify/server-usage-"));
  ledgerPath = join(dir, "usage.ndjson");
  for (const key of ["VERCEL", "VERCEL_ENV", "NETLIFY", "AWS_LAMBDA_FUNCTION_NAME", "AWS_EXECUTION_ENV", "FUNCTIONS_WORKER_RUNTIME", "K_SERVICE", "CLOUD_RUN_JOB", "TYPESAFE_MODEL"]) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries(configured)) vi.stubEnv(key, value);
  vi.stubEnv("CONTEXTTRAIL_USAGE_LEDGER_PATH", ledgerPath);
  await writeFile(ledgerPath, `${JSON.stringify({ type: "contexttrail-live-usage", version: 1, model: JEV_MODEL, period: "test-period", allowance })}\n`);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

function emptyProviderResponse(url: RequestInfo | URL) {
  return Response.json(url.toString() === SERPAPI_IMAGE_UPLOAD_URL
    ? { image_id: "test-image" }
    : { search_metadata: { status: "Success" }, visual_matches: [], exact_matches: [], about_this_image: { sections: [] } });
}
async function events(response: Response): Promise<Array<Record<string, unknown>>> {
  return (await response.text()).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

describe("production server live admission", () => {
  it("blocks disabled preview even when both keys exist, without reserving", async () => {
    vi.stubEnv("CONTEXTTRAIL_LIVE_ENABLED", undefined);
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const result = await events(createInvestigationResponse(input));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: "investigation.error", code: "LIVE_USAGE_DISABLED" });
    expect(fetcher).not.toHaveBeenCalled();
    expect((await readFile(ledgerPath, "utf8")).trim().split("\n")).toHaveLength(1);
  });
  it("missing either key rejects admission honestly before reserving or dispatch", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    for (const key of ["SERPAPI_API_KEY", "TYPESAFE_API_KEY"]) {
      vi.stubEnv(key, undefined);
      const result = await events(createInvestigationResponse(input));
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ type: "investigation.error", code: "LIVE_USAGE_UNAVAILABLE" });
      expect(String(result[0].message)).toContain("server-only");
      vi.stubEnv(key, "test-only-value");
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect((await readFile(ledgerPath, "utf8")).trim().split("\n")).toHaveLength(1);
  });
  it("successful real DAG emits started/completed and releases only concurrency", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => emptyProviderResponse(url));
    vi.stubGlobal("fetch", fetcher);
    const result = await events(createInvestigationResponse(input));
    expect(result[0].type).toBe("investigation.started");
    expect(result[result.length - 1].type).toBe("investigation.completed");
    expect(fetcher).toHaveBeenCalled();
    await expect(stat(`${ledgerPath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readFile(ledgerPath, "utf8")).trim().split("\n")).toHaveLength(2);
  });
  it("provider failure releases concurrency without refunding the reservation", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new Error("controlled provider failure")));
    const result = await events(createInvestigationResponse(input));
    expect(result[0].type).toBe("investigation.started");
    expect(result[result.length - 1].type).toBe("investigation.error");
    await expect(stat(`${ledgerPath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readFile(ledgerPath, "utf8")).trim().split("\n")).toHaveLength(2);
  });
  it("stream cancellation keeps the global lock while provider body work is pending", async () => {
    const body = new TransformStream<Uint8Array, Uint8Array>();
    const writer = body.writable.getWriter();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body.readable));
    vi.stubGlobal("fetch", fetcher);
    const response = createInvestigationResponse(input);
    const reader = response.body!.getReader();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await writer.write(new TextEncoder().encode('{"image_id":"test-image"}'));
    await reader.cancel();
    await expect(reserveLiveRun(readLiveUsageConfig(process.env), null)).rejects.toThrow("owns the usage lock");
    await writer.close();
    await vi.waitFor(async () => {
      await expect(stat(`${ledgerPath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await readFile(ledgerPath, "utf8")).trim().split("\n")).toHaveLength(2);
  });
  it("incoming request abort and already-aborted requests are both respected", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    expect(await events(createInvestigationResponse(input, { signal: controller.signal }))).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    expect((await readFile(ledgerPath, "utf8")).trim().split("\n")).toHaveLength(1);
  });
  it("Jev production model is pinned regardless of development or production mode", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>());
    for (const mode of ["production", "development"] as const) {
      vi.stubEnv("NODE_ENV", mode);
      vi.stubEnv("TYPESAFE_MODEL", "jev-latest");
      await expect(productionDeps(input)).rejects.toThrow("pinned");
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
