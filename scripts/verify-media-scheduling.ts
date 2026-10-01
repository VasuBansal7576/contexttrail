/** Replay retained evaluation bytes through both frozen and scheduled matching. No regenerated IDs. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { comparePreparedMedia } from '../src/lib/video/matching/compare';
import { comparePreparedMediaAsync } from '../src/lib/video/matching/schedule';
import { prepareMatchMedia } from '../src/lib/video/matching/prepare';
import type { PreparedMatchMedia } from '../src/lib/video/matching/model';

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected evaluation record');
  return Object.fromEntries(Object.entries(value));
}
function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error('Expected evaluation records');
  return value.map(record);
}
function name(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9-]+$/.test(value)) throw new Error('Invalid evaluation name');
  return value;
}
async function main() {
  const [directory, destination, ...extra] = process.argv.slice(2);
  if (!directory || !destination || extra.length) throw new Error('Usage: verify-media-scheduling retained-evaluation-directory output-json');
  assert.equal(hash(await readFile('src/lib/video/matching/compare.ts')), 'c755c5c891ee2c79feb99b272772a8e1160783367b942b79f8474f93757b2575');
  const manifest = record(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')));
  const prepared = new Map<string, PreparedMatchMedia>();
  const inputHashes: Record<string, string> = {}, frameHashes: Record<string, string> = {}, rasterHashes: Record<string, string> = {}, reportHashes: Record<string, string> = {};
  for (const asset of rows(manifest.assets)) {
    const id = name(asset.id), kind = asset.kind;
    if (kind !== 'image' && kind !== 'video') throw new Error('Invalid input kind');
    if (typeof asset.file !== 'string' || !/^media\/[a-z0-9.-]+$/.test(asset.file)) throw new Error('Invalid retained input filename');
    const bytes = await readFile(join(directory, asset.file));
    assert.equal(hash(bytes), asset.sha256, `Original input bytes changed: ${id}`);
    inputHashes[id] = hash(bytes);
    const media = await prepareMatchMedia({ kind, bytes, rights: 'user_provided' });
    for (const [index, frame] of media.frames.entries()) {
      const extension = frame.mimeType === 'image/jpeg' ? 'jpg' : frame.mimeType === 'image/webp' ? 'webp' : 'png';
      const key = `${id}-${index}`;
      assert.equal(hash(frame.bytes), hash(await readFile(join(directory, 'frames', `${key}.${extension}`))), `Retained frame bytes changed: ${key}`);
      frameHashes[key] = hash(frame.bytes); rasterHashes[key] = hash(frame.pixels);
    }
    prepared.set(id, media);
  }
  let pairCount = 0;
  for (const item of rows(manifest.cases)) {
    const id = name(item.id), left = prepared.get(name(item.left)), right = prepared.get(name(item.right));
    if (!left || !right) throw new Error('Missing retained evaluation input');
    const original = await readFile(join(directory, 'reports', `${id}.json`), 'utf8');
    const frozen = comparePreparedMedia(left, right), scheduled = await comparePreparedMediaAsync(left, right, new AbortController().signal);
    assert.deepEqual(frozen, JSON.parse(original), `Complete frozen report changed: ${id}`);
    assert.deepEqual(scheduled, frozen, `Complete scheduled report changed: ${id}`);
    assert.equal(hash(`${JSON.stringify(scheduled, null, 2)}\n`), hash(original), `Serialized report hash changed: ${id}`);
    reportHashes[id] = hash(original); pairCount += frozen.comparedFramePairs;
  }
  const result = { completed: true, frozenMatcherSha256: 'c755c5c891ee2c79feb99b272772a8e1160783367b942b79f8474f93757b2575', inputs: prepared.size, frames: Object.keys(frameHashes).length, cases: Object.keys(reportHashes).length, pairs: pairCount, inputHashes, frameHashes, rasterHashes, reportHashes, interpretation: 'Exact retained input and frame hashes, complete frozen and scheduled reports, and serialized report hashes agree. No new accuracy claim.' };
  await writeFile(destination, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ completed: true, inputs: result.inputs, frames: result.frames, cases: result.cases, pairs: result.pairs, destination })}\n`);
}
void main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'Verification failed'}\n`); process.exitCode = 1; });
