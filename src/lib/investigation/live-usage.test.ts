import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  liveRunAllocation, readLiveUsageConfig, reserveLiveRun,
  type LiveUsageConfig, type LiveRunLease,
} from "./live-usage";
import { JEV_ENDPOINT, JEV_MODEL } from "../jev/client";
import { SERPAPI_IMAGE_UPLOAD_URL, SERPAPI_SEARCH_URL } from "../serpapi/client";

const exec = promisify(execFile);
const base = resolve(".verify");
let dir: string;
let config: LiveUsageConfig;
let env: NodeJS.ProcessEnv;
const leases: LiveRunLease[] = [];

function header(c = config) {
  return { type: "contexttrail-live-usage", version: 1, model: JEV_MODEL, period: c.period, allowance: c.allowance };
}
async function initialize(c = config) {
  await writeFile(c.ledgerPath, `${JSON.stringify(header(c))}\n`, { flag: "wx" });
}
async function lease(claim: string | null = null, signal?: AbortSignal) {
  const value = await reserveLiveRun(config, claim, signal);
  leases.push(value);
  return value;
}
function jevBody(questions = 1, model = JEV_MODEL) {
  return { method: "POST", body: JSON.stringify({ model, questions: Object.fromEntries(Array.from({ length: questions }, (_, i) => [`q${i}`, { type: "noul" }])) }) };
}

