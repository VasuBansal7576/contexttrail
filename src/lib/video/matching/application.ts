/** Single-user loopback upload adapter. No case writes, input paths, network or provider calls. */
import { VIDEO_LIMITS } from '../ingest';
import { MATCH_LIMITS, type LocalMediaInput, type PreparedMatchFrame } from './model';
import { comparePreparedMediaAsync } from './compare';
import { prepareMatchMedia } from './prepare';
import type { LocalComparisonFrame, LocalComparisonResponse } from './application-contract';

export const LOCAL_COMPARISON_LIMITS = Object.freeze({
  requestBytes: VIDEO_LIMITS.bytes * 2 + 64 * 1024,
  responseBytes: 16 * 1024 * 1024,
  uploadMs: 30_000,
  deadlineMs: 330_000,
  activeJobs: 1,
  videoBytes: VIDEO_LIMITS.bytes,
  imageBytes: MATCH_LIMITS.imageBytes,
  videoDurationMs: VIDEO_LIMITS.durationMs,
  videoSamples: VIDEO_LIMITS.frames,
  comparedFramePairs: VIDEO_LIMITS.frames ** 2,
});
export class LocalComparisonError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const formats = {
  png: { kind: 'image', mime: 'image/png', signature: 'png' },
  jpg: { kind: 'image', mime: 'image/jpeg', signature: 'jpeg' },
  jpeg: { kind: 'image', mime: 'image/jpeg', signature: 'jpeg' },
  webp: { kind: 'image', mime: 'image/webp', signature: 'webp' },
  mp4: { kind: 'video', mime: 'video/mp4', signature: 'mov' },
  mov: { kind: 'video', mime: 'video/quicktime', signature: 'mov' },
  webm: { kind: 'video', mime: 'video/webm', signature: 'matroska' },
  mkv: { kind: 'video', mime: 'video/x-matroska', signature: 'matroska' },
} satisfies Record<string, { kind: LocalMediaInput['kind']; mime: string; signature: string }>;
export const LOCAL_COMPARISON_FORMATS = Object.entries(formats).map(([extension, format]) => ({ extension, kind: format.kind, mimeType: format.mime }));
function signature(bytes: Buffer, expected: string): boolean {
  switch (expected) {
    case 'png': return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case 'jpeg': return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    case 'webp': return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    case 'mov': return bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp';
    case 'matroska': return bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]));
    default: return false;
  }
}
function inputFile(form: FormData, side: 'left' | 'right'): { file: File; kind: LocalMediaInput['kind']; signature: string } {
  const file = form.get(side), kind = form.get(`${side}Kind`);
  if (kind !== 'image' && kind !== 'video') throw new LocalComparisonError(400, 'INVALID_INPUT', 'Each supplied file needs an explicit image or video kind.');
  if (!file || typeof file === 'string' || !file.name || file.name.length > 256 || /[\\/\0]/.test(file.name)) throw new LocalComparisonError(400, 'INVALID_INPUT', 'Supply two files, without filesystem paths or URLs.');
  if (!file.size) throw new LocalComparisonError(400, 'EMPTY_FILE', 'The supplied files must not be empty.');
  if (file.size > (kind === 'video' ? VIDEO_LIMITS.bytes : MATCH_LIMITS.imageBytes)) throw new LocalComparisonError(413, 'MEDIA_TOO_LARGE', 'A supplied file exceeds its video or still-image byte limit.');
  const extension = file.name.split('.').pop()?.toLowerCase();
  const format = Object.entries(formats).find(([key]) => key === extension)?.[1];
  if (!format || format.kind !== kind || (file.type && file.type !== 'application/octet-stream' && file.type !== format.mime)) throw new LocalComparisonError(415, 'UNSUPPORTED_MEDIA', 'Use a matching file extension and type: MP4, MOV, WebM, MKV, JPEG, PNG or WebP.');
  return { file, kind, signature: format.signature };
}
export async function parseComparisonForm(form: FormData, signal: AbortSignal): Promise<{ left: LocalMediaInput; right: LocalMediaInput }> {
  const fields = ['left', 'right', 'leftKind', 'rightKind', 'rights'];
  if ([...form.keys()].some(key => !fields.includes(key)) || fields.some(key => form.getAll(key).length !== 1)) throw new LocalComparisonError(400, 'INVALID_INPUT', 'Expected exactly left, right, leftKind, rightKind and rights.');
  if (form.get('rights') !== 'user_provided') throw new LocalComparisonError(400, 'RIGHTS_REQUIRED', 'Confirm that you may supply and compare both files.');
  const left = inputFile(form, 'left'), right = inputFile(form, 'right');
  if (left.kind !== 'video' && right.kind !== 'video') throw new LocalComparisonError(400, 'VIDEO_REQUIRED', 'Choose two videos, or a still image and a video.');
  async function read(input: ReturnType<typeof inputFile>): Promise<LocalMediaInput> {
    if (signal.aborted) throw new LocalComparisonError(499, 'CANCELLED', 'Comparison cancelled. No case was changed.');
    const bytes = Buffer.from(await input.file.arrayBuffer());
    if (!signature(bytes, input.signature)) throw new LocalComparisonError(415, 'SIGNATURE_MISMATCH', 'File bytes do not match the selected file format.');
    return { kind: input.kind, bytes, rights: 'user_provided' };
  }
  return { left: await read(left), right: await read(right) };
}
function framePayload(frame: PreparedMatchFrame): LocalComparisonFrame {
  return { mediaId: frame.mediaId, frameId: frame.frameId, contentHash: frame.contentHash, timestampMs: frame.timestampMs, mimeType: frame.mimeType, width: frame.width, height: frame.height, base64: Buffer.from(frame.bytes).toString('base64') };
}
export async function compareSuppliedMedia(inputs: Awaited<ReturnType<typeof parseComparisonForm>>, signal: AbortSignal): Promise<LocalComparisonResponse> {
  const left = await prepareMatchMedia(inputs.left, { signal });
  const right = await prepareMatchMedia(inputs.right, { signal });
  const report = await comparePreparedMediaAsync(left, right, signal);
  return {
    schemaVersion: 'contexttrail-local-media-comparison-v1', report,
    frames: { left: left.frames.map(framePayload), right: right.frames.map(framePayload) },
    persistence: { status: 'not_saved', reason: 'Comparison not saved to case. Local candidate pairs and retained videos do not yet have a compatible case-evidence model. No source URLs, findings or identity claims were created.' },
  };
}
