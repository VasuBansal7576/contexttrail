#!/usr/bin/env node
/** Real production-server HTTP/disk roundtrip. Synthetic inputs only; no provider environment. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const checkout = fileURLToPath(new URL('..', import.meta.url));
const artifacts = resolve(checkout, '.verify', `research-http-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const data = resolve(artifacts, 'data');
await mkdir(data, { recursive: true });
const sourceFiles = ['src/lib/research/workflow.ts', 'src/lib/research/service.ts', 'src/app/api/research/route.ts', 'scripts/verify-research-http.mjs', 'src/lib/inquiries/materials.ts', 'src/lib/inquiries/model.ts', 'src/lib/inquiries/parse.ts', 'src/lib/inquiries/workspace.ts', 'scripts/fixtures/precise-anchors/synthetic.json', 'package-lock.json'];
const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async path => [path, createHash('sha256').update(await readFile(resolve(checkout, path))).digest('hex')])));
const assertions = [];
const check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); assertions.push({ name, passed: true }); };
let server;
let output = '';
let base;
async function launch(enabled) {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('No local test port');
  const port = address.port;
  await new Promise(resolve => probe.close(resolve));
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [resolve(checkout, 'node_modules/next/dist/bin/next'), 'start', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: checkout,
    env: { PATH: process.env.PATH, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', CONTEXTTRAIL_RESEARCH_LOCAL: enabled ? '1' : '0', CONTEXTTRAIL_RESEARCH_DATA_DIR: data },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', chunk => { output += chunk; });
  server.stderr.on('data', chunk => { output += chunk; });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Server exited ${server.exitCode}`);
    try { if ((await fetch(`${base}/api/research`)).status === (enabled ? 200 : 503)) return; } catch { /* Startup only. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Local server startup timed out');
}
async function stop() {
  const owned = server;
  if (!owned || owned.exitCode !== null) return;
  const exited = new Promise(resolve => owned.once('exit', resolve));
  owned.kill('SIGTERM');
  const timer = setTimeout(() => owned.kill('SIGKILL'), 5000);
  await exited;
  clearTimeout(timer);
  server = undefined;
}
async function post(input, status = 200, headers = {}) {
  const response = await fetch(`${base}/api/research`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(input) });
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return body;
}
const provenance = { method: 'manual', toolVersion: null, capturedAt: '2026-10-01T00:00:00.000Z', retrievedAt: null, rights: 'user_provided', retention: 'reference_only', contentHash: null };
const evidence = (id, text = 'The bridge opened on Monday. Inspection is pending.') => ({ id, sourceUrl: `https://synthetic.example/${id}`, title: `Synthetic ${id}`, content: { kind: 'text', text, attribution: 'page_quote' }, publicationDate: { status: 'unknown', reason: 'No publication date supplied' }, provenance });
let completed = false;
try {
  await launch(false);
  check('service disabled by default contract', (await post({ kind: 'start' }, 503)).code, 'LOCAL_SERVICE_DISABLED');
  check('disabled request writes no files', await readdir(data), []);
  await stop();
  await launch(true);
  const start = { kind: 'start', operationId: 'http-create', question: 'When did the bridge open, and what remains uncertain?', createdAt: '2026-10-01T00:00:00.000Z' };
  const discarded = await fetch(`${base}/api/research`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(start) });
  await discarded.body.cancel();
  let report = await post(start);
  const id = report.document.workspace.inquiry.caseId, questionId = report.document.workspace.inquiry.id;
  check('lost-response creation retry has one revision', report.document.revision, 1);
  check('question is not an assertion', report.document.workspace.collection.cases[0].claims, []);
  const get = async () => (await fetch(`${base}/api/research?caseId=${encodeURIComponent(id)}`)).json();
  const update = async (change, operationId = `http-op-${report.document.revision}`) => {
    const request = { kind: 'update', caseId: id, operationId, expectedRevision: report.document.revision, change };
    report = await post(request);
    return request;
  };
  await update({ kind: 'subquestion', value: { kind: 'subquestion', id: 'q2', question: 'Was inspection complete?' } });
  await update({ kind: 'hypothesis', value: { kind: 'hypothesis', id: 'h1', questionId: 'q2', explanation: 'Opening and inspection may be separate milestones.' } });
  await update({ kind: 'evidence', value: evidence('a'), assets: [] });
  await update({ kind: 'evidence', value: evidence('b'), assets: [] });
  const finding = { kind: 'finding', id: 'f1', questionId, text: 'The supplied excerpt says Monday.', assessment: { kind: 'source_statement', reviewer: 'Synthetic reviewer', rationale: 'Exact source wording, with no independent event-date verification.' }, support: [{ evidenceId: 'a', relationship: 'context', anchor: { kind: 'text', start: 0, quote: 'The bridge opened on Monday.' } }] };
  const exactRequest = await update({ kind: 'finding', value: finding });
  check('exact quote bound to retained source', report.findings[0].support[0].status, 'current');
  const afterFinding = report.document.revision;
  report = await post(exactRequest);
  check('repeated finding does not duplicate revision', report.document.revision, afterFinding);
  check('repeated finding does not duplicate entity', report.findings.length, 1);
  const beforeInvalid = JSON.stringify(report.document);
  await post({ ...exactRequest, operationId: 'bad-quote', expectedRevision: afterFinding, change: { kind: 'finding', value: { ...finding, id: 'bad', support: [{ evidenceId: 'a', relationship: 'context', anchor: { kind: 'text', start: 1, quote: 'The bridge opened on Monday.' } }] } } }, 400);
  check('invalid exact anchor preserves saved document', JSON.stringify((await get()).document), beforeInvalid);
  for (const fromEvidenceId of ['a', 'b']) await update({ kind: 'citation', value: { id: `c-${fromEvidenceId}`, fromEvidenceId, targetUrl: 'https://synthetic.example/a', targetRole: 'primary', claimId: null, quote: { text: 'The bridge opened on Monday.', start: 0 } } });
  check('shared supplied citation target exposed', report.dependencies.sharedCitations.length, 1);
  check('identical retained passages exposed', report.dependencies.duplicatePassages.length, 1);
  check('independence remains unknown', report.dependencies.independence.status, 'unknown');
  check('quote occurrence is not entailment', report.dependencies.citationChecks.map(c => c.entailment.status), ['unknown', 'unknown']);
  const asset = { id: 'clip', kind: 'video', location: { kind: 'not_retained' }, durationMs: 5000, provenance };
  await update({ kind: 'evidence', value: { ...evidence('clip-evidence'), content: { kind: 'media', assetId: 'clip', span: { kind: 'time', startMs: 1000, durationMs: 2000 } } }, assets: [asset] });
  const timed = { ...finding, id: 'timed-finding', text: 'Reviewer supplied an observation for this segment.', assessment: { ...finding.assessment, kind: 'operator_inference', rationale: 'Manually supplied timed observation. No media decoding or model analysis ran.' }, support: [{ evidenceId: 'clip-evidence', relationship: 'context', anchor: { kind: 'time', startMs: 1250, durationMs: 500 } }] };
  await update({ kind: 'finding', value: timed });
  check('timed anchor keeps exact milliseconds', report.findings.find(f => f.finding.id === 'timed-finding').support[0].anchor, timed.support[0].anchor);
  await post({ kind: 'update', caseId: id, expectedRevision: report.document.revision, operationId: 'invalid-time', change: { kind: 'finding', value: { ...timed, id: 'bad-time', support: [{ ...timed.support[0], anchor: { kind: 'time', startMs: 0, durationMs: 500 } }] } } }, 400);
  check('out-of-span timed anchor rejected', (await get()).document.revision, report.document.revision);
  const correction = await update({ kind: 'evidence', value: evidence('a', 'Correction: the bridge opened on Tuesday. The earlier Monday wording was withdrawn.'), assets: [] });
  check('correction invalidates old support', report.findings.find(f => f.finding.id === 'f1').reviewStatus, 'needs_review');
  check('correction retains original quote anchor', report.findings.find(f => f.finding.id === 'f1').support[0].anchor, finding.support[0].anchor);
  check('correction recomputes supplied citation quote result', report.dependencies.citationChecks[0].quoteChecks[0].result, 'offset_mismatch');
  check('correction retains prior evidence history', report.document.workspace.collection.caseHistory.some(record => record.evidence.some(e => e.content.kind === 'text' && e.content.text.startsWith('The bridge opened on Monday.'))), true);
  await post(correction);
  await update({ kind: 'finding', value: finding });
  check('identical finding resubmission does not clear warning', report.findings.find(f => f.finding.id === 'f1').reviewStatus, 'needs_review');
  // Rights-cleared PNG/table fixtures through the same production HTTP/save path.
  const anchors = JSON.parse(await readFile(resolve(checkout, 'scripts/fixtures/precise-anchors/synthetic.json'), 'utf8'));
  const imageEvidence = { ...evidence('image-e'), content: { kind: 'media', assetId: 'image-a', span: { kind: 'whole' } } };
  const imageAsset = { id: 'image-a', kind: 'image', location: { kind: 'not_retained' }, provenance };
  const tableEvidence = { ...evidence('table-e'), content: { kind: 'reference' } };
  await update({ kind: 'evidence', value: imageEvidence, assets: [imageAsset] });
  await update({ kind: 'evidence', value: tableEvidence, assets: [] });
  const sourceBinding = evidenceId => report.anchorSources.find(e => e.evidenceId === evidenceId).evidenceDigest;
  const materialEdit = (id, revision, content) => ({ kind: 'material', value: { kind: 'retain', material: { materialId: id, revision, evidenceId: `${id}-e`, evidenceDigest: sourceBinding(`${id}-e`), capturedAt: '2026-10-01T00:00:00Z', rights: 'user_provided', content } } });
  const pngContent = base64 => ({ kind: 'image', mimeType: 'image/png', base64 });
  const originalCase = JSON.stringify(report.document.workspace.collection.cases);
  const retainImage = await update(materialEdit('image', 1, pngContent(anchors.image.base64)));
  check('material intake upgrades the inquiry and research envelopes', [report.document.schemaVersion, report.document.workspace.schemaVersion], ['contexttrail-research-v2', 'contexttrail-inquiry-v2']);
  check('material intake preserves CaseRecord v1 exactly', JSON.stringify(report.document.workspace.collection.cases), originalCase);
  check('PNG dimensions come from decoded bytes', [report.document.workspace.materials.versions[0].content.width, report.document.workspace.materials.versions[0].content.height], [8, 6]);
  await post(retainImage);
  check('material operation replay keeps one retained version', (await get()).document.workspace.materials.versions.length, 1);
  await update(materialEdit('table', 1, anchors.table));
  const materialDigest = id => report.document.workspace.materials.heads.find(h => h.materialId === id).digest;
  const region = { kind: 'image_region', materialId: 'image', materialDigest: materialDigest('image'), x: 2, y: 1, width: 6, height: 5 };
  const cell = { kind: 'table_cell', materialId: 'table', materialDigest: materialDigest('table'), row: 1, column: 1, value: '18' };
  const selectedFinding = (id, anchor) => ({ ...finding, id: `${id}-finding`, text: 'A reviewer selected this retained material.', assessment: { ...finding.assessment, kind: 'operator_inference', rationale: 'Supplied selection; truth, image authenticity and table accuracy remain unverified.' }, support: [{ evidenceId: `${id}-e`, relationship: 'context', anchor }] });
  const regionFinding = selectedFinding('image', region), cellFinding = selectedFinding('table', cell);
  await update({ kind: 'finding', value: regionFinding });
  await update({ kind: 'finding', value: cellFinding });
  const anchorView = id => report.findings.find(f => f.finding.id === `${id}-finding`);
  check('PNG region and exact table cell are current', ['image', 'table'].map(id => anchorView(id).support[0].status), ['current', 'current']);
  const retainedMaterial = id => report.document.workspace.materials.versions.find(m => m.digest === anchorView(id).support[0].retainedMaterial.digest);
  check('cell review resolves complete table context', retainedMaterial('table').content, anchors.table);
  check('image payload appears once in the review response', JSON.stringify(report).split(anchors.image.base64).length, 2);
  await stop();
  await launch(true);
  check('v2 current anchors survive actual server restart', await get(), report);
  const invalidAnchors = [
    selectedFinding('image', { ...region, width: 7 }),
    selectedFinding('image', { ...region, x: 1.5 }),
    selectedFinding('table', { ...cell, row: 99 }),
    selectedFinding('table', { ...cell, value: '18 ' }),
  ];
  for (const [i, invalid] of invalidAnchors.entries()) {
    await post({ kind: 'update', caseId: id, operationId: `bad-retained-anchor-${i}`, expectedRevision: report.document.revision, change: { kind: 'finding', value: { ...invalid, id: `invalid-${i}` } } }, 400);
  }
  check('invalid retained anchors leave persisted document untouched', (await get()).document, report.document);
  const oversizedHeader = Buffer.from(anchors.image.base64, 'base64'); oversizedHeader.writeUInt32BE(0x7fffffff, 16);
  await post({ kind: 'update', caseId: id, operationId: 'oversized-png', expectedRevision: report.document.revision, change: materialEdit('image', 2, pngContent(oversizedHeader.toString('base64'))) }, 400);
  check('oversized PNG header rejected without write', (await get()).document, report.document);
  await update(materialEdit('image', 2, pngContent(anchors.replacement.base64)));
  check('same-size pixel replacement stales region finding', anchorView('image').support[0].status, 'changed');
  check('stale region retains its original bytes', retainedMaterial('image').content.base64, anchors.image.base64);
  await update({ kind: 'finding', value: regionFinding });
  check('identical region resubmission cannot clear review', anchorView('image').reviewStatus, 'needs_review');
  const oldTableSource = sourceBinding('table-e');
  await update({ kind: 'evidence', value: { ...tableEvidence, title: 'Corrected synthetic source' }, assets: [] });
  check('source correction stales a cell even when its value is unchanged', anchorView('table').support[0].status, 'changed');
  const oldMaterial = materialEdit('table', 2, anchors.table); oldMaterial.value.material.evidenceDigest = oldTableSource;
  await post({ kind: 'update', caseId: id, operationId: 'old-material-source', expectedRevision: report.document.revision, change: oldMaterial }, 400);
  check('cannot attach new material to changed source digest', (await get()).document, report.document);
  await update(materialEdit('table', 2, { ...anchors.table, rows: [['2025', '12'], ['2026', '19'], ['', '=1+1']] }));
  check('table replacement preserves the original exact cell', anchorView('table').support[0].anchor.value, '18');
  await update({ kind: 'material', value: { kind: 'withdraw', materialId: 'image', reason: 'Synthetic reviewer withdrawal' } });
  check('withdrawal reports missing material with a reason', [anchorView('image').support[0].status, anchorView('image').support[0].reason], ['unavailable', 'Synthetic reviewer withdrawal']);
  check('withdrawal keeps historical bytes available for review', retainedMaterial('image').content.base64, anchors.image.base64);
  const stale = await post({ kind: 'update', caseId: id, operationId: 'stale', expectedRevision: 1, change: { kind: 'subquestion', value: { kind: 'subquestion', id: 'stale-q', question: 'Old writer?' } } }, 409);
  check('stale request gets explicit conflict', stale.code, 'REVISION_CONFLICT');
  const concurrentBase = report.document.revision;
  const concurrent = await Promise.all(['one', 'two'].map(async suffix => {
    const response = await fetch(`${base}/api/research`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'update', caseId: id, operationId: `parallel-${suffix}`, expectedRevision: concurrentBase, change: { kind: 'subquestion', value: { kind: 'subquestion', id: `parallel-${suffix}`, question: `Parallel ${suffix}?` } } }) });
    return response.status;
  }));
  check('concurrent writers cannot both commit', concurrent.sort(), [200, 409]);
  report = await get();
  check('concurrent change commits once', report.document.revision, concurrentBase + 1);
  const persisted = JSON.parse(await readFile(resolve(data, `${createHash('sha256').update(id).digest('hex')}.json`), 'utf8'));
  check('actual disk record equals HTTP document', persisted, report.document);
  await writeFile(resolve(artifacts, 'before-restart.json'), JSON.stringify(report, null, 2));
  await stop();
  await launch(true);
  check('server restart reopens same evidence and dependency report', await get(), report);
  const index = await (await fetch(`${base}/api/research`)).json();
  check('case index recovers from disk', index.cases.map(c => [c.caseId, c.revision]), [[id, report.document.revision]]);
  const prefix = resolve(data, createHash('sha256').update(id).digest('hex'));
  await writeFile(`${prefix}.lock`, 'synthetic interrupted writer');
  const blocked = await post({ kind: 'update', caseId: id, operationId: 'after-interruption', expectedRevision: report.document.revision, change: materialEdit('image', 3, pngContent(anchors.image.base64)) }, 409);
  check('unexplained lock blocks writes', blocked.code, 'CASE_BUSY');
  check('interrupted writer leaves committed case readable', await get(), report);
  check('interrupted lock not silently deleted', await readFile(`${prefix}.lock`, 'utf8'), 'synthetic interrupted writer');
  await rm(`${prefix}.lock`); // This run owns the explicitly synthetic marker.
  await writeFile(`${prefix}.tmp`, 'synthetic interrupted temporary file');
  const recovery = await post({ kind: 'update', caseId: id, operationId: 'after-temp', expectedRevision: report.document.revision, change: materialEdit('image', 3, pngContent(anchors.image.base64)) }, 409);
  check('uncommitted temporary file requires inspection', recovery.code, 'RECOVERY_REQUIRED');
  check('temporary-save interruption preserves committed case', await get(), report);
  check('temporary bytes are preserved', await readFile(`${prefix}.tmp`, 'utf8'), 'synthetic interrupted temporary file');
  const crossOrigin = await post(start, 403, { origin: 'https://unrelated.example' });
  check('cross-origin write rejected', crossOrigin.code, 'ORIGIN_REJECTED');
  // Node24 fetch replaces a supplied Host header. Use real HTTP to prove this boundary.
  const nonlocal = await new Promise((resolve, reject) => {
    const bytes = JSON.stringify(start);
    const request = httpRequest(`${base}/api/research`, { method: 'POST', headers: { host: 'unrelated.example', 'content-type': 'application/json', 'content-length': Buffer.byteLength(bytes) } }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => { try { resolve({ status: response.statusCode, body: JSON.parse(body) }); } catch (error) { reject(error); } });
    });
    request.on('error', reject);
    request.end(bytes);
  });
  check('non-loopback HTTP host rejected', [nonlocal.status, nonlocal.body.code], [403, 'LOCAL_ONLY']);
  await writeFile(resolve(artifacts, 'after-restart.json'), JSON.stringify(await get(), null, 2));
  completed = true;
} finally {
  await stop();
  await writeFile(resolve(artifacts, 'server.log'), output);
  await writeFile(resolve(artifacts, 'report.json'), JSON.stringify({ completed, tier: 'real-local-http-and-disk', sourceHashes, buildId: (await readFile(resolve(checkout, '.next/BUILD_ID'), 'utf8')).trim(), providerEnvironment: 'omitted; no provider operation requested', limits: 'Synthetic supplied evidence. PNG-only bounded decoding and supplied table cells. No UI, retrieval, OCR, audio/video analysis, entailment or authenticity claim.', assertions }, null, 2));
  process.stdout.write(`${JSON.stringify({ completed, assertions: assertions.length, artifacts })}\n`);
}