beforeEach(async () => {
  await mkdir(base, { recursive: true });
  dir = await mkdtemp(join(base, "usage-tests-"));
  config = { ledgerPath: join(dir, "usage.ndjson"), period: "test-period", allowance: { searches: 60, uploads: 10, jevRequests: 600, jevQuestions: 2720 } };
  env = {
    NODE_ENV: "test",
    CONTEXTTRAIL_LIVE_ENABLED: "true",
    CONTEXTTRAIL_LIVE_DEPLOYMENT: "single-host-persistent",
    CONTEXTTRAIL_FREE_ALLOWANCE_ACKNOWLEDGED: "true",
    CONTEXTTRAIL_USAGE_LEDGER_PATH: config.ledgerPath,
    CONTEXTTRAIL_FREE_ALLOWANCE_PERIOD: config.period,
    CONTEXTTRAIL_FREE_SERPAPI_SEARCHES: "60",
    CONTEXTTRAIL_FREE_SERPAPI_UPLOADS: "10",
    CONTEXTTRAIL_FREE_JEV_REQUESTS: "600",
    CONTEXTTRAIL_FREE_JEV_QUESTIONS: "2720",
  };
});
afterEach(async () => {
  await Promise.all(leases.splice(0).map((value) => value.release().catch(() => undefined)));
  await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("server-only opt-in configuration", () => {
  it("defaults to keyless, no-network preview even with provider keys", () => {
    expect(() => readLiveUsageConfig({ SERPAPI_API_KEY: "test", TYPESAFE_API_KEY: "test" })).toThrow("disabled");
    expect(() => readLiveUsageConfig({ NEXT_PUBLIC_CONTEXTTRAIL_LIVE_ENABLED: "true" })).toThrow("disabled");
  });
  it("accepts only explicit integer allowances and a fixed pinned model", () => {
    expect(readLiveUsageConfig(env)).toEqual(config);
    expect(readLiveUsageConfig({ ...env, TYPESAFE_MODEL: JEV_MODEL })).toEqual(config);
    expect(() => readLiveUsageConfig({ ...env, TYPESAFE_MODEL: "jev-latest" })).toThrow("pinned");
    expect(() => readLiveUsageConfig({ ...env, TYPESAFE_MODEL: "" })).toThrow("pinned");
    expect(() => readLiveUsageConfig({ ...env, CONTEXTTRAIL_FREE_ALLOWANCE_ACKNOWLEDGED: undefined })).toThrow("confirm");
    expect(() => readLiveUsageConfig({ ...env, CONTEXTTRAIL_FREE_ALLOWANCE_PERIOD: undefined })).toThrow("period");
  });
  it.each([undefined, "", "-1", "1.5", "Infinity", "NaN", " 3", "01", "1e3", "9007199254740992"])("rejects malformed cap %s", (cap) => {
    expect(() => readLiveUsageConfig({ ...env, CONTEXTTRAIL_FREE_JEV_REQUESTS: cap })).toThrow("finite integer");
  });
  it.each(["VERCEL", "VERCEL_ENV", "NETLIFY", "AWS_LAMBDA_FUNCTION_NAME", "AWS_EXECUTION_ENV", "FUNCTIONS_WORKER_RUNTIME", "K_SERVICE", "CLOUD_RUN_JOB"])("refuses serverless marker %s", (marker) => {
    expect(() => readLiveUsageConfig({ ...env, [marker]: "1" })).toThrow("serverless");
  });
  it("requires a normalized absolute persistent path and explicit deployment type", () => {
    for (const path of [undefined, "relative/usage", `${dir}/../usage`]) {
      expect(() => readLiveUsageConfig({ ...env, CONTEXTTRAIL_USAGE_LEDGER_PATH: path })).toThrow("absolute");
    }
    expect(() => readLiveUsageConfig({ ...env, CONTEXTTRAIL_LIVE_DEPLOYMENT: undefined })).toThrow("one host");
  });
  it("reserves the real DAG ceiling including adaptive re-attempts and refinement", () => {
    expect(liveRunAllocation("claim")).toEqual({ searches: 6, uploads: 1, jevRequests: 60, jevQuestions: 272 });
    expect(liveRunAllocation(null)).toEqual({ searches: 4, uploads: 1, jevRequests: 60, jevQuestions: 113 });
    expect(liveRunAllocation("   ")).toEqual(liveRunAllocation(null));
  });
});

describe("durable whole-run admission", () => {
  it("offline initializer produces the exact runtime format and never resets it", async () => {
    const script = resolve("scripts/init-live-usage-ledger.mjs");
    const result = await exec(process.execPath, [script], { env });
    expect(result.stdout).toContain("No provider balance");
    expect(JSON.parse((await readFile(config.ledgerPath, "utf8")).trim())).toEqual(header());
    const admitted = await lease();
    await admitted.release();
    const before = await readFile(config.ledgerPath, "utf8");
    await expect(exec(process.execPath, [script], { env })).rejects.toThrow();
    expect(await readFile(config.ledgerPath, "utf8")).toBe(before);
  });
  it("missing ledger never auto-initializes", async () => {
    await expect(lease()).rejects.toThrow("storage");
    await expect(stat(config.ledgerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("charges each full reservation permanently across new module instances", async () => {
    config.allowance = { searches: 8, uploads: 2, jevRequests: 120, jevQuestions: 226 };
    await initialize();
    const one = await lease();
    await one.release();
    vi.resetModules();
    const restarted = await import("./live-usage");
    const two = await restarted.reserveLiveRun(config, null);
    await two.release();
    await expect(restarted.reserveLiveRun(config, null)).rejects.toThrow("cannot cover");
    const entries = (await readFile(config.ledgerPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(entries).toHaveLength(3);
    expect(entries[1].allocation).toEqual(liveRunAllocation(null));
    expect(entries[2].allocation).toEqual(liveRunAllocation(null));
  });
  it("permits only one winner when independent admissions race", async () => {
    await initialize();
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => lease()));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(11);
    expect((await readFile(config.ledgerPath, "utf8")).trim().split("\n")).toHaveLength(2);
    await leases[0].release();
    await expect(stat(`${config.ledgerPath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    const next = await lease();
    await next.release();
  });
  it("release is idempotent and does not refund the reservation", async () => {
    await initialize();
    const admitted = await lease();
    const charged = await readFile(config.ledgerPath, "utf8");
    await Promise.all([admitted.release(), admitted.release()]);
    expect(await readFile(config.ledgerPath, "utf8")).toBe(charged);
  });
  it("preserves a stale/crashed lock and never recovers it automatically", async () => {
    await initialize();
    await writeFile(`${config.ledgerPath}.lock`, "previous process crashed");
    await expect(lease()).rejects.toThrow("stopped unexpectedly");
    expect(await readFile(`${config.ledgerPath}.lock`, "utf8")).toBe("previous process crashed");
    expect((await readFile(config.ledgerPath, "utf8")).trim().split("\n")).toHaveLength(1);
  });
  it("honors a lock created by another actual process", async () => {
    await initialize();
    await exec(process.execPath, ["-e", "require('fs').writeFileSync(process.argv[1], 'other-process', {flag: 'wx'})", `${config.ledgerPath}.lock`], { env: { NODE_ENV: "test" } });
    await expect(lease()).rejects.toThrow("owns the usage lock");
  });
  it("does not remove ownership replaced by another actor", async () => {
    await initialize();
    const admitted = await lease();
    await writeFile(`${config.ledgerPath}.lock`, "another-owner");
    await expect(admitted.release()).rejects.toThrow("storage");
    expect(await readFile(`${config.ledgerPath}.lock`, "utf8")).toBe("another-owner");
  });
  it("refuses exhausted or zero allowances without appending a reservation", async () => {
    config.allowance.jevQuestions = 0;
    await initialize();
    const before = await readFile(config.ledgerPath, "utf8");
    await expect(lease()).rejects.toThrow("cannot cover");
    expect(await readFile(config.ledgerPath, "utf8")).toBe(before);
  });
  it.each(["model", "period", "allowance"])("refuses %s changes against existing history", async (key) => {
    await initialize();
    const invalid = { ...header(), [key]: key === "allowance" ? { ...config.allowance, searches: 61 } : "changed" };
    await writeFile(config.ledgerPath, `${JSON.stringify(invalid)}\n`);
    await expect(lease()).rejects.toThrow("storage");
  });
  it.each(["", "not-json\n", "{}\n", "{\"type\":\"reserve\"}\n", " ", "\n"])("fails closed on invalid ledger %j", async (raw) => {
    await writeFile(config.ledgerPath, raw);
    await expect(lease()).rejects.toThrow("storage");
    expect(await readFile(config.ledgerPath, "utf8")).toBe(raw);
  });
  it("rejects torn append, duplicate reservations, and over-cap histories", async () => {
    await initialize();
    const admitted = await lease();
    await admitted.release();
    const valid = await readFile(config.ledgerPath, "utf8");
    const entry = valid.trim().split("\n")[1];
    for (const invalid of [valid.slice(0, -1), valid + entry + "\n", valid + '{"type":"reserve","id":"00000000-0000-0000-0000-000000000000","allocation":{"searches":-1,"uploads":1,"jevRequests":60,"jevQuestions":113}}\n']) {
      await writeFile(config.ledgerPath, invalid);
      await expect(lease()).rejects.toThrow("storage");
    }
  });
  it("refuses oversized ledgers, ledger symlinks, and ephemeral directories", async () => {
    await writeFile(config.ledgerPath, "x".repeat(1_048_577));
    await expect(lease()).rejects.toThrow("storage");
    await rm(config.ledgerPath);
    await writeFile(join(dir, "target"), `${JSON.stringify(header())}\n`);
    await symlink(join(dir, "target"), config.ledgerPath);
    await expect(lease()).rejects.toThrow("storage");
    await expect(reserveLiveRun({ ...config, ledgerPath: "/tmp/contexttrail-test-never-created" }, null)).rejects.toThrow("storage");
  });
});

describe("actual provider dispatch caps and cancellation", () => {
  it("counts failed search/upload attempts and refuses over-budget dispatch", async () => {
    await initialize();
    const admitted = await lease();
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("controlled failure"));
    const guarded = admitted.fetchFor("serpapi", fetcher);
    for (let i = 0; i < 4; i++) await expect(guarded(`${SERPAPI_SEARCH_URL}?q=example`)).rejects.toThrow("controlled failure");
    await expect(guarded(SERPAPI_SEARCH_URL)).rejects.toThrow("exceeded");
    await expect(guarded(SERPAPI_IMAGE_UPLOAD_URL, { method: "POST" })).rejects.toThrow("controlled failure");
    await expect(guarded(SERPAPI_IMAGE_UPLOAD_URL, { method: "POST" })).rejects.toThrow("exceeded");
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(fetcher.mock.calls.every(([, init]) => init?.redirect === "error")).toBe(true);
  });
  it("enforces 60 Jev requests even if every response is cheap or failed", async () => {
    await initialize();
    const admitted = await lease();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response("{}"));
    const guarded = admitted.fetchFor("jev", fetcher);
    await Promise.all(Array.from({ length: 60 }, () => guarded(JEV_ENDPOINT, jevBody())));
    await expect(guarded(JEV_ENDPOINT, jevBody())).rejects.toThrow("exceeded");
    expect(fetcher).toHaveBeenCalledTimes(60);
  });
  it("enforces Jev question allowance separately from request allowance", async () => {
    await initialize();
    const admitted = await lease("claim");
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response("{}"));
    const guarded = admitted.fetchFor("jev", fetcher);
    for (let i = 0; i < 54; i++) await guarded(JEV_ENDPOINT, jevBody(5));
    await guarded(JEV_ENDPOINT, jevBody(2));
    await expect(guarded(JEV_ENDPOINT, jevBody())).rejects.toThrow("exceeded");
    expect(fetcher).toHaveBeenCalledTimes(55);
  });
  it("refuses model changes, unexpected destinations and malformed question sets", async () => {
    await initialize();
    const admitted = await lease();
    const fetcher = vi.fn<typeof fetch>();
    const guarded = admitted.fetchFor("jev", fetcher);
    await expect(guarded(JEV_ENDPOINT, jevBody(1, "jev-latest"))).rejects.toThrow("model");
    await expect(guarded("https://other.example/api", jevBody())).rejects.toThrow("endpoint");
    await expect(guarded(JEV_ENDPOINT, jevBody(0))).rejects.toThrow("question count");
    await expect(guarded(JEV_ENDPOINT, jevBody(6))).rejects.toThrow("question count");
    await expect(guarded(JEV_ENDPOINT, { body: "not-json" })).rejects.toThrow("Invalid");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("already-aborted runs do not reserve or dispatch", async () => {
    await initialize();
    const controller = new AbortController();
    controller.abort();
    await expect(lease(null, controller.signal)).rejects.toThrow("cancelled");
    expect((await readFile(config.ledgerPath, "utf8")).trim().split("\n")).toHaveLength(1);
  });
  it("holds ownership after cancellation until outstanding provider work settles", async () => {
    await initialize();
    const controller = new AbortController();
    const admitted = await lease(null, controller.signal);
    let finish: (response: Response) => void = () => { throw new Error("fetch not started"); };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const guarded = admitted.fetchFor("serpapi", fetcher);
    const pending = guarded(SERPAPI_IMAGE_UPLOAD_URL, { method: "POST" });
    controller.abort();
    const closing = admitted.release();
    await expect(lease()).rejects.toThrow("owns the usage lock");
    await expect(guarded(SERPAPI_SEARCH_URL)).rejects.toThrow("closed or cancelled");
    finish(new Response("{}"));
    await pending;
    await closing;
    const next = await lease();
    await next.release();
    expect((await readFile(config.ledgerPath, "utf8")).trim().split("\n")).toHaveLength(3);
  });
});

describe("provider response-body lifetime", () => {
  it("holds the lock until a slow response body finishes after headers", async () => {
    await initialize();
    const admitted = await lease();
    const body = new TransformStream<Uint8Array, Uint8Array>();
    const writer = body.writable.getWriter();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body.readable));
    const pending = admitted.fetchFor("jev", fetcher)(JEV_ENDPOINT, jevBody());
    await writer.write(new TextEncoder().encode("{}"));
    const closing = admitted.release();
    await expect(lease()).rejects.toThrow("owns the usage lock");
    await writer.close();
    expect(await (await pending).json()).toEqual({});
    await closing;
    await expect(stat(`${config.ledgerPath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("cancels an abandoned HTTP error body before freeing the lock", async () => {
    await initialize();
    const admitted = await lease();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { status: 429 });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    expect((await admitted.fetchFor("jev", fetcher)(JEV_ENDPOINT, jevBody())).status).toBe(429);
    expect(cancel).toHaveBeenCalledTimes(1);
    await admitted.release();
    await expect(stat(`${config.ledgerPath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["declared", "streamed"])("cancels %s oversized bodies using each provider's exact byte cap", async (kind) => {
    await initialize();
    const admitted = await lease();
    const cancel = vi.fn();
    const stream = new ReadableStream({
      start(controller) {
        if (kind === "streamed") controller.enqueue(new Uint8Array(64 * 1024 + 1));
      },
      cancel,
    });
    const response = new Response(stream, { headers: kind === "declared" ? { "content-length": String(64 * 1024 + 1) } : {} });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    await expect(admitted.fetchFor("serpapi", fetcher)(SERPAPI_IMAGE_UPLOAD_URL)).rejects.toThrow("exceeded 65536 bytes");
    expect(cancel).toHaveBeenCalledTimes(1);
    await admitted.release();
    await expect(stat(`${config.ledgerPath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
