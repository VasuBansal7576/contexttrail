#!/usr/bin/env node
// Local operator setup. Fixed official model, pinned revision/hash; no account or provider request.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const modelHash = '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b';
const source = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/90a64d80ea254cf67575b41a5971f972c79f7b45/ggml-small.bin';
async function digest(path) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); }
async function setup() {
  const root = resolve('.local-models'); await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await lstat(root); if (!directory.isDirectory() || directory.isSymbolicLink()) throw Error();
  const target = join(root, 'ggml-small.bin');
  let exists = false; try { const file = await lstat(target); if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1) throw Error(); exists = true; } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  if (exists) { if (await digest(target) !== modelHash) throw Error('Existing model does not match the pinned model. Preserve it for inspection before replacing it.'); }
  else {
    const temporary = join(root, `speech-${randomUUID()}.part`), file = await open(temporary, 'wx', 0o600); let committed = false;
    try {
      const response = await fetch(source, { signal: AbortSignal.timeout(15 * 60 * 1000) }); if (!response.ok || !response.body) throw Error();
      const reader = response.body.getReader(); let bytes = 0;
      try { for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > 600 * 1024 * 1024) throw Error(); await file.writeFile(next.value); } }
      finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      await file.sync(); await file.close();
      if (await digest(temporary) !== modelHash) throw Error(); await rename(temporary, target); committed = true;
    } finally { if (!committed) { await file.close().catch(() => {}); await rm(temporary, { force: true }); } }
  }
  const environment = resolve('.env.local'); let existing = '';
  try { const info = await lstat(environment); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw Error(); existing = await readFile(environment, 'utf8'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const content = existing.split(/\r?\n/).filter(line => line && !line.startsWith('CONTEXTTRAIL_WHISPER_MODEL=')).join('\n') + `\nCONTEXTTRAIL_WHISPER_MODEL=${JSON.stringify(target)}\n`;
  const staged = resolve(`.env.speech-${randomUUID()}.local`), file = await open(staged, 'wx', 0o600);
  try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
  await rename(staged, environment);
  console.log('Verified multilingual speech model configured locally. Restart the app to use it. No account, provider or billing settings were changed.');
}
setup().catch(error => { console.error(error?.message?.startsWith('Existing model') ? error.message : 'Speech setup did not complete. Existing account configuration is preserved; no provider requests were made.'); process.exitCode = 1; });
