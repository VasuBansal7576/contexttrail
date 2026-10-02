/** Bounded local still-image decode. Fixed executables and pipe formats; no URLs or provider calls. */
import { spawn } from 'node:child_process';
import { FrameMatchError, MATCH_LIMITS } from './model';

type ImageFormat = { format: 'jpeg_pipe' | 'png_pipe' | 'webp_pipe'; mimeType: 'image/jpeg' | 'image/png' | 'image/webp' };
function imageFormat(bytes: Buffer): ImageFormat {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { format: 'jpeg_pipe', mimeType: 'image/jpeg' };
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    for (let offset = 8; offset < bytes.length;) {
      if (offset + 12 > bytes.length) throw new FrameMatchError('invalid_image');
      const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
      if (offset + length + 12 > bytes.length || ['acTL', 'fcTL', 'fdAT'].includes(type)) throw new FrameMatchError('invalid_image');
      offset += length + 12;
    }
    return { format: 'png_pipe', mimeType: 'image/png' };
  }
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    for (let offset = 12; offset < bytes.length;) {
      if (offset + 8 > bytes.length) throw new FrameMatchError('invalid_image');
      const type = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4);
      if (offset + length + 8 > bytes.length || ['ANIM', 'ANMF'].includes(type) || (type === 'VP8X' && (bytes[offset + 8] & 2))) throw new FrameMatchError('invalid_image');
      offset += 8 + length + length % 2;
    }
    return { format: 'webp_pipe', mimeType: 'image/webp' };
  }
  throw new FrameMatchError('invalid_image');
}
function execute(binary: 'ffmpeg' | 'ffprobe', args: string[], input: Buffer, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  if (signal?.aborted) return Promise.reject(new FrameMatchError('cancelled'));
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const output: Buffer[] = [];
    let count = 0, diagnosticCount = 0, failed: FrameMatchError | null = null;
    const stop = (error: FrameMatchError) => { failed ??= error; child.kill('SIGKILL'); };
    const abort = () => stop(new FrameMatchError('cancelled'));
    const timer = setTimeout(() => stop(new FrameMatchError('limit_exceeded')), MATCH_LIMITS.processMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => { count += chunk.length; if (count > maxBytes) stop(new FrameMatchError('limit_exceeded')); else output.push(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { diagnosticCount += chunk.length; if (diagnosticCount > 64 * 1024) stop(new FrameMatchError('limit_exceeded')); });
    child.on('error', () => { failed ??= new FrameMatchError('decoder_unavailable'); });
    // Invalid input or a failed spawn may close stdin before the write finishes.
    child.stdin.on('error', () => {});
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (failed) reject(failed);
      else if (code !== 0) reject(new FrameMatchError('decode_failed'));
      else resolve(Buffer.concat(output));
    });
    child.stdin.end(input);
  });
}
export async function decodeMatchImage(bytes: Uint8Array, signal?: AbortSignal): Promise<{ mimeType: ImageFormat['mimeType']; width: number; height: number; pixels: Uint8Array }> {
  if (!bytes.byteLength) throw new FrameMatchError('invalid_image');
  if (bytes.byteLength > MATCH_LIMITS.imageBytes) throw new FrameMatchError('limit_exceeded');
  const snapshot = Buffer.from(bytes), { format, mimeType } = imageFormat(snapshot);
  const inputArgs = ['-max_alloc', '67108864', '-protocol_whitelist', 'pipe', '-f', format, '-i', 'pipe:0'];
  const metadata = await execute('ffprobe', ['-v', 'error', ...inputArgs, '-show_entries', 'stream=width,height,pix_fmt', '-of', 'json'], snapshot, 4096, signal);
  let raw: unknown;
  try { raw = JSON.parse(metadata.toString('utf8')); } catch { throw new FrameMatchError('invalid_image'); }
  if (typeof raw !== 'object' || raw === null || !('streams' in raw) || !Array.isArray(raw.streams) || raw.streams.length !== 1) throw new FrameMatchError('invalid_image');
  const stream: unknown = raw.streams[0];
  if (typeof stream !== 'object' || stream === null || !('width' in stream) || !('height' in stream) || !('pix_fmt' in stream) || typeof stream.pix_fmt !== 'string') throw new FrameMatchError('invalid_image');
  const { width, height } = stream;
  if (typeof width !== 'number' || typeof height !== 'number' || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw new FrameMatchError('invalid_image');
  if (width * height > MATCH_LIMITS.imagePixels || Math.max(width, height) > 8192) throw new FrameMatchError('limit_exceeded');
  const side = MATCH_LIMITS.rasterSide;
  // Composite alpha-bearing formats before shrinking, so invisible RGB cannot bleed
  // into visible pixels. Preserve the established opaque decode path exactly.
  const alpha = /^(?:rgba|bgra|argb|abgr|yuva|gbrap|ya|pal8)/.test(stream.pix_fmt);
  const filter = `${alpha ? 'format=rgba,premultiply=inplace=1,' : ''}scale=${side}:${side}:flags=area`;
  const pixels = await execute('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-threads', '1', '-noautorotate', ...inputArgs, '-an', '-sn', '-dn', '-vf', filter, '-frames:v', '1', '-threads', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], snapshot, side * side * 3, signal);
  if (pixels.length !== side * side * 3) throw new FrameMatchError('decode_failed');
  return { mimeType, width, height, pixels };
}
