import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import type { LookupFunction } from "node:net";

export interface PageAddress { address: string; family: 4 | 6 }

/** One fresh direct connection: retain the URL host for Host/SNI/certificate checks,
 * but give the socket only the previously validated address. No second DNS lookup,
 * global fetch dispatcher, proxy agent, connection pool, or automatic redirect. */
export function pinnedPageRequest(
  url: URL,
  address: PageAddress,
  signal: AbortSignal,
  requestImpl: typeof httpRequest = url.protocol === "https:" ? httpsRequest : httpRequest,
): Promise<Response> {
  const lookup: LookupFunction = (_host, options, callback) => {
    if (options.all) callback(null, [address]);
    else callback(null, address.address, address.family);
  };
  const options: RequestOptions & { autoSelectFamily: boolean } = {
    method: "GET",
    agent: false,
    family: address.family,
    autoSelectFamily: false,
    lookup,
    signal,
    headers: { accept: "text/html,*/*;q=0.1", "accept-encoding": "identity" },
    maxHeaderSize: 16 * 1024,
  };
  return new Promise((resolve, reject) => {
    const req = requestImpl(url, options, (res) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(res.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const status = res.statusCode ?? 502;
      const noBody = [204, 205, 304].includes(status);
      if (noBody) res.destroy();
      try {
        resolve(new Response(noBody ? null : Readable.toWeb(res) as ReadableStream<Uint8Array>, { status, headers }));
      } catch (error) {
        res.destroy();
        req.destroy();
        reject(error);
      }
    });
    req.on("error", reject);
    req.end();
  });
}
