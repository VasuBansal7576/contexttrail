/** Author-run synthetic held-out evaluation. Frozen algorithm, no network, no external assets. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { prepareMatchMedia } from '../src/lib/video/matching/prepare';
import { comparePreparedMedia, MATCH_PARAMETERS } from '../src/lib/video/matching/compare';
import type { PreparedMatchMedia } from '../src/lib/video/matching/model';
import { transformPng } from '../src/lib/video/matching/fixtures';

const FROZEN_COMMIT = '7093c027197f967acea6a43e612bd11fb2a2220f';
const FROZEN_FILES = ['compare.ts'];
const RECORDED_FILES = [...FROZEN_FILES, 'decode.ts', 'prepare.ts', 'model.ts'];
type Segment = { startMs: number; endMs: number; label: string };
type Asset = { id: string; file: string; kind: 'image' | 'video'; segments: Segment[]; sha256: string };
type EvaluationCase = { id: string; left: string; right: string; expectation: string; challenge: boolean };
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function ffmpeg(args: string[]): void { execFileSync('ffmpeg', ['-v', 'error', ...args], { timeout: 15000, maxBuffer: 65536 }); }

/** Different construction and fresh seeds from development fixtures: colored polygon bands and waves. */
function heldoutScene(seed: number, sharedBackdrop = false): Buffer {
  const width = 320, height = 240, png = new PNG({ width, height });
  let state = seed >>> 0;
  const rand = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296; };
  const palette = Array.from({ length: 8 }, () => [30 + rand() * 195, 30 + rand() * 195, 30 + rand() * 195]);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    for (let c = 0; c < 3; c++) {
      const band = Math.floor((x + y * (0.3 + (seed % 7) * 0.1)) / 53) % 8;
      const value = sharedBackdrop
        ? 128 + 88 * Math.sin(x / 15 + c * 1.7) * Math.cos(y / 17 + c * 0.4)
        : palette[band][c] + 35 * Math.sin(x / (11 + c * 3) + seed % 19) * Math.cos(y / (9 + seed % 7));
      png.data[i + c] = Math.max(0, Math.min(255, value));
    }
    if (sharedBackdrop && x >= 110 && x < 210 && y >= 75 && y < 165) {
      png.data[i] = seed % 2 ? 245 : 20; png.data[i + 1] = seed % 2 ? 25 : 230; png.data[i + 2] = seed % 2 ? 40 : 220;
    }
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}
function labelAt(asset: Asset, timestamp: number | null): string {
  const segment = asset.segments.find(part => (timestamp ?? 0) >= part.startMs && (timestamp ?? 0) < part.endMs);
  if (!segment) throw new Error(`No generated ground-truth label for ${asset.id} at ${timestamp}`);
  return segment.label;
}
async function main(): Promise<void> {
  const args = process.argv.slice(2).filter(arg => arg !== '--');
  if (args.length !== 1) throw new Error('Usage: npm run media:evaluate -- new-output-directory');
  const directory = args[0];
  // The complete comparison algorithm and thresholds stay frozen. Input/decoder fixes
  // are separately hashed; reruns after a fix are reproducibility checks, not new held-out evidence.
  for (const name of FROZEN_FILES) {
    const path = `src/lib/video/matching/${name}`;
    const expected = execFileSync('git', ['show', `${FROZEN_COMMIT}:${path}`]);
    if (!expected.equals(await readFile(path))) throw new Error('Frozen matcher differs; reserve new held-out cases for a changed algorithm');
  }
  await mkdir(directory, { mode: 0o700 });
  await mkdir(join(directory, 'media'), { mode: 0o700 });
  await mkdir(join(directory, 'frames'), { mode: 0o700 });
  await mkdir(join(directory, 'reports'), { mode: 0o700 });
  const assets = new Map<string, Asset>();
  async function record(id: string, file: string, kind: Asset['kind'], segments: Segment[]) {
    assets.set(id, { id, file, kind, segments, sha256: hash(await readFile(join(directory, file))) });
  }
  async function still(id: string, pixels: Buffer, label: string) {
    const file = `media/${id}.png`; await writeFile(join(directory, file), pixels, { mode: 0o600 });
    await record(id, file, 'image', [{ startMs: 0, endMs: 1, label }]);
  }
  async function video(id: string, scenes: Buffer[], labels: string[], extension = 'mp4', inputRate = 1) {
    for (const [index, pixels] of scenes.entries()) await writeFile(join(directory, 'media', `${id}-${index}.png`), pixels, { mode: 0o600 });
    const file = `media/${id}.${extension}`;
    ffmpeg(['-framerate', String(inputRate), '-i', join(directory, 'media', `${id}-%d.png`), '-an', '-threads', '1', '-c:v', extension === 'webm' ? 'libvpx' : 'mpeg4', '-pix_fmt', 'yuv420p', '-r', '10', join(directory, file)]);
    await record(id, file, 'video', labels.map((label, index) => ({ startMs: index * 1000 / inputRate, endMs: (index + 1) * 1000 / inputRate, label })));
  }
  const scenes = [heldoutScene(54017), heldoutScene(89131), heldoutScene(73291)], labels = ['scene-a', 'scene-b', 'scene-c'];
  const unrelated = [heldoutScene(21061), heldoutScene(47287), heldoutScene(90523)], unrelatedLabels = ['other-a', 'other-b', 'other-c'];
  await video('original', scenes, labels);
  await video('transcode', scenes, labels, 'webm');
  await video('offset-crop', scenes.map(bytes => transformPng(bytes, { crop: { x: 58, y: 17, width: 220, height: 192 } })), labels, 'webm');
  await video('subtitles', scenes.map(bytes => transformPng(bytes, { overlay: true })), labels);
  await video('crop-subtitles', scenes.map(bytes => transformPng(bytes, { crop: { x: 22, y: 38, width: 252, height: 172 }, overlay: true })), labels);
  await video('reordered', [scenes[2], scenes[0], scenes[1]], [labels[2], labels[0], labels[1]], 'webm');
  await video('reused-segment', [unrelated[0], scenes[1], unrelated[2]], [unrelatedLabels[0], labels[1], unrelatedLabels[2]]);
  await video('unrelated', unrelated, unrelatedLabels, 'webm');
  await video('brightness', scenes.map(bytes => transformPng(bytes, { brightness: 17 })), labels);
  await video('mirror', scenes.map(bytes => transformPng(bytes, { mirror: true })), labels);
  await video('severe-crop', scenes.map(bytes => transformPng(bytes, { crop: { x: 104, y: 90, width: 112, height: 96 } })), labels);
  await video('brief-reuse', [unrelated[0], unrelated[0], scenes[1], unrelated[0], unrelated[0], unrelated[1], unrelated[1], unrelated[1], unrelated[1], unrelated[1], unrelated[2], unrelated[2], unrelated[2], unrelated[2], unrelated[2]], ['other-a', 'other-a', 'scene-b', 'other-a', 'other-a', 'other-b', 'other-b', 'other-b', 'other-b', 'other-b', 'other-c', 'other-c', 'other-c', 'other-c', 'other-c'], 'mp4', 5);
  const original = assets.get('original'); if (!original) throw new Error('Missing original');
  ffmpeg(['-i', join(directory, original.file), '-vf', 'rotate=12*PI/180:fillcolor=black', '-an', '-threads', '1', '-c:v', 'mpeg4', join(directory, 'media', 'rotated.mp4')]);
  await record('rotated', 'media/rotated.mp4', 'video', original.segments);
  await still('still-b', scenes[1], labels[1]);
  await still('shared-pattern-a', heldoutScene(11111, true), 'independent-pattern-a');
  await still('shared-pattern-b', heldoutScene(22222, true), 'independent-pattern-b');
  ffmpeg(['-i', join(directory, 'media', 'still-b.png'), '-vf', 'scale=160:120', '-frames:v', '1', '-threads', '1', '-q:v', '8', join(directory, 'media', 'resized-b.jpg')]);
  await record('resized-b', 'media/resized-b.jpg', 'image', [{ startMs: 0, endMs: 1, label: 'scene-b' }]);
  const cases: EvaluationCase[] = [
    { id: 'original', left: 'original', right: 'original', expectation: 'Three matching sampled moments; same file also checks encoded frame identity', challenge: false },
    { id: 'transcode', left: 'original', right: 'transcode', expectation: 'MP4 to WebM sampled visual correspondence', challenge: false },
    { id: 'offset-crop', left: 'original', right: 'offset-crop', expectation: 'Unseen asymmetric crop offset and dimensions', challenge: false },
    { id: 'subtitles', left: 'original', right: 'subtitles', expectation: 'Bottom-strip subtitle-like glyph overlay', challenge: false },
    { id: 'crop-subtitles', left: 'original', right: 'crop-subtitles', expectation: 'Combined unseen crop and subtitle overlay', challenge: false },
    { id: 'reordered', left: 'original', right: 'reordered', expectation: 'Sampled moments reorder to 2,0,1; no segment-boundary inference', challenge: false },
    { id: 'reused-segment', left: 'original', right: 'reused-segment', expectation: 'Only the middle sampled scene is reused', challenge: false },
    { id: 'unrelated', left: 'original', right: 'unrelated', expectation: 'No corresponding generated scene', challenge: false },
    { id: 'brightness', left: 'original', right: 'brightness', expectation: 'Unseen brightness shift of 17 levels', challenge: false },
    { id: 'resized-still', left: 'resized-b', right: 'transcode', expectation: 'Resized lossy JPEG matches only the middle video sample', challenge: false },
    { id: 'still-to-crop', left: 'still-b', right: 'offset-crop', expectation: 'Unseen still-to-cropped-video correspondence', challenge: false },
    { id: 'mirror', left: 'original', right: 'mirror', expectation: 'Derived visuals; reflection is outside the search family', challenge: true },
    { id: 'rotated', left: 'original', right: 'rotated', expectation: 'Derived visuals; 12-degree rotation is outside the search family', challenge: true },
    { id: 'severe-crop', left: 'original', right: 'severe-crop', expectation: 'Derived visuals; 35%/40% crop is below the supported search bound', challenge: true },
    { id: 'brief-reuse', left: 'original', right: 'brief-reuse', expectation: 'Scene b appears only at 400–600 ms, between sampled points; sampled correspondence is absent although whole-video reuse exists', challenge: true },
    { id: 'shared-pattern-negative', left: 'shared-pattern-a', right: 'shared-pattern-b', expectation: 'Different generated subjects on a generic repeating backdrop; candidate collision counts as a false scene correspondence', challenge: true },
  ];
  // Persist the full specification before running the matcher. No outcome-dependent edits.
  const manifest = { schemaVersion: 1, evidenceTier: 'author-run synthetic held-out', algorithmCommit: FROZEN_COMMIT, preprocessing: 'black alpha matte before resizing, encoded orientation; decoder hashes recorded separately', algorithmFiles: Object.fromEntries(await Promise.all(RECORDED_FILES.map(async name => [name, hash(await readFile(`src/lib/video/matching/${name}`))]))), parameters: MATCH_PARAMETERS, rights: 'All pixels are generated by this script; no external assets', evaluationLimits: ['Author-run, not independent validation', 'Synthetic geometry only, not a representative real-world video corpus', 'No thresholds changed after observing this held-out set', 'Ground truth is generated scene correspondence, not truth, authenticity, copying or source attribution'], assets: [...assets.values()], cases };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  const prepared = new Map<string, PreparedMatchMedia>();
  for (const asset of assets.values()) {
    const media = await prepareMatchMedia({ kind: asset.kind, bytes: await readFile(join(directory, asset.file)), rights: 'user_provided' });
    prepared.set(asset.id, media);
    for (const [index, frame] of media.frames.entries()) await writeFile(join(directory, 'frames', `${asset.id}-${index}.${frame.mimeType === 'image/jpeg' ? 'jpg' : frame.mimeType === 'image/webp' ? 'webp' : 'png'}`), frame.bytes, { mode: 0o600 });
  }
  const results = [];
  for (const item of cases) {
    const left = prepared.get(item.left), right = prepared.get(item.right), lAsset = assets.get(item.left), rAsset = assets.get(item.right);
    if (!left || !right || !lAsset || !rAsset) throw new Error('Incomplete case');
    const report = comparePreparedMedia(left, right);
    await writeFile(join(directory, 'reports', `${item.id}.json`), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    const pairs = report.comparisons.map(pair => {
      const expected = labelAt(lAsset, pair.left.timestampMs) === labelAt(rAsset, pair.right.timestampMs), observed = pair.status === 'candidate_visual_overlap';
      return { leftTimestampMs: pair.left.timestampMs, rightTimestampMs: pair.right.timestampMs, expected, observed, outcome: expected ? observed ? 'true_positive' : 'false_negative' : observed ? 'false_positive' : 'true_negative' };
    });
    const counts = { true_positive: 0, false_positive: 0, false_negative: 0, true_negative: 0 };
    for (const pair of pairs) {
      switch (pair.outcome) { case 'true_positive': counts.true_positive++; break; case 'false_positive': counts.false_positive++; break; case 'false_negative': counts.false_negative++; break; case 'true_negative': counts.true_negative++; break; }
    }
    const wholeVideoOverlap = lAsset.segments.some(l => rAsset.segments.some(r => l.label === r.label));
    results.push({ ...item, counts, pairs, wholeVideoOverlap, observedAnyCandidate: report.candidates.length > 0, report: `reports/${item.id}.json` });
  }
  const total = results.reduce((sum, result) => ({ true_positive: sum.true_positive + result.counts.true_positive, false_positive: sum.false_positive + result.counts.false_positive, false_negative: sum.false_negative + result.counts.false_negative, true_negative: sum.true_negative + result.counts.true_negative }), { true_positive: 0, false_positive: 0, false_negative: 0, true_negative: 0 });
  const summary = { ...manifest, ffmpegVersion: execFileSync('ffmpeg', ['-version']).toString().split('\n')[0], totals: total, results, failures: results.filter(result => result.counts.false_positive || result.counts.false_negative || (result.wholeVideoOverlap && !result.observedAnyCandidate)), interpretation: 'Generated-scene correspondence counts across the specified pairs only; not product accuracy. Brief reuse between samples is listed separately as a coverage miss.' };
  await writeFile(join(directory, 'evaluation.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify({ totals: total, cases: results.map(result => ({ id: result.id, counts: result.counts, wholeVideoOverlap: result.wholeVideoOverlap, observedAnyCandidate: result.observedAnyCandidate })), output: directory }, null, 2) + '\n');
}
void main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'Evaluation failed'}\n`); process.exitCode = 1; });
