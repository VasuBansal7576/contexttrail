/**
 * POST /api/investigate (spec §24).
 *
 * multipart/form-data fields: `media` (required image), `claim` (optional),
 * `timezone`, `locale`. Streams §24.2 events as application/x-ndjson.
 * Non-stream validation failures return plain HTTP errors — the client maps
 * them to honest failure states and never falls back to fixtures.
 */

import type { InvestigationInput } from "@/lib/investigation/contracts/investigation";
import { createInvestigationResponse } from "@/lib/investigation/server";
import { isPublicImageId } from "@/lib/media/public-images";

export const runtime = "nodejs";
export const maxDuration = 60;

/** §6.2 — SerpApi Image API upstream limit. */
const MAX_MEDIA_BYTES = 500 * 1024;
/** Includes all multipart framing and ignored fields; enforced before parsing. */
const MAX_REQUEST_BYTES = 600 * 1024;
const MAX_CLAIM_CHARS = 500;
const ACCEPTED_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function httpError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

export async function POST(req: Request): Promise<Response> {
  const tooLarge = () => httpError(413, "The complete request exceeds the 600 KB upload limit.");
  const declared = req.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MAX_REQUEST_BYTES) {
    await req.body?.cancel().catch(() => undefined);
    return tooLarge();
  }
  if (!req.body) return httpError(400, "Missing multipart body.");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const onAbort = () => { void reader.cancel().catch(() => undefined); };
  req.signal.addEventListener("abort", onAbort, { once: true });
  try {
    req.signal.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      req.signal.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        return tooLarge();
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return httpError(400, "The upload body could not be read.");
  } finally {
    req.signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let form: FormData;
  try {
    form = await new Response(bytes, { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData();
  } catch {
    return httpError(400, "Expected multipart/form-data with media, claim, timezone, locale.");
  }

  const mediaField = form.get("media");
  const publicImageRaw = form.get("public_image");
  if (publicImageRaw !== null && (!isPublicImageId(publicImageRaw) || mediaField !== null || form.getAll("public_image").length !== 1)) {
    return httpError(400, "Choose one reviewed public image or one upload.");
  }
  const publicImageId = isPublicImageId(publicImageRaw) ? publicImageRaw : undefined;
  if (!publicImageId && !(mediaField instanceof Blob)) {
    return httpError(400, "Missing required image field 'media'.");
  }
  if (mediaField instanceof Blob && mediaField.size === 0) {
    return httpError(400, "The submitted image is empty.");
  }
  if (mediaField instanceof Blob && mediaField.size > MAX_MEDIA_BYTES) {
    return httpError(413, "The processed image exceeds the 500 KB upload limit.");
  }
  const mediaType = mediaField instanceof Blob ? mediaField.type.toLowerCase() : "";
  if (mediaType !== "" && !ACCEPTED_MEDIA_TYPES.has(mediaType)) {
    return httpError(400, `Unsupported image type '${mediaType}'. Use JPEG, PNG, or WebP.`);
  }

  const claimRaw = form.get("claim");
  const claim =
    typeof claimRaw === "string" && claimRaw.trim().length > 0
      ? claimRaw.trim().slice(0, MAX_CLAIM_CHARS)
      : null;

  const timezoneRaw = form.get("timezone");
  const timezone =
    typeof timezoneRaw === "string" && timezoneRaw.trim().length > 0
      ? timezoneRaw.trim().slice(0, 100)
      : "UTC";
  const localeRaw = form.get("locale");
  const locale =
    typeof localeRaw === "string" && localeRaw.trim().length > 0
      ? localeRaw.trim().slice(0, 35)
      : "en";

  const media = mediaField instanceof Blob ? new Uint8Array(await mediaField.arrayBuffer()) : new Uint8Array();
  const input: InvestigationInput = { claim, timezone, locale, media, ...(publicImageId ? { publicImageId } : {}) };

  // The request's own signal is linked into the shared investigation
  // controller inside createInvestigationResponse.
  return createInvestigationResponse(input, { signal: req.signal });
}
