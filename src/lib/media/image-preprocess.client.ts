/**
 * Client-side image preprocessing (spec section 3.4).
 *
 * The user never manually satisfies the upload limit. We decode the image,
 * preserve aspect ratio, cap the long edge at 1600 px, encode WebP starting
 * at quality 0.82, and step quality down until the payload is <= 450 KB
 * (minimum quality 0.55, JPEG fallback). This keeps the request far under
 * the Vercel body limit and the 500 KB SerpApi upstream cap (spec 5.3).
 *
 * Runs entirely in the browser; the processed bytes live only in memory.
 */

export const MAX_BYTES = 450 * 1024;
export const MAX_LONG_EDGE = 1600;
export const START_QUALITY = 0.82;
export const MIN_QUALITY = 0.55;
const QUALITY_STEP = 0.07;

export const SUPPORTED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export type PreprocessErrorCode =
  | "unsupported-type"
  | "decode-failed"
  | "encode-failed"
  | "too-large";

export class PreprocessError extends Error {
  readonly code: PreprocessErrorCode;
  constructor(code: PreprocessErrorCode, message: string) {
    super(message);
    this.name = "PreprocessError";
    this.code = code;
  }
}

export interface PreprocessedImage {
  blob: Blob;
  mimeType: string;
  width: number;
  height: number;
  bytes: number;
  quality: number;
}

/** Pure: accept check used by the dropzone before any decoding. */
export function isSupportedImageFile(file: File): boolean {
  if ((SUPPORTED_MIME_TYPES as readonly string[]).includes(file.type)) return true;
  return /\.(jpe?g|png|webp)$/i.test(file.name);
}

/** Pure: quality ladder tried from high to low, bounded by MIN_QUALITY. */
export function qualityLadder(
  start: number = START_QUALITY,
  min: number = MIN_QUALITY,
  step: number = QUALITY_STEP,
): number[] {
  const ladder: number[] = [];
  for (let q = start; q >= min - 1e-9; q -= step) {
    ladder.push(Math.round(q * 100) / 100);
  }
  return ladder;
}

async function decodeImage(file: File): Promise<ImageBitmap> {
  try {
    if (typeof createImageBitmap === "function") {
      return await createImageBitmap(file);
    }
  } catch {
    // Fall through to <img> decoding below.
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("decode failed"));
      el.src = url;
    });
    if (typeof createImageBitmap === "function") {
      return await createImageBitmap(img);
    }
    throw new Error("no bitmap decoder available");
  } catch {
    throw new PreprocessError(
      "decode-failed",
      "That file could not be decoded as an image. Try a different JPG, PNG, or WebP file.",
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

function fitWithin(width: number, height: number, maxEdge: number) {
  const longEdge = Math.max(width, height);
  if (longEdge <= maxEdge) return { width, height };
  const scale = maxEdge / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

export async function preprocessImage(file: File): Promise<PreprocessedImage> {
  if (!isSupportedImageFile(file)) {
    throw new PreprocessError(
      "unsupported-type",
      "Unsupported file. Choose a JPG, JPEG, PNG, or WebP image.",
    );
  }

  const bitmap = await decodeImage(file);
  const { width, height } = fitWithin(bitmap.width, bitmap.height, MAX_LONG_EDGE);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new PreprocessError("encode-failed", "Image processing is unavailable in this browser.");
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const candidates: Array<{ mimeType: string; qualities: number[] }> = [
    { mimeType: "image/webp", qualities: qualityLadder() },
    { mimeType: "image/jpeg", qualities: qualityLadder() },
  ];

  for (const { mimeType, qualities } of candidates) {
    for (const quality of qualities) {
      const blob = await canvasToBlob(canvas, mimeType, quality);
      if (!blob) continue;
      if (blob.size <= MAX_BYTES) {
        return { blob, mimeType, width, height, bytes: blob.size, quality };
      }
    }
  }

  throw new PreprocessError(
    "too-large",
    "That image could not be compressed under 450 KB. Try a smaller image.",
  );
}
