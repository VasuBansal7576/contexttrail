/** Node-only, local preparation. Does not search, upload, or make a claim verdict. */
import { inspectVisualTrack, type VisualScan } from './visual-scan';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const VIDEO_LIMITS = Object.freeze({ bytes: 32 * 1024 * 1024, durationMs: 120_000, pixels: 3840 * 2160, frames: 3, frameBytes: 500 * 1024, processMs: 15_000 });
export class VideoIngestError extends Error {
  constructor(readonly code: 'invalid_video' | 'limit_exceeded' | 'decoder_unavailable' | 'decode_failed' | 'cancelled') {
    super(code); this.name = 'VideoIngestError';
  }
}
export interface VideoFrame {
  id: string;
  mediaId: string;
  /** Decoded presentation timestamp relative to the first video frame, not publication time. */
  timestampMs: number;
  contentHash: string;
  mimeType: 'image/jpeg';
  bytes: Uint8Array;
}
export interface PreparedVideo {
  mediaId: string;
  contentHash: string;
  durationMs: number;
  frames: VideoFrame[];
  coverage: 'sampled_frames_only';
  visualScan?: VisualScan;
}
function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

/** Fixed executables, argv only, no shell; bounded output and wall time. */
function execute(binary: 'ffprobe' | 'ffmpeg', args: string[], signal?: AbortSignal, maximumOutputBytes: number = VIDEO_LIMITS.frameBytes): Promise<{ output: Buffer; diagnostic: string }> {
  if (signal?.aborted) return Promise.reject(new VideoIngestError('cancelled'));
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let failed: VideoIngestError | null = null;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const stop = (error: VideoIngestError) => { failed ??= error; child.kill('SIGKILL'); };
    const abort = () => stop(new VideoIngestError('cancelled'));
    const timer = setTimeout(() => stop(new VideoIngestError('limit_exceeded')), VIDEO_LIMITS.processMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maximumOutputBytes) stop(new VideoIngestError('limit_exceeded'));
      else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 256 * 1024) stop(new VideoIngestError('limit_exceeded'));
      else stderr.push(chunk);
    });
    child.on('error', () => { failed ??= new VideoIngestError('decoder_unavailable'); });
    child.on('close', (code) => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (failed) reject(failed);
      else if (code !== 0) reject(new VideoIngestError('decode_failed'));
      else resolve({ output: Buffer.concat(stdout), diagnostic: Buffer.concat(stderr).toString('utf8') });
    });
  });
}

export function parseVideoMetadata(raw: unknown): { durationMs: number; streamIndex: number } {
  if (typeof raw !== 'object' || raw === null || !('streams' in raw) || !Array.isArray(raw.streams) || !('format' in raw)) throw new VideoIngestError('invalid_video');
  const format = raw.format;
  const stream: unknown = raw.streams.find((s: unknown) => typeof s === 'object' && s !== null && 'codec_type' in s && s.codec_type === 'video');
  if (typeof format !== 'object' || format === null || !('duration' in format) || typeof format.duration !== 'string' || typeof stream !== 'object' || stream === null || !('width' in stream) || !('height' in stream) || !('index' in stream)) throw new VideoIngestError('invalid_video');
  const durationMs = Number(format.duration) * 1000;
  const { width, height, index } = stream;
  if (!Number.isFinite(durationMs) || durationMs <= 0 || typeof width !== 'number' || !Number.isInteger(width) || width <= 0 || typeof height !== 'number' || !Number.isInteger(height) || height <= 0 || typeof index !== 'number' || !Number.isInteger(index) || index < 0) throw new VideoIngestError('invalid_video');
  if (durationMs > VIDEO_LIMITS.durationMs || width * height > VIDEO_LIMITS.pixels) throw new VideoIngestError('limit_exceeded');
  return { durationMs, streamIndex: index };
}

