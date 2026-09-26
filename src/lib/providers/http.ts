/**
 * Shared bounded HTTP plumbing for provider calls (spec §27–29).
 *
 * Every outbound request gets: a per-operation timeout, a shared caller
 * AbortSignal (request cancel / 55s deadline), a response-body byte cap, and
 * sanitized errors that can never leak credentials or raw provider bodies.
 */

export type ProviderErrorKind =
  | "unconfigured"
  | "aborted"
  | "timeout"
  | "http"
  | "network"
  | "malformed";

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status: number | null;

  constructor(kind: ProviderErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.status = status;
  }
}

/** Combine an external signal with a per-operation timeout. */
export function deadlineSignal(
  external: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new ProviderError("timeout", "timed out")), timeoutMs);
  const onAbort = () => {
    clearTimeout(timer);
    controller.abort(external?.reason ?? new ProviderError("aborted", "aborted"));
  };
  if (external?.aborted) onAbort();
  else external?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", onAbort);
    },
  };
}

export function isAbortLike(err: unknown): boolean {
  if (err instanceof ProviderError) {
    return err.kind === "aborted" || err.kind === "timeout";
  }
  return (
    err instanceof DOMException && err.name === "AbortError"
  ) || (err instanceof Error && err.name === "AbortError");
}

/**
 * Fetch a JSON document with timeout, shared abort, and a byte cap.
 * `label` identifies the provider in sanitized messages (e.g. "serpapi").
 * The request URL is never included in errors — it may carry credentials.
 */
export async function fetchJsonBounded(input: {
  url: string;
  label: string;
  timeoutMs: number;
  maxBytes: number;
  externalSignal?: AbortSignal;
  init?: RequestInit;
  fetchImpl?: typeof fetch;
}): Promise<unknown> {
  const { signal, cancel } = deadlineSignal(input.externalSignal, input.timeoutMs);
  const doFetch = input.fetchImpl ?? fetch;
  try {
    const res = await doFetch(input.url, { ...input.init, signal });
    if (!res.ok) {
      throw new ProviderError("http", `${input.label} request failed (HTTP ${res.status})`, res.status);
    }
    const body = await readBodyCapped(res, input.maxBytes, input.label);
    try {
      return JSON.parse(body);
    } catch {
      throw new ProviderError("malformed", `${input.label} response was not valid JSON`);
    }
  } catch (err) {
    throw sanitizeFetchError(err, input.label);
  } finally {
    cancel();
  }
}

/** Read a response body to a string, rejecting when it exceeds `maxBytes`. */
export async function readBodyCapped(
  res: Response,
  maxBytes: number,
  label: string,
): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ProviderError("malformed", `${label} response exceeded ${maxBytes} bytes`);
  }
  if (!res.body) {
    const text = await res.text();
    if (new TextEncoder().encode(text).length > maxBytes) {
      throw new ProviderError("malformed", `${label} response exceeded ${maxBytes} bytes`);
    }
    return text;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ProviderError("malformed", `${label} response exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder().decode(merged);
}

export function sanitizeFetchError(err: unknown, label: string): ProviderError {
  if (err instanceof ProviderError) return err;
  if (isAbortLike(err)) {
    const kind: ProviderErrorKind =
      err instanceof ProviderError && err.kind === "timeout" ? "timeout" : "aborted";
    return new ProviderError(kind, `${label} request ${kind === "timeout" ? "timed out" : "aborted"}`);
  }
  // DOMException AbortError without ProviderError wrapping
  if (err instanceof Error && (err.name === "AbortError" || /aborted/i.test(err.message))) {
    return new ProviderError("aborted", `${label} request aborted`);
  }
  // Network errors: keep only the failure class, never the URL or internals.
  return new ProviderError("network", `${label} request could not be completed`);
}

/** Bounded FIFO concurrency limiter (spec §27). */
export function createLimiter(max: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const acquire = () =>
    new Promise<void>((resolve) => {
      if (active < max) {
        active += 1;
        resolve();
      } else {
        queue.push(resolve);
      }
    });
  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    await acquire();
    try {
      return await fn();
    } finally {
      active -= 1;
      const next = queue.shift();
      if (next) {
        active += 1;
        next();
      }
    }
  };
}
