/** Browser-only boundaries. This module never imports the native decoder or storage. */
import type { LocalComparisonFrame, LocalComparisonResponse } from './application-contract';
import type { FrameMatchReport, FramePairComparison, FrameReference, MatchRegion, MediaCoverage, PixelDistance } from './model';

export type MediaKind = 'image' | 'video';
export type ComparisonCapabilities = {
  schemaVersion: 'contexttrail-local-media-capabilities-v1';
  mode: 'local_supplied_media_only';
  limits: { videoBytes: number; imageBytes: number; videoDurationMs: number; videoSamples: number; comparedFramePairs: number; requestBytes: number; responseBytes: number; uploadMs: number; deadlineMs: number; activeJobs: number };
  formats: { extension: string; kind: MediaKind; mimeType: string }[];
  persistence: 'not_saved';
  busy: boolean;
};
export class ComparisonClientError extends Error {
  constructor(message: string, readonly code = 'INVALID_RESPONSE', readonly status = 0) { super(message); this.name = 'ComparisonClientError'; }
}
function invalid(): never { throw new ComparisonClientError('The local server returned an incomplete or unsupported comparison. Your selected files are still available to retry.'); }
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 4096): string { if (typeof value !== 'string' || !value.length || value.length > max) return invalid(); return value; }
function number(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return invalid(); return value; }
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number { const result = number(value, min, max); return Number.isInteger(result) ? result : invalid(); }
function bool(value: unknown): boolean { return typeof value === 'boolean' ? value : invalid(); }
function oneOf<T extends string | number | boolean | null>(value: unknown, choices: readonly T[]): T { const match = choices.find(choice => choice === value); return match === undefined ? invalid() : match; }
function array<T>(value: unknown, parse: (item: unknown) => T, max: number, min = 0): T[] { if (!Array.isArray(value) || value.length < min || value.length > max) return invalid(); return value.map(parse); }
function hash(value: unknown): string { const result = text(value, 64); return /^[a-f0-9]{64}$/.test(result) ? result : invalid(); }
function reference(value: unknown): FrameReference { const v = object(value); return { mediaId: text(v.mediaId, 256), frameId: text(v.frameId, 512), contentHash: hash(v.contentHash), timestampMs: v.timestampMs === null ? null : number(v.timestampMs, 0, 120_000) }; }
function region(value: unknown): MatchRegion { const v = object(value); const r = { x: number(v.x, 0, 1), y: number(v.y, 0, 1), width: number(v.width, Number.EPSILON, 1), height: number(v.height, Number.EPSILON, 1) }; return r.x + r.width <= 1.000001 && r.y + r.height <= 1.000001 ? r : invalid(); }
function coverage(value: unknown): MediaCoverage {
  const v = object(value);
  if (v.kind === 'still_image') return { kind: 'still_image', fullImageDecoded: oneOf(v.fullImageDecoded, [true]) };
  if (v.kind !== 'sampled_video') return invalid();
  const durationMs = number(v.durationMs, Number.EPSILON, 120_000);
  const decodedTimestampsMs = array(v.decodedTimestampsMs, item => number(item, 0, durationMs), 3, 1);
  const sampleCount = integer(v.sampleCount, 1, 3);
  if (sampleCount !== decodedTimestampsMs.length) return invalid();
  return { kind: 'sampled_video', durationMs, requestedTimestampsMs: array(v.requestedTimestampsMs, item => number(item, 0, durationMs), 3, 1), decodedTimestampsMs, sampleCount, largestUnsampledGapMs: number(v.largestUnsampledGapMs, 0, durationMs), temporalCoverageFraction: oneOf(v.temporalCoverageFraction, [null]), audioAnalyzed: oneOf(v.audioAnalyzed, [false]) };
}
function input(value: unknown): FrameMatchReport['inputs']['left'] { const v = object(value); return { mediaId: text(v.mediaId, 256), contentHash: hash(v.contentHash), coverage: coverage(v.coverage), rasterPreprocessing: oneOf(v.rasterPreprocessing, ['encoded_orientation_black_alpha_matte']) }; }
function distance(value: unknown): PixelDistance {
  const v = object(value);
  const tiles = array(v.tiles, item => { const t = object(item); return { column: integer(t.column, 0, 3), row: integer(t.row, 0, 3), rgbError: number(t.rgbError, 0, 2), edgeError: number(t.edgeError, 0, 2), informative: bool(t.informative), retained: bool(t.retained) }; }, 16, 16);
  const comparedTiles = integer(v.comparedTiles, 16, 16), retainedTiles = integer(v.retainedTiles, 0, 16), informativeTiles = integer(v.informativeTiles, 0, retainedTiles);
  if (new Set(tiles.map(tile => `${tile.column}:${tile.row}`)).size !== 16 || tiles.filter(tile => tile.retained).length !== retainedTiles || tiles.filter(tile => tile.retained && tile.informative).length !== informativeTiles) return invalid();
  return { meanAbsoluteRgbError: number(v.meanAbsoluteRgbError, 0, 2), trimmedAbsoluteRgbError: number(v.trimmedAbsoluteRgbError, 0, 2), edgeError: number(v.edgeError, 0, 2), informativeTiles, comparedTiles, retainedTiles, tiles };
}
function pair(value: unknown): FramePairComparison { const v = object(value); return { left: reference(v.left), right: reference(v.right), leftRegion: region(v.leftRegion), rightRegion: region(v.rightRegion), status: oneOf(v.status, ['candidate_visual_overlap', 'no_candidate', 'uninformative']), basis: oneOf(v.basis, ['identical_encoded_bytes', 'bounded_pixel_alignment']), distance: distance(v.distance) }; }
function frame(value: unknown): LocalComparisonFrame {
  const v = object(value), base64 = text(v.base64, 12 * 1024 * 1024);
  if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return invalid();
  const width = integer(v.width, 1, 3840 * 2160), height = integer(v.height, 1, 3840 * 2160);
  if (width * height > 3840 * 2160) return invalid();
  return { ...reference(v), mimeType: oneOf(v.mimeType, ['image/jpeg', 'image/png', 'image/webp']), width, height, base64 };
}
function sameReference(a: FrameReference, b: FrameReference): boolean { return a.mediaId === b.mediaId && a.frameId === b.frameId && a.contentHash === b.contentHash && a.timestampMs === b.timestampMs; }
export function parseComparisonResponse(raw: unknown): LocalComparisonResponse {
  const v = object(raw), r = object(v.report), p = object(r.parameters), inputs = object(r.inputs), frames = object(v.frames), persistence = object(v.persistence);
  const result: LocalComparisonResponse = {
    schemaVersion: oneOf(v.schemaVersion, ['contexttrail-local-media-comparison-v1']),
    report: { schemaVersion: oneOf(r.schemaVersion, [1]), algorithm: oneOf(r.algorithm, ['bounded-pixel-alignment-v1']), inputs: { left: input(inputs.left), right: input(inputs.right) }, comparedFramePairs: integer(r.comparedFramePairs, 1, 9), candidates: array(r.candidates, pair, 9), comparisons: array(r.comparisons, pair, 9, 1), parameters: { minCropAxisFraction: number(p.minCropAxisFraction, 0, 1), descriptorSide: integer(p.descriptorSide, 1, 96), maxTrimmedRgbError: number(p.maxTrimmedRgbError, 0, 2), maxMeanRgbError: number(p.maxMeanRgbError, 0, 2), maxEdgeError: number(p.maxEdgeError, 0, 2), minInformativeTiles: integer(p.minInformativeTiles, 0, 16), discardedTileFraction: number(p.discardedTileFraction, 0, 1) }, limitations: array(r.limitations, item => text(item), 30, 1) },
    frames: { left: array(frames.left, frame, 3, 1), right: array(frames.right, frame, 3, 1) },
    persistence: { status: oneOf(persistence.status, ['not_saved']), reason: text(persistence.reason) },
  };
  const { report } = result;
  for (const side of ['left', 'right'] satisfies Array<'left' | 'right'>) {
    const media = report.inputs[side], supplied = result.frames[side];
    if (new Set(supplied.map(f => f.frameId)).size !== supplied.length || supplied.some(f => f.mediaId !== media.mediaId)) return invalid();
    if (media.coverage.kind === 'still_image') {
      if (supplied.length !== 1 || supplied[0].timestampMs !== null || supplied[0].contentHash !== media.contentHash) return invalid();
    } else if (supplied.length !== media.coverage.sampleCount || supplied.some((f, i) => f.timestampMs !== (media.coverage.kind === 'sampled_video' ? media.coverage.decodedTimestampsMs[i] : null))) return invalid();
  }
  if (report.comparedFramePairs !== report.comparisons.length || report.comparedFramePairs !== result.frames.left.length * result.frames.right.length) return invalid();
  const keys = new Set<string>();
  for (const comparison of report.comparisons) {
    if (!result.frames.left.some(f => sameReference(f, comparison.left)) || !result.frames.right.some(f => sameReference(f, comparison.right))) return invalid();
    keys.add(`${comparison.left.frameId}|${comparison.right.frameId}`);
  }
  if (keys.size !== report.comparisons.length || JSON.stringify(report.candidates) !== JSON.stringify(report.comparisons.filter(item => item.status === 'candidate_visual_overlap'))) return invalid();
  return result;
}
export function parseComparisonCapabilities(raw: unknown): ComparisonCapabilities {
  const v = object(raw), l = object(v.limits);
  return {
    schemaVersion: oneOf(v.schemaVersion, ['contexttrail-local-media-capabilities-v1']), mode: oneOf(v.mode, ['local_supplied_media_only']), persistence: oneOf(v.persistence, ['not_saved']), busy: bool(v.busy),
    limits: { videoBytes: integer(l.videoBytes, 1, 32 * 1024 * 1024), imageBytes: integer(l.imageBytes, 1, 8 * 1024 * 1024), videoDurationMs: integer(l.videoDurationMs, 1, 120_000), videoSamples: integer(l.videoSamples, 1, 3), comparedFramePairs: integer(l.comparedFramePairs, 1, 9), requestBytes: integer(l.requestBytes, 1, 64 * 1024 * 1024 + 64 * 1024), responseBytes: integer(l.responseBytes, 1, 16 * 1024 * 1024), uploadMs: integer(l.uploadMs, 1), deadlineMs: integer(l.deadlineMs, 1), activeJobs: integer(l.activeJobs, 1, 1) },
    formats: array(v.formats, value => { const f = object(value); return { extension: oneOf(f.extension, ['jpg', 'jpeg', 'png', 'webp', 'mp4', 'mov', 'webm', 'mkv']), kind: oneOf(f.kind, ['image', 'video']), mimeType: oneOf(f.mimeType, ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska']) }; }, 8, 1),
  };
}
export function validateComparisonFile(file: File, kind: MediaKind, capabilities: ComparisonCapabilities): string | null {
  if (!file.name || file.name.length > 256 || /[\\/\0]/.test(file.name)) return 'Choose a file with a name of at most 256 characters, without a path.';
  if (!file.size) return 'This file is empty. Choose another file.';
  const limit = kind === 'video' ? capabilities.limits.videoBytes : capabilities.limits.imageBytes;
  if (file.size > limit) return `This ${kind === 'video' ? 'video' : 'image'} exceeds the ${formatBytes(limit)} limit.`;
  const extension = file.name.split('.').pop()?.toLowerCase();
  const format = capabilities.formats.find(f => f.extension === extension && f.kind === kind);
  if (!format || (file.type && file.type !== 'application/octet-stream' && file.type !== format.mimeType)) return 'The file extension and type must match the selected media kind and a supported format.';
  return null;
}
async function responseJson(response: Response): Promise<unknown> {
  let body: unknown;
  try { body = await response.json(); } catch { throw new ComparisonClientError('The local server did not return a readable response. Your files remain selected.', 'INVALID_RESPONSE', response.status); }
  if (!response.ok) {
    const v = object(body);
    throw new ComparisonClientError(typeof v.error === 'string' && v.error.length <= 4096 ? v.error : 'Local comparison failed. Your files remain selected.', typeof v.code === 'string' ? v.code : 'REQUEST_FAILED', response.status);
  }
  return body;
}
export async function getComparisonCapabilities(signal: AbortSignal): Promise<ComparisonCapabilities> {
  return parseComparisonCapabilities(await responseJson(await fetch('/api/media/compare', { signal, cache: 'no-store' })));
}
export async function compareFiles({ left, right, leftKind, rightKind, signal }: { left: File; right: File; leftKind: MediaKind; rightKind: MediaKind; signal: AbortSignal }): Promise<LocalComparisonResponse> {
  const form = new FormData();
  form.set('left', left); form.set('right', right); form.set('leftKind', leftKind); form.set('rightKind', rightKind); form.set('rights', 'user_provided');
  return parseComparisonResponse(await responseJson(await fetch('/api/media/compare', { method: 'POST', body: form, signal, cache: 'no-store' })));
}
export function formatTimestamp(milliseconds: number | null): string {
  if (milliseconds === null) return 'Still image';
  const rounded = Math.round(milliseconds);
  const minutes = Math.floor(rounded / 60_000), seconds = Math.floor(rounded % 60_000 / 1000), fraction = rounded % 1000;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(fraction).padStart(3, '0')}`;
}
export function formatBytes(bytes: number): string { return `${(bytes / (1024 * 1024)).toFixed(bytes % (1024 * 1024) ? 2 : 0)} MiB`; }
export function frameSource(frame: LocalComparisonFrame): string { return `data:${frame.mimeType};base64,${frame.base64}`; }