/** Uniform samples are candidates, not scene detection or comprehensive coverage. */
export function sampleTimes(durationMs: number): number[] {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > VIDEO_LIMITS.durationMs) throw new VideoIngestError('invalid_video');
  return [0, durationMs / 3, durationMs * 2 / 3];
}

/** Accept bytes from an authorized upload or local file, never a path/URL supplied to FFmpeg. */
export async function prepareVideo(bytes: Uint8Array, options: { signal?: AbortSignal; scanTrack?: boolean } = {}): Promise<PreparedVideo> {
  if (!bytes.byteLength) throw new VideoIngestError('invalid_video');
  if (bytes.byteLength > VIDEO_LIMITS.bytes) throw new VideoIngestError('limit_exceeded');
  if (options.signal?.aborted) throw new VideoIngestError('cancelled');
  // Copy before the first await so concurrent caller mutation cannot alter identity.
  const snapshot = Buffer.from(bytes);
  const contentHash = hash(snapshot);
  const mediaId = `video:sha256:${contentHash}`;
  const directory = await mkdtemp(join(tmpdir(), 'contexttrail-video-'));
  try {
    const input = join(directory, 'input');
    await writeFile(input, snapshot, { mode: 0o600 });
    // Only self-contained MP4/MOV or Matroska/WebM. No HLS, playlists, network
    // protocols, or user filenames. FFmpeg's external MOV data refs stay disabled.
    const restrictions = ['-max_alloc', '67108864', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm'];
    const probe = await execute('ffprobe', ['-v', 'error', ...restrictions, '-show_entries', 'format=duration:stream=index,codec_type,width,height', '-of', 'json', input], options.signal);
    let metadata: unknown;
    try { metadata = JSON.parse(probe.output.toString('utf8')); } catch { throw new VideoIngestError('invalid_video'); }
    const { durationMs, streamIndex } = parseVideoMetadata(metadata);
    let visualScan: VisualScan | undefined;
    if (options.scanTrack) {
      const scanned = await execute('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-threads', '1', ...restrictions, '-i', input, '-map', `0:${streamIndex}`, '-an', '-sn', '-dn', '-vf', 'setpts=PTS-STARTPTS,fps=2:round=up,scale=64:64,format=gray', '-threads', '1', '-f', 'rawvideo', 'pipe:1'], options.signal, 1024 * 1024);
      visualScan = inspectVisualTrack(scanned.output, durationMs);
    }
    const frames: VideoFrame[] = [];
    for (const target of visualScan?.searchTargetsMs ?? sampleTimes(durationMs)) {
      const filter = `setpts=PTS-STARTPTS,select=gte(t\\,${target / 1000}),scale=640:640:force_original_aspect_ratio=decrease,showinfo`;
      const decoded = await execute('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'info', '-threads', '1', ...restrictions, '-i', input, '-map', `0:${streamIndex}`, '-an', '-sn', '-dn', '-vf', filter, '-frames:v', '1', '-threads', '1', '-c:v', 'mjpeg', '-q:v', '4', '-f', 'image2pipe', 'pipe:1'], options.signal);
      const pts = /\bpts_time:([\d.eE+-]+)/.exec(decoded.diagnostic)?.[1];
      const timestampMs = pts === undefined ? NaN : Number(pts) * 1000;
      if (!Number.isFinite(timestampMs) || timestampMs < 0 || timestampMs > durationMs || decoded.output.length < 4 || decoded.output[0] !== 0xff || decoded.output[1] !== 0xd8) throw new VideoIngestError('decode_failed');
      // Sparse/VFR video can select the same decoded frame for several targets.
      if (frames.some(frame => frame.timestampMs === timestampMs)) continue;
      const frameHash = hash(decoded.output);
      frames.push({ id: `${mediaId}:frame:${timestampMs}`, mediaId, timestampMs, contentHash: frameHash, mimeType: 'image/jpeg', bytes: decoded.output });
    }
    return { mediaId, contentHash, durationMs, frames, coverage: 'sampled_frames_only', ...(visualScan ? { visualScan } : {}) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
