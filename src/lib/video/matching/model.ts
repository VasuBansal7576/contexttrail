/** Local comparison output. Deliberately separate from CaseRecord and evidence identity verdicts. */
export const MATCH_LIMITS = Object.freeze({ imageBytes: 8 * 1024 * 1024, imagePixels: 3840 * 2160, rasterSide: 96, processMs: 15_000 });
export class FrameMatchError extends Error {
  constructor(readonly code: 'invalid_image' | 'limit_exceeded' | 'decoder_unavailable' | 'decode_failed' | 'cancelled' | 'rights_required') {
    super(code); this.name = 'FrameMatchError';
  }
}
export type LocalMediaInput = { kind: 'video' | 'image'; bytes: Uint8Array; rights: 'user_provided' };
export type FrameReference = {
  mediaId: string; frameId: string; contentHash: string;
  /** Null for a still image. Video timestamps are decoded media-relative presentation times. */
  timestampMs: number | null;
};
export type PreparedMatchFrame = FrameReference & {
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp'; bytes: Uint8Array;
  width: number; height: number;
  /** Fixed 96 × 96 RGB raster, private to local matching; not retained in reports. */
  pixels: Uint8Array;
};
export type MediaCoverage =
  | { kind: 'still_image'; fullImageDecoded: true }
  | { kind: 'sampled_video'; durationMs: number; requestedTimestampsMs: number[]; decodedTimestampsMs: number[]; sampleCount: number; largestUnsampledGapMs: number; temporalCoverageFraction: null; audioAnalyzed: false };
export type PreparedMatchMedia = {
  mediaId: string; contentHash: string; coverage: MediaCoverage; frames: PreparedMatchFrame[];
  rasterPreprocessing: 'encoded_orientation_black_alpha_matte';
};
/** Fractions of the decoded image. Not an automatic evidence anchor or exact object boundary. */
export type MatchRegion = { x: number; y: number; width: number; height: number };
export type PixelDistance = {
  /** Distances in [0,1], lower is closer. Not a confidence or probability. */
  meanAbsoluteRgbError: number; trimmedAbsoluteRgbError: number; edgeError: number;
  informativeTiles: number; comparedTiles: number; retainedTiles: number;
  tiles: { column: number; row: number; rgbError: number; edgeError: number; informative: boolean; retained: boolean }[];
};
export type FramePairComparison = {
  left: FrameReference; right: FrameReference;
  leftRegion: MatchRegion; rightRegion: MatchRegion;
  status: 'candidate_visual_overlap' | 'no_candidate' | 'uninformative';
  basis: 'identical_encoded_bytes' | 'bounded_pixel_alignment';
  distance: PixelDistance;
};
export type FrameMatchReport = {
  schemaVersion: 1; algorithm: 'bounded-pixel-alignment-v1';
  inputs: { left: Omit<PreparedMatchMedia, 'frames'>; right: Omit<PreparedMatchMedia, 'frames'> };
  comparedFramePairs: number; candidates: FramePairComparison[]; comparisons: FramePairComparison[];
  parameters: { minCropAxisFraction: number; descriptorSide: number; maxTrimmedRgbError: number; maxMeanRgbError: number; maxEdgeError: number; minInformativeTiles: number; discardedTileFraction: number };
  limitations: string[];
};
