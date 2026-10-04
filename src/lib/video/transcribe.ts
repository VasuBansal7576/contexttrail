import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { transcriptFromWhisper, unavailableTranscript, type MediaTranscript } from './transcript';
const MODEL_SHA256 = '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b';
const formats = 'mov,matroska,webm,wav,mp3,flac,ogg';
async function command(binary: 'ffmpeg' | 'ffprobe' | 'whisper-cli', args: string[], signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((accept, reject) => {
    const child = spawn(binary, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let failure: Error | undefined, count = 0; const chunks: Buffer[] = [];
    const stop = (error: Error) => { failure ??= error; child.kill('SIGKILL'); };
    const abort = () => stop(new Error('Transcription cancelled'));
    const timer = setTimeout(() => stop(new Error('Transcription exceeded its limit')), binary === 'whisper-cli' ? 120_000 : 20_000);
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => { count += chunk.length; if (count > 256 * 1024) stop(new Error('Decoder output exceeded its limit')); else chunks.push(chunk); });
    let errors = 0; child.stderr.on('data', (chunk: Buffer) => { errors += chunk.length; if (errors > 256 * 1024) stop(new Error('Decoder diagnostics exceeded their limit')); });
    child.on('error', () => { failure ??= new Error('Local speech decoder unavailable'); });
    child.on('close', code => { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (signal?.aborted) reject(signal.reason); else if (failure || code !== 0) reject(failure ?? new Error('Local speech decoding failed')); else accept(Buffer.concat(chunks).toString('utf8')); });
  });
}
let verifiedModel: { path: string; modified: number; size: number } | undefined;
async function modelPath(): Promise<string | null> {
  const path = process.env.CONTEXTTRAIL_WHISPER_MODEL;
  if (!path || basename(path) !== 'ggml-small.bin') return null;
  const info = await stat(path); if (info.size > 600 * 1024 * 1024 || info.size < 400 * 1024 * 1024) return null;
  if (verifiedModel?.path === path && verifiedModel.modified === info.mtimeMs && verifiedModel.size === info.size) return path;
  const digest = createHash('sha256'); for await (const chunk of createReadStream(path)) digest.update(chunk);
  if (digest.digest('hex') !== MODEL_SHA256) return null;
  verifiedModel = { path, modified: info.mtimeMs, size: info.size }; return path;
}
/** Full bounded audio track, decoded locally; no upload, network request, supplied path or generated replacement text. */
export async function transcribeMedia(bytes: Uint8Array, signal?: AbortSignal): Promise<MediaTranscript> {
  signal?.throwIfAborted();
  if (!bytes.length || bytes.length > 32 * 1024 * 1024) throw new Error('Media exceeds its byte limit');
  const model = await modelPath().catch(() => null);
  if (!model) return unavailableTranscript('The verified local multilingual speech model is not configured. No transcription was invented.');
  const directory = await mkdtemp(join(tmpdir(), 'contexttrail-speech-'));
  try {
    const input = join(directory, 'input'), wav = join(directory, 'decoded.wav'), output = join(directory, 'transcript');
    await writeFile(input, Buffer.from(bytes), { mode: 0o600 });
    const restrictions = ['-max_alloc', '67108864', '-protocol_whitelist', 'file,pipe', '-format_whitelist', formats];
    const metadata: unknown = JSON.parse(await command('ffprobe', ['-v', 'error', ...restrictions, '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', input], signal));
    if (!metadata || typeof metadata !== 'object' || !('streams' in metadata) || !Array.isArray(metadata.streams) || !('format' in metadata) || !metadata.format || typeof metadata.format !== 'object' || !('duration' in metadata.format)) throw new Error('Invalid media');
    const durationMs = Number(metadata.format.duration) * 1000;
    if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 120_000) throw new Error('Audio duration exceeds its limit');
    if (!metadata.streams.some(stream => stream && typeof stream === 'object' && 'codec_type' in stream && stream.codec_type === 'audio')) return unavailableTranscript('The supplied media has no audio stream.', 'no_audio');
    await command('ffmpeg', ['-nostdin', '-v', 'error', '-threads', '1', ...restrictions, '-i', input, '-map', '0:a:0', '-vn', '-sn', '-dn', '-t', '120', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', wav], signal);
    if ((await stat(wav)).size > 4 * 1024 * 1024) throw new Error('Decoded audio exceeds its limit');
    await command('whisper-cli', ['-ng', '-m', model, '-f', wav, '-ojf', '-of', output, '-l', 'auto', '-t', '4', '-nf', '-np'], signal);
    const path = `${output}.json`; if ((await stat(path)).size > 2 * 1024 * 1024) throw new Error('Transcript exceeds its limit');
    return transcriptFromWhisper(JSON.parse(await readFile(path, 'utf8')), durationMs, `sha256:${MODEL_SHA256}`);
  } catch {
    signal?.throwIfAborted();
    return unavailableTranscript('Local speech recognition did not complete within its decoding limits. The audio remains unassessed.');
  } finally { await rm(directory, { recursive: true, force: true }); }
}
