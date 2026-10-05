import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { ProviderError } from '../providers/http';

/** No PDF JavaScript, forms, media, remote resources, OCR or capture-date inference. */
export async function pdfSourceHtml(bytes: Uint8Array, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') throw new ProviderError('malformed', 'Source PDF signature rejected');
  const worker = new Worker(resolve('scripts/pdf-source-worker.mjs'), { workerData: bytes, resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 }, stdout: true, stderr: true });
  worker.stdout.resume(); worker.stderr.resume();
  try {
    const text = await new Promise<string>((accept, reject) => {
      let settled = false;
      const cleanup = () => { clearTimeout(deadline); signal.removeEventListener('abort', aborted); };
      const fail = () => { if (settled) return; settled = true; cleanup(); reject(new ProviderError('malformed', 'Source PDF could not be read within its limits')); };
      const aborted = () => { if (settled) return; settled = true; cleanup(); reject(signal.reason); };
      const deadline = setTimeout(fail, 4_000);
      signal.addEventListener('abort', aborted, { once: true });
      worker.once('message', (value: unknown) => {
        if (settled) return;
        if (typeof value !== 'string' || !value.trim() || value.length > 64_000) { fail(); return; }
        settled = true; cleanup(); accept(value);
      });
      worker.once('error', fail); worker.once('exit', () => { if (!settled) fail(); });
      if (signal.aborted) aborted();
    });
    const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const groups = text.split('\n').reduce<string[]>((groups, line) => {
      const last = groups.length - 1;
      if (last >= 0 && groups[last].length + line.length < 1600) groups[last] += ` ${line}`;
      else groups.push(line);
      return groups;
    }, []);
    return `<html><body><article>${groups.map(paragraph => `<p>${escape(paragraph)}</p>`).join('')}</article></body></html>`;
  } finally { await worker.terminate(); }
}
