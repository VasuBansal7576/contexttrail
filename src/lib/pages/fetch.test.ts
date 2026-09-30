import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { IncomingMessage, request as httpRequest, RequestOptions } from "node:http";
import type { LookupFunction } from "node:net";
import { fetchPageHtml, validatePublicImageUrl, isPublicPageAddress, type PageFetchDeps } from "./fetch";
import { pinnedPageRequest } from "./pinned-http";
import { PAGE_FETCH_MAX_BYTES, TIMEOUTS } from "../investigation/limits";

const publicAnswer = { address: "93.184.216.34", family: 4 };
const html = () => new Response("<html>public synthetic source</html>", { headers: { "content-type": "text/html" } });
const harness = () => ({ resolve: vi.fn<NonNullable<PageFetchDeps["resolve"]>>(async () => [publicAnswer]), request: vi.fn<NonNullable<PageFetchDeps["request"]>>(async () => html()) });
afterEach(() => vi.useRealTimers());

describe("public image admission", () => {
  it("pins public DNS and accepts a bounded supported image without upload", async () => {
    const deps=harness();deps.request.mockResolvedValue(new Response(new Uint8Array([255,216,255]),{headers:{"content-type":"image/jpeg"}}));
    expect(await validatePublicImageUrl("https://PUBLIC.EXAMPLE./image.jpg",undefined,deps)).toBe("https://public.example/image.jpg");
    expect(deps.request.mock.calls[0]?.[1]).toEqual(publicAnswer);
  });
  it.each(["https://localhost./a.jpg","https://127.1/a.jpg","https://public.example/a.jpg?token=secret","http://public.example/a.jpg","https://public.example:8080/a.jpg"])("rejects unsafe %s before lookup",async url=>{
    const deps=harness();await expect(validatePublicImageUrl(url,undefined,deps)).rejects.toThrow();expect(deps.request).not.toHaveBeenCalled();
  });
  it("rejects private DNS and private redirects without dispatching to them",async()=>{
    const deps=harness();deps.resolve.mockResolvedValue([{address:"127.0.0.1",family:4}]);await expect(validatePublicImageUrl("https://public.example/a.jpg",undefined,deps)).rejects.toThrow();expect(deps.request).not.toHaveBeenCalled();
    deps.resolve.mockResolvedValue([publicAnswer]);deps.request.mockResolvedValue(new Response(null,{status:302,headers:{location:"https://localhost./a.jpg"}}));await expect(validatePublicImageUrl("https://public.example/a.jpg",undefined,deps)).rejects.toThrow();expect(deps.request).toHaveBeenCalledOnce();
  });
  it("rejects HTML masquerading as a URL image and cancels its body",async()=>{
    const deps=harness(),cancel=vi.fn();deps.request.mockResolvedValue(new Response(new ReadableStream({cancel}),{headers:{"content-type":"text/html"}}));await expect(validatePublicImageUrl("https://public.example/a.jpg",undefined,deps)).rejects.toThrow();expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("canonical destination validation", () => {
  it.each([
    "http://localhost./private", "http://LOCALHOST./", "http://sub.localhost./",
    "http://printer.local./", "http://host.internal./", "http://host.home.arpa./",
    "http://singlelabel/", "http://bad..example/", "http://-bad.example/",
    "http://127.1/", "http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/",
    "http://127.0.0.1./", "http://[::1]/", "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:5db8:d822]/", "http://[fe80::1%25eth0]/", "http://[2002:7f00:1::]/",
    "https://public.example@localhost./", "file:///private", "ftp://public.example/",
  ])("rejects %s before DNS or transport", async (url) => {
    const deps = harness();
    await expect(fetchPageHtml(url, undefined, deps)).rejects.toThrow();
    expect(deps.resolve).not.toHaveBeenCalled(); expect(deps.request).not.toHaveBeenCalled();
  });

  it.each([
    "0.0.0.1", "10.1.1.1", "100.64.1.1", "127.0.0.1", "169.254.1.1", "172.31.1.1",
    "192.0.0.8", "192.0.2.1", "192.88.99.1", "192.168.1.1", "198.18.1.1",
    "198.51.100.1", "203.0.113.1", "224.1.1.1", "240.1.1.1", "255.255.255.255",
    "::", "::1", "::ffff:93.184.216.34", "fc00::1", "fe80::1", "ff02::1",
    "64:ff9b::7f00:1", "2001::1", "2001:db8::1", "2002::1", "3fff::1", "invalid",
  ])("rejects nonpublic/special-use address %s", (address) => expect(isPublicPageAddress(address)).toBe(false));

  it.each(["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111", "2001:4860:4860::8888"])(
    "accepts globally routable address %s", (address) => expect(isPublicPageAddress(address)).toBe(true),
  );

  it("canonicalizes a public trailing-dot host and keeps the source path", async () => {
    const deps = harness();
    expect(await fetchPageHtml("https://PUBLIC.EXAMPLE./article?q=1#fragment", undefined, deps)).toEqual({
      url: "https://public.example/article?q=1", html: "<html>public synthetic source</html>",
    });
    expect(deps.resolve).toHaveBeenCalledWith("public.example");
    expect(deps.request.mock.calls[0]?.[0].hostname).toBe("public.example");
  });
});

describe("DNS and redirects", () => {
  it.each([[], [{ address: "127.0.0.1", family: 4 }], [publicAnswer, { address: "10.0.0.1", family: 4 }],
    [publicAnswer, { address: "::1", family: 6 }], [{ address: "93.184.216.34", family: 6 }],
    [{ address: "not-an-ip", family: 4 }]].map(answers => ({ answers })) )("rejects the entire unsafe DNS answer set %j", async ({ answers }) => {
    const request = vi.fn();
    await expect(fetchPageHtml("https://public.example/", undefined, { resolve: async () => answers, request })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("pins the approved address even if a second DNS lookup would rebind", async () => {
    const resolve = vi.fn().mockResolvedValueOnce([publicAnswer]).mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const request = vi.fn(async (_url, approved) => { expect(approved).toEqual(publicAnswer); return html(); });
    await fetchPageHtml("https://public.example/", undefined, { resolve, request });
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it.each(["http://localhost./", "http://2130706433/", "http://[::ffff:7f00:1]/", "https://internal.example/"])(
    "rejects redirect %s and cancels its response", async (location) => {
      const cancel = vi.fn();
      const redirect = new Response(new ReadableStream({ cancel }), { status: 302, headers: { location } });
      const request = vi.fn(async () => redirect);
      const resolve = vi.fn(async (host) => host === "internal.example" ? [{ address: "10.0.0.1", family: 4 }] : [publicAnswer]);
      await expect(fetchPageHtml("https://public.example/", undefined, { request, resolve })).rejects.toThrow();
      expect(request).toHaveBeenCalledTimes(1); expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("revalidates same-host DNS on redirect and rejects rebinding", async () => {
    const resolve = vi.fn().mockResolvedValueOnce([publicAnswer]).mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    const request = vi.fn(async () => new Response(null, { status: 302, headers: { location: "/next" } }));
    await expect(fetchPageHtml("https://public.example/", undefined, { resolve, request })).rejects.toThrow();
    expect(resolve).toHaveBeenCalledTimes(2); expect(request).toHaveBeenCalledTimes(1);
  });

  it("allows bounded public redirects, pinning each independently", async () => {
    const request = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://other.example/final" } })).mockResolvedValueOnce(html());
    const resolve = vi.fn<NonNullable<PageFetchDeps["resolve"]>>(async () => [publicAnswer]);
    expect((await fetchPageHtml("https://public.example/", undefined, { resolve, request })).url).toBe("https://other.example/final");
    expect(resolve.mock.calls.map(c => c[0])).toEqual(["public.example", "other.example"]);
  });

  it("bounds and cancels redirect loops", async () => {
    let cancelled = 0;
    const deps = harness(); deps.request.mockImplementation(async () => new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 302, headers: { location: "/again" } }));
    await expect(fetchPageHtml("https://public.example/", undefined, deps)).rejects.toThrow();
    expect(deps.request).toHaveBeenCalledTimes(4); expect(cancelled).toBe(4);
  });

  it("sanitizes DNS failures without dispatch", async () => {
    const request = vi.fn();
    await expect(fetchPageHtml("https://public.example/", undefined, { resolve: async () => { throw new Error("private resolver detail"); }, request })).rejects.toThrow("page request could not be completed");
    expect(request).not.toHaveBeenCalled();
  });

  it("deadline stops waiting for DNS, cleans listeners and prevents late dispatch", async () => {
    vi.useFakeTimers();
    let finish!: (answer: typeof publicAnswer[]) => void;
    let bound!: AbortSignal;
    const request = vi.fn();
    const deps: PageFetchDeps = { resolve: () => new Promise(r => { finish = r; }), request };
    const pending = fetchPageHtml("https://public.example/", undefined, {
      ...deps, resolve: deps.resolve,
      request: (url, address, signal) => { bound = signal; return request(url, address, signal); },
    });
    const rejected = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(TIMEOUTS.pageFetchMs + 1); await rejected;
    finish([publicAnswer]); await Promise.resolve(); expect(request).not.toHaveBeenCalled();
    expect(bound).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
  });
});

describe("response and transport cleanup", () => {
  it.each([{ status: 500 }, { status: 200, type: "image/png" }, { status: 200, encoding: "gzip" }, { status: 200, length: String(PAGE_FETCH_MAX_BYTES + 1) }])(
    "cancels rejected source response %j", async ({ status, type, encoding, length }) => {
      const cancel = vi.fn(); const headers = new Headers({ "content-type": type ?? "text/html" });
      if (encoding) headers.set("content-encoding", encoding); if (length) headers.set("content-length", length);
      const deps = harness(); deps.request.mockImplementation(async () => new Response(new ReadableStream({ cancel }), { status, headers }));
      await expect(fetchPageHtml("https://public.example/", undefined, deps)).rejects.toThrow(); expect(cancel).toHaveBeenCalledOnce();
    },
  );
  it("caps streamed source bytes and cancels overflow", async () => {
    const cancel = vi.fn(); let sent = 0;
    const body = new ReadableStream({ pull(c) { sent++; c.enqueue(new Uint8Array(1024 * 1024)); }, cancel }, { highWaterMark: 0 });
    const deps = harness(); deps.request.mockImplementation(async () => new Response(body, { headers: { "content-type": "text/html" } }));
    await expect(fetchPageHtml("https://public.example/", undefined, deps)).rejects.toThrow("exceeded");
    expect(sent).toBe(3); expect(cancel).toHaveBeenCalledOnce();
  });
  it("already-aborted requests do not resolve or dispatch", async () => {
    const controller = new AbortController(); controller.abort(new DOMException("Aborted", "AbortError")); const deps = harness();
    await expect(fetchPageHtml("https://public.example/", controller.signal, deps)).rejects.toThrow();
    expect(deps.resolve).not.toHaveBeenCalled(); expect(deps.request).not.toHaveBeenCalled();
  });
  it("uses only the pinned lookup for native connection, retaining TLS host and cancellation", async () => {
    const response = Object.assign(new PassThrough(), { headers: { "content-type": "text/html" }, statusCode: 200 });
    const request = new EventEmitter() as EventEmitter & { end(): void; destroy(): void };
    request.destroy = vi.fn();
    let options!: RequestOptions; let target!: URL;
    const fakeRequest = ((url: URL, opts: RequestOptions, callback: (res: IncomingMessage) => void) => {
      target = url; options = opts; request.end = () => callback(response as unknown as IncomingMessage); return request;
    }) as unknown as typeof httpRequest;
    const controller = new AbortController();
    const result = await pinnedPageRequest(new URL("https://public.example/article"), { ...publicAnswer, family: 4 }, controller.signal, fakeRequest);
    expect(target.hostname).toBe("public.example"); expect(options.agent).toBe(false); expect(options.signal).toBe(controller.signal);
    expect(options.headers).toMatchObject({ "accept-encoding": "identity" });
    const lookup = options.lookup as LookupFunction;
    const single = vi.fn(); lookup("public.example", { all: false }, single); expect(single).toHaveBeenCalledWith(null, publicAnswer.address, 4);
    const all = vi.fn(); lookup("public.example", { all: true }, all); expect(all).toHaveBeenCalledWith(null, [publicAnswer]);
    await result.body?.cancel(); expect(response.destroyed).toBe(true);
  });
});
