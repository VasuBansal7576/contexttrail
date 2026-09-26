/**
 * SerpApi client (spec §5.5, §6, §27–28).
 *
 * One controlled request surface for every SerpApi call: the API key is only
 * ever attached inside this module, response bodies are byte-capped, and all
 * errors are sanitized so provider credentials or credential-bearing URLs
 * can never reach events or logs.
 *
 * Endpoints (official docs):
 * - POST https://serpapi.com/image  — Image API upload (multipart `image` +
 *   `api_key`), returns `{ image_id }` valid ~10 minutes.
 * - GET  https://serpapi.com/search — Search API with `output=json`.
 */

import { TIMEOUTS } from "../investigation/limits";
import {
  ProviderError,
  deadlineSignal,
  fetchJsonBounded,
  readBodyCapped,
  sanitizeFetchError,
} from "../providers/http";

export const SERPAPI_SEARCH_URL = "https://serpapi.com/search.json";
export const SERPAPI_IMAGE_UPLOAD_URL = "https://serpapi.com/image";

/** SerpApi JSON responses are bounded defensively. */
const SEARCH_MAX_BYTES = 4 * 1024 * 1024;
const UPLOAD_MAX_BYTES = 64 * 1024;

export type SerpapiParams = Record<string, string>;

export interface SerpapiClientOptions {
  fetchImpl?: typeof fetch;
}

export class SerpapiClient {
  readonly #apiKey: string;
  readonly #fetchImpl?: typeof fetch;

  constructor(apiKey: string, opts: SerpapiClientOptions = {}) {
    this.#apiKey = apiKey;
    this.#fetchImpl = opts.fetchImpl;
  }

  /**
   * Run a Search API request. `engine` is required by the caller; the API key
   * is appended here so no caller can build a credential-bearing URL.
   * `no_cache` is never set (§6.8).
   */
  async search(params: SerpapiParams, signal?: AbortSignal): Promise<unknown> {
    const url = new URL(SERPAPI_SEARCH_URL);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("api_key", this.#apiKey);
    return fetchJsonBounded({
      url: url.toString(),
      label: "serpapi",
      timeoutMs: TIMEOUTS.serpapiSearchMs,
      maxBytes: SEARCH_MAX_BYTES,
      externalSignal: signal,
      fetchImpl: this.#fetchImpl,
    });
  }

  /**
   * Upload the preprocessed image to the SerpApi Image API (§6.2).
   * Returns the transient `image_id` (expires ~10 min, never persisted).
   */
  async uploadImage(media: Uint8Array, signal?: AbortSignal): Promise<string> {
    const form = new FormData();
    const copy = new Uint8Array(media);
    form.set("image", new Blob([copy]), "image");
    form.set("api_key", this.#apiKey);

    const { signal: boundSignal, cancel } = deadlineSignal(signal, TIMEOUTS.serpapiImageUploadMs);
    try {
      const res = await (this.#fetchImpl ?? fetch)(SERPAPI_IMAGE_UPLOAD_URL, {
        method: "POST",
        body: form,
        signal: boundSignal,
      });
      if (!res.ok) {
        throw new ProviderError("http", `serpapi image upload failed (HTTP ${res.status})`, res.status);
      }
      const body = await readBodyCapped(res, UPLOAD_MAX_BYTES, "serpapi");
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new ProviderError("malformed", "serpapi image upload response was not valid JSON");
      }
      const imageId =
        typeof parsed === "object" && parsed !== null
          ? (parsed as Record<string, unknown>).image_id
          : null;
      if (typeof imageId !== "string" || imageId.length === 0) {
        throw new ProviderError("malformed", "serpapi image upload returned no image_id");
      }
      return imageId;
    } catch (err) {
      throw sanitizeFetchError(err, "serpapi");
    } finally {
      cancel();
    }
  }
}

/**
 * True when the parsed response reports a SerpApi-side failure.
 *
 * `search_metadata.status` is authoritative: "Error" means the search
 * failed; "Success" means it completed. SerpApi also emits a top-level
 * `error` string on completed searches when the requested surface has no
 * results (e.g. Lens with no exact-matches tab) — that is a provider-
 * reported *empty collection*, not a request failure, and must not consume
 * a failed ticket (§29 keeps empty/unavailable distinct).
 */
export function serpapiResponseFailed(json: unknown): boolean {
  if (typeof json !== "object" || json === null) return true;
  const o = json as Record<string, unknown>;
  const meta = o.search_metadata;
  const status =
    typeof meta === "object" && meta !== null
      ? (meta as Record<string, unknown>).status
      : null;
  if (status === "Error") return true;
  if (status === "Success") return false;
  // No decisive status: a top-level error is a real failure.
  if (typeof o.error === "string" && o.error.length > 0) return true;
  return false;
}

/** `search_metadata.id` — the SerpApi search ID for provenance records. */
export function serpapiSearchId(json: unknown): string | null {
  if (typeof json !== "object" || json === null) return null;
  const meta = (json as Record<string, unknown>).search_metadata;
  if (typeof meta !== "object" || meta === null) return null;
  const id = (meta as Record<string, unknown>).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export function missingSerpapiKeyError(): ProviderError {
  return new ProviderError("unconfigured", "SERPAPI_API_KEY is not configured");
}
