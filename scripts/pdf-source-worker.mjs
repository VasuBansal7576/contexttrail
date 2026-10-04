// Text-only PDF inspection in an isolated, memory-bounded Node worker.
import { parentPort, workerData } from 'node:worker_threads';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
const task = getDocument({ data: new Uint8Array(workerData), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, useWorkerFetch: false, stopAtErrors: true, verbosity: 0 });
try {
  const document = await task.promise, paragraphs = [];
  let characters = 0;
  for (let pageIndex = 1; pageIndex <= Math.min(12, document.numPages); pageIndex++) {
    const page = await document.getPage(pageIndex), text = await page.getTextContent();
    let line = '';
    for (const item of text.items) {
      if (!('str' in item)) continue;
      line += `${item.str} `;
      if (item.hasEOL) { const retained = line.trim(); if (retained) { paragraphs.push(retained); characters += retained.length; } line = ''; }
      if (characters + line.length > 64_000) break;
    }
    if (line.trim()) { paragraphs.push(line.trim()); characters += line.trim().length; }
    page.cleanup();
    if (characters >= 64_000) break;
  }
  parentPort?.postMessage(paragraphs.join('\n').slice(0, 64_000));
} catch { parentPort?.postMessage(null); }
finally { await task.destroy(); }
