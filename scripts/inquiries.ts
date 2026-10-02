/** Local-only entry point. No source fetching, provider clients or environment secrets. */
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, fsyncSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { applyInquiry, findingViews } from '../src/lib/inquiries/workspace';
import { parseWorkspace } from '../src/lib/inquiries/parse';
import { object } from '../src/lib/watchlists/parse';

function readJson(path: string): unknown {
  const bytes = readFileSync(path);
  if (bytes.length > 20 * 1024 * 1024) throw new Error('Local JSON file exceeds 20 MiB');
  return JSON.parse(bytes.toString('utf8'));
}
function main() {
  const [stateArg, requestArg] = process.argv.slice(2);
  if (!stateArg || !requestArg || process.argv.length !== 4) throw new Error('Usage: npm run inquiries -- STATE.json REQUEST.json (or --show as request)');
  const state = resolve(stateArg);
  if (requestArg === '--show') { const saved = object(readJson(state)); const workspace = parseWorkspace(saved.workspace); process.stdout.write(`${JSON.stringify({ ...saved, workspace, findings: findingViews(workspace) }, null, 2)}\n`); return; }
  if (state === resolve(requestArg)) throw new Error('State and request must be different files');
  mkdirSync(dirname(state), { recursive: true });
  const lock = `${state}.lock`, temporary = `${state}.tmp`;
  const lockFd = openSync(lock, 'wx', 0o600);
  try {
    const workspace = existsSync(state) ? object(readJson(state)).workspace : null;
    const result = applyInquiry(workspace, readJson(requestArg));
    // State and its last report are one atomic replacement. --show recovers output after interruption.
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, `${JSON.stringify(result, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, state);
    process.stdout.write(`${JSON.stringify({ notices: result.notices, failures: result.failures, findings: result.findings, revision: result.workspace.revision, replayed: result.replayed }, null, 2)}\n`);
  } finally {
    closeSync(lockFd); unlinkSync(lock);
  }
}
try { main(); } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'Local update failed'}\n`); process.exitCode = 1; }
