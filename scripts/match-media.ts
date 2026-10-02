/** Local only: npm run media:match -- --rights-cleared video a.mp4 image b.png new-directory */
import { constants } from 'node:fs';
import { mkdir, open, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareMatchMedia } from '../src/lib/video/matching/prepare';
import { comparePreparedMedia } from '../src/lib/video/matching/compare';
import { MATCH_LIMITS, type PreparedMatchMedia } from '../src/lib/video/matching/model';
import { VIDEO_LIMITS } from '../src/lib/video/ingest';

async function readInput(path: string, limit: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('Input must be a bounded regular file');
    const buffer = Buffer.alloc(limit + 1);
    let count = 0;
    for (;;) {
      const read = await handle.read(buffer, count, buffer.length - count);
      count += read.bytesRead;
      if (count > limit) throw new Error('Input exceeds byte limit');
      if (!read.bytesRead) return buffer.subarray(0, count);
    }
  } finally { await handle.close(); }
}
async function retainFrames(media: PreparedMatchMedia, prefix: string, directory: string) {
  const result = [];
  for (const [index, frame] of media.frames.entries()) {
    const extension = frame.mimeType === 'image/jpeg' ? 'jpg' : frame.mimeType === 'image/png' ? 'png' : 'webp';
    const file = `${prefix}-${index + 1}.${extension}`;
    await writeFile(join(directory, file), frame.bytes, { flag: 'wx', mode: 0o600 });
    const { bytes: _bytes, pixels: _pixels, ...metadata } = frame;
    result.push({ ...metadata, file });
  }
  return result;
}
async function main(): Promise<void> {
  const args = process.argv.slice(2).filter(arg => arg !== '--');
  const [rights, leftKind, leftPath, rightKind, rightPath, output] = args;
  if (args.length !== 6 || rights !== '--rights-cleared' || !['image', 'video'].includes(leftKind) || !['image', 'video'].includes(rightKind)) throw new Error('Usage: npm run media:match -- --rights-cleared <video|image> left-file <video|image> right-file new-directory');
  // Narrow at the command boundary, before filesystem or decoder work.
  if ((leftKind !== 'video' && leftKind !== 'image') || (rightKind !== 'video' && rightKind !== 'image')) return;
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    const left = await prepareMatchMedia({ kind: leftKind, bytes: await readInput(leftPath, leftKind === 'video' ? VIDEO_LIMITS.bytes : MATCH_LIMITS.imageBytes), rights: 'user_provided' }, { signal: controller.signal });
    const right = await prepareMatchMedia({ kind: rightKind, bytes: await readInput(rightPath, rightKind === 'video' ? VIDEO_LIMITS.bytes : MATCH_LIMITS.imageBytes), rights: 'user_provided' }, { signal: controller.signal });
    if (controller.signal.aborted) throw new Error('cancelled');
    const report = comparePreparedMedia(left, right);
    await mkdir(output, { mode: 0o700 });
    try {
      const files = { left: await retainFrames(left, 'left', output), right: await retainFrames(right, 'right', output) };
      await writeFile(join(output, 'report.json'), JSON.stringify({ ...report, files }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    } catch (error) { await rm(output, { recursive: true, force: true }); throw error; }
    process.stdout.write(`${report.candidates.length} candidate sampled-frame pairs of ${report.comparedFramePairs} compared. Inspect report.json and retained frames. No full-video or truth verdict.\n`);
  } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
}
void main().catch(error => {
  // Filesystem errors include input paths. Emit only fixed decoder codes or a safe general message.
  const message = error instanceof Error && !('path' in error) ? error.message : 'Local media comparison failed';
  process.stderr.write(`${message}\n`); process.exitCode = 1;
});
