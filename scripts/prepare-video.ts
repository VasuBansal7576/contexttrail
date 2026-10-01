/** Local-only CLI: npx --no-install vite-node scripts/prepare-video.ts -- input.mp4 new-output-directory */
import { constants } from 'node:fs';
import { mkdir, open, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareVideo, VIDEO_LIMITS } from '../src/lib/video/ingest';

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter(arg => arg !== '--');
  if (args.length !== 2) throw new Error('Usage: npx --no-install vite-node scripts/prepare-video.ts -- input.mp4 new-output-directory');
  const [input, output] = args;
  const handle = await open(input, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > VIDEO_LIMITS.bytes) throw new Error('Input must be a regular file of at most 32 MiB');
    // Fixed cap also covers a file that grows after stat.
    const buffer = Buffer.alloc(VIDEO_LIMITS.bytes + 1);
    let count = 0;
    for (;;) {
      const read = await handle.read(buffer, count, buffer.length - count);
      count += read.bytesRead;
      if (count > VIDEO_LIMITS.bytes) throw new Error('Input exceeds 32 MiB');
      if (read.bytesRead === 0) break;
    }
    bytes = buffer.subarray(0, count);
  } finally { await handle.close(); }
  const prepared = await prepareVideo(bytes);
  // Refuse existing output paths; never overwrite previous review evidence.
  await mkdir(output, { mode: 0o700 });
  try {
    const frames = [];
    for (const [index, frame] of prepared.frames.entries()) {
      const file = `frame-${index + 1}.jpg`;
      await writeFile(join(output, file), frame.bytes, { flag: 'wx', mode: 0o600 });
      const { bytes: _bytes, ...metadata } = frame;
      frames.push({ ...metadata, file });
    }
    const manifest = { ...prepared, frames, audioAnalyzed: false, transcriptAnalyzed: false, fullVideoVerdict: null };
    await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    process.stdout.write(`Prepared ${frames.length} sampled frames. No provider calls, audio analysis, or full-video verdict.\n`);
  } catch (error) { await rm(output, { recursive: true, force: true }); throw error; }
}
void main().catch(error => {
  // No raw FFmpeg diagnostic, secret URL, or full input path in failure output.
  process.stderr.write(error instanceof Error ? `${error.message}\n` : 'Video preparation failed\n');
  process.exitCode = 1;
});
