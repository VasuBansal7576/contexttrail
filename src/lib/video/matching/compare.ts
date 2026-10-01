import { setImmediate } from 'node:timers/promises';
import { FrameMatchError, MATCH_LIMITS, type FrameMatchReport, type FramePairComparison, type FrameReference, type MatchRegion, type PixelDistance, type PreparedMatchFrame, type PreparedMatchMedia } from './model';

/** Fixed before held-out evaluation. These are heuristic gates, not calibrated probabilities. */
export const MATCH_PARAMETERS = Object.freeze({ minCropAxisFraction: 0.6, descriptorSide: 24, maxTrimmedRgbError: 0.065, maxMeanRgbError: 0.15, maxEdgeError: 0.07, minInformativeTiles: 8, discardedTileFraction: 0.25 });
const FULL: MatchRegion = { x: 0, y: 0, width: 1, height: 1 };
const SIDE = MATCH_LIMITS.rasterSide, GRID = MATCH_PARAMETERS.descriptorSide;
type Integral = Float64Array;
type Alignment = { leftRegion: MatchRegion; rightRegion: MatchRegion; distance: PixelDistance; loss: number };
function integral(pixels: Uint8Array): Integral {
  const table = new Float64Array((SIDE + 1) * (SIDE + 1) * 3);
  for (let y = 1; y <= SIDE; y++) for (let x = 1; x <= SIDE; x++) for (let c = 0; c < 3; c++) {
    const offset = (y * (SIDE + 1) + x) * 3 + c;
    table[offset] = pixels[((y - 1) * SIDE + x - 1) * 3 + c] + table[offset - 3] + table[offset - (SIDE + 1) * 3] - table[offset - (SIDE + 2) * 3];
  }
  return table;
}
function at(table: Integral, x: number, y: number, c: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(SIDE, x0 + 1), y1 = Math.min(SIDE, y0 + 1), dx = x - x0, dy = y - y0;
  const a = table[(y0 * (SIDE + 1) + x0) * 3 + c], b = table[(y0 * (SIDE + 1) + x1) * 3 + c];
  const d = table[(y1 * (SIDE + 1) + x0) * 3 + c], e = table[(y1 * (SIDE + 1) + x1) * 3 + c];
  return (a * (1 - dx) + b * dx) * (1 - dy) + (d * (1 - dx) + e * dx) * dy;
}
function descriptor(table: Integral, region: MatchRegion): Float64Array {
  const data = new Float64Array(GRID * GRID * 3);
  const width = region.width * SIDE / GRID, height = region.height * SIDE / GRID;
  for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) {
    const x0 = region.x * SIDE + x * width, y0 = region.y * SIDE + y * height;
    const x1 = Math.min(SIDE, x0 + width), y1 = Math.min(SIDE, y0 + height);
    for (let c = 0; c < 3; c++) data[(y * GRID + x) * 3 + c] = (at(table, x1, y1, c) - at(table, x0, y1, c) - at(table, x1, y0, c) + at(table, x0, y0, c)) / (width * height);
  }
  return data;
}
const luminance = (data: Float64Array, i: number) => 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
function distance(left: Float64Array, right: Float64Array): PixelDistance {
  // A single bounded brightness offset tolerates modest exposure changes, not independent recoloring.
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference += left[i] - right[i];
  const brightness = Math.max(-24, Math.min(24, difference / left.length));
  const tiles: { column: number; row: number; rgb: number; edge: number; informative: boolean }[] = [];
  for (let ty = 0; ty < 4; ty++) for (let tx = 0; tx < 4; tx++) {
    let rgb = 0, edge = 0, edgeCount = 0, sumL = 0, sumR = 0, squareL = 0, squareR = 0;
    for (let y = ty * 6; y < (ty + 1) * 6; y++) for (let x = tx * 6; x < (tx + 1) * 6; x++) {
      const i = (y * GRID + x) * 3, l = luminance(left, i), r = luminance(right, i);
      for (let c = 0; c < 3; c++) rgb += Math.abs(left[i + c] - right[i + c] - brightness);
      sumL += l; sumR += r; squareL += l * l; squareR += r * r;
      for (const next of [x < (tx + 1) * 6 - 1 ? i + 3 : -1, y < (ty + 1) * 6 - 1 ? i + GRID * 3 : -1]) if (next >= 0) {
        edge += Math.abs((luminance(left, next) - l) - (luminance(right, next) - r)); edgeCount++;
      }
    }
    tiles.push({ column: tx, row: ty, rgb: rgb / (36 * 3 * 255), edge: edge / (edgeCount * 255), informative: squareL / 36 - (sumL / 36) ** 2 >= 64 && squareR / 36 - (sumR / 36) ** 2 >= 64 });
  }
  const meanAbsoluteRgbError = tiles.reduce((sum, tile) => sum + tile.rgb, 0) / tiles.length;
  tiles.sort((a, b) => a.rgb - b.rgb);
  const retained = tiles.slice(0, 12);
  return { meanAbsoluteRgbError, trimmedAbsoluteRgbError: retained.reduce((sum, tile) => sum + tile.rgb, 0) / retained.length, edgeError: retained.reduce((sum, tile) => sum + tile.edge, 0) / retained.length, informativeTiles: retained.filter(tile => tile.informative).length, comparedTiles: tiles.length, retainedTiles: retained.length, tiles: tiles.map((tile, index) => ({ column: tile.column, row: tile.row, rgbError: tile.rgb, edgeError: tile.edge, informative: tile.informative, retained: index < 12 })).sort((a, b) => a.row - b.row || a.column - b.column) };
}
function loss(d: PixelDistance): number {
  return d.trimmedAbsoluteRgbError + 0.3 * d.edgeError + Math.max(0, MATCH_PARAMETERS.minInformativeTiles - d.informativeTiles) * 0.02;
}
function align(left: Integral, right: Integral): Alignment {
  const lFull = descriptor(left, FULL), rFull = descriptor(right, FULL), d = distance(lFull, rFull);
  let best: Alignment = { leftRegion: FULL, rightRegion: FULL, distance: d, loss: loss(d) };
  // At most one view is cropped. Crop width and height can vary separately.
  for (const cropLeft of [true, false]) {
    const evaluate = (region: MatchRegion): Alignment => {
      const measured = cropLeft ? distance(descriptor(left, region), rFull) : distance(lFull, descriptor(right, region));
      return { leftRegion: cropLeft ? region : FULL, rightRegion: cropLeft ? FULL : region, distance: measured, loss: loss(measured) };
    };
    let local: Alignment = { leftRegion: FULL, rightRegion: FULL, distance: d, loss: loss(d) };
    for (const width of [1, 0.9, 0.8, 0.7, 0.6]) for (const height of [1, 0.9, 0.8, 0.7, 0.6]) {
      for (const xStep of width === 1 ? [0] : [0, 0.5, 1]) for (const yStep of height === 1 ? [0] : [0, 0.5, 1]) {
        const result = evaluate({ x: (1 - width) * xStep, y: (1 - height) * yStep, width, height });
        if (result.loss < local.loss) local = result;
      }
    }
    // Fixed bounded coordinate descent refines the best coarse alignment.
    let region = cropLeft ? local.leftRegion : local.rightRegion;
    for (const step of [0.05, 0.025, 0.0125, 0.00625]) for (const field of ['x', 'y', 'width', 'height'] as const) {
      for (const direction of [-1, 1]) {
        const candidate = { ...region, [field]: region[field] + direction * step };
        if (candidate.x < 0 || candidate.y < 0 || candidate.width < 0.6 || candidate.height < 0.6 || candidate.x + candidate.width > 1 || candidate.y + candidate.height > 1) continue;
        const result = evaluate(candidate);
        if (result.loss < local.loss) { local = result; region = candidate; }
      }
    }
    if (local.loss < best.loss) best = local;
  }
  return best;
}
function reference(frame: PreparedMatchFrame): FrameReference {
  return { mediaId: frame.mediaId, frameId: frame.frameId, timestampMs: frame.timestampMs, contentHash: frame.contentHash };
}
function comparePair(left: PreparedMatchFrame, right: PreparedMatchFrame, l: Integral, r: Integral): FramePairComparison {
  const identical = left.contentHash === right.contentHash;
  const fullDistance = identical ? distance(descriptor(l, FULL), descriptor(r, FULL)) : null;
  const aligned = fullDistance ? { leftRegion: FULL, rightRegion: FULL, distance: fullDistance } : align(l, r);
  const d = aligned.distance;
  const informative = d.informativeTiles >= MATCH_PARAMETERS.minInformativeTiles;
  const matches = identical || (informative && d.trimmedAbsoluteRgbError <= MATCH_PARAMETERS.maxTrimmedRgbError && d.edgeError <= MATCH_PARAMETERS.maxEdgeError && d.meanAbsoluteRgbError <= MATCH_PARAMETERS.maxMeanRgbError);
  return { left: reference(left), right: reference(right), leftRegion: aligned.leftRegion, rightRegion: aligned.rightRegion, status: matches ? 'candidate_visual_overlap' : informative ? 'no_candidate' : 'uninformative', basis: identical ? 'identical_encoded_bytes' : 'bounded_pixel_alignment', distance: d };
}
/** Compare only locally prepared bytes. Does not rank sources, infer sequence identity or modify cases. */
function* compareFramePairs(left: PreparedMatchMedia, right: PreparedMatchMedia): Generator<FramePairComparison> {
  const rightTables = right.frames.map(frame => integral(frame.pixels));
  for (const l of left.frames) {
    const lTable = integral(l.pixels);
    for (const [index, r] of right.frames.entries()) yield comparePair(l, r, lTable, rightTables[index]);
  }
}
function report(left: PreparedMatchMedia, right: PreparedMatchMedia, comparisons: FramePairComparison[]): FrameMatchReport {
  const { frames: _leftFrames, ...leftInput } = left, { frames: _rightFrames, ...rightInput } = right;
  return {
    schemaVersion: 1, algorithm: 'bounded-pixel-alignment-v1', inputs: { left: leftInput, right: rightInput }, comparedFramePairs: comparisons.length,
    candidates: comparisons.filter(pair => pair.status === 'candidate_visual_overlap'), comparisons, parameters: MATCH_PARAMETERS,
    limitations: [
      'Candidates are heuristic sampled visual overlaps requiring human inspection, not confidence probabilities or findings.',
      'Three requested video moments only. Unsampled intervals, brief reuse, and changed playback timing can be missed. No full-video identity or understanding.',
      'Search compares one full view against crops retaining at least 60% of each axis. Both-sided crops, rotations, mirrors, perspective and large overlays are unsupported.',
      'The highest-error quarter of image tiles is excluded from the trimmed score. Those regions may contain consequential visual changes or captions.',
      'Generic patterns and low-detail backgrounds can collide. A no-candidate result does not establish absence of reuse.',
      'No OCR, transcript, audio, narration, semantic entailment, authenticity, copying, original-uploader or publication-date assessment.',
      'Local supplied-file comparison only. No web search, retrieval or provider calls. CaseRecord and evidence identity are unchanged.',
    ],
  };
}

/** Original synchronous CLI behavior and frozen pair order. */
export function comparePreparedMedia(left: PreparedMatchMedia, right: PreparedMatchMedia): FrameMatchReport {
  return report(left, right, [...compareFramePairs(left, right)]);
}
/** Same comparisons; yield between bounded pairs so the HTTP client can cancel. */
export async function comparePreparedMediaAsync(left: PreparedMatchMedia, right: PreparedMatchMedia, signal: AbortSignal): Promise<FrameMatchReport> {
  const comparisons: FramePairComparison[] = [];
  const pairs = compareFramePairs(left, right);
  while (true) {
    await setImmediate();
    if (signal.aborted) throw new FrameMatchError('cancelled');
    const next = pairs.next();
    if (next.done) break;
    comparisons.push(next.value);
  }
  return report(left, right, comparisons);
}
