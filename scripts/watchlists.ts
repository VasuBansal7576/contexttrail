/** Local-only entry point. No source fetching, provider clients or environment secrets. */
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, fsyncSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { applyUpdates, emptyCollection } from '../src/lib/watchlists/collection';
import { object } from '../src/lib/watchlists/parse';

function readJson(path: string): unknown {
  const bytes = readFileSync(path);
  if (bytes.length > 20 * 1024 * 1024) throw new Error('Local JSON file exceeds 20 MiB');
  return JSON.parse(bytes.toString('utf8'));
}
function main() {
  const [stateArg, requestArg] = process.argv.slice(2);
  if (!stateArg || !requestArg || process.argv.length !== 4) throw new Error('Usage: npm run watchlists -- STATE.json REQUEST.json (or --show as request)');
  const state = resolve(stateArg);
  if (requestArg === '--show') { process.stdout.write(`${JSON.stringify(readJson(state), null, 2)}\n`); return; }
  if (state === resolve(requestArg)) throw new Error('State and request must be different files');
  mkdirSync(dirname(state), { recursive: true });
  const lock = `${state}.lock`, temporary = `${state}.tmp`;
  const lockFd = openSync(lock, 'wx', 0o600);
  try {
    const collection = existsSync(state) ? object(readJson(state)).collection : emptyCollection();
    const result = applyUpdates(collection, readJson(requestArg));
    // State and its last report are one atomic replacement. --show recovers output after interruption.
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, `${JSON.stringify(result, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, state);
    process.stdout.write(`${JSON.stringify({ notices: result.notices, failures: result.failures, families: result.families, relationReviewRequired: result.collection.relationReviewRequired }, null, 2)}\n`);
  } finally {
    closeSync(lockFd); unlinkSync(lock);
  }
}
try { main(); } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'Local update failed'}\n`); process.exitCode = 1; }
