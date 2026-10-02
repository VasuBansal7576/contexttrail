import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fixture from '../../../scripts/fixtures/precise-anchors/synthetic.json';
import type { CaseEvidence, MediaAsset, Provenance } from '../cases/model';
import type { ExactAnchor, Finding } from '../inquiries/model';
import type { MaterialInput } from '../inquiries/materials';
import { inquiryCase, researchWorkflow, type ResearchChange, type ResearchReview } from './workflow';
import { getResearchCase, listResearchCases, parseResearchCaseList, parseResearchCaseView, ResearchClientError, startResearchCase, updateResearchCase } from './client';

const createdAt = '2026-10-01T00:00:00Z';
const start = { operationId: 'browser-case', question: 'What does the supplied material show?', createdAt };
const provenance: Provenance = { method: 'user_submission', toolVersion: null, capturedAt: createdAt, retrievedAt: null, rights: 'user_provided', retention: 'reference_only', contentHash: null };
function evidence(id: string, content: CaseEvidence['content'] = { kind: 'text', text: 'Retained exact passage.', attribution: 'page_quote' }): CaseEvidence {
  return { id, title: null, sourceUrl: `https://synthetic.example/${id}`, content, publicationDate: { status: 'unknown', reason: 'Date not supplied' }, provenance };
}
function setup() {
  let report = researchWorkflow({ kind: 'start', ...start });
  const questionId = report.document.workspace.inquiry.id;
  function update(change: ResearchChange) {
    report = researchWorkflow({ kind: 'update', operationId: `operation-${report.document.revision}`, expectedRevision: report.document.revision, document: report.document, change });
    return report;
  }
  function finding(id: string, anchor: ExactAnchor): Finding {
    return { kind: 'finding', id: `finding-${id}`, questionId, text: 'The reviewer recorded this selection.', assessment: { kind: 'operator_inference', reviewer: 'Fixture reviewer', rationale: 'Context and authenticity have not been independently verified.' }, support: [{ evidenceId: id, relationship: 'context', anchor }] };
  }
  function material(id: 'image' | 'table', revision = 1, content?: MaterialInput['content']): MaterialInput {
    const source = report.anchorSources.find(s => s.evidenceId === id);
    if (!source) throw new Error('Missing fixture source');
    return { materialId: id, revision, evidenceId: id, evidenceDigest: source.evidenceDigest, capturedAt: createdAt, rights: 'user_provided', content: content ?? (id === 'image' ? { kind: 'image', mimeType: 'image/png', base64: fixture.image.base64 } : { kind: 'table', columns: ['Label', 'Value'], rows: [['Original', '18'], ['', '']] }) };
  }
  function anchor(id: 'image' | 'table'): ExactAnchor {
    const workspace = report.document.workspace;
    if (workspace.schemaVersion !== 'contexttrail-inquiry-v2') throw new Error('Missing materials');
    const head = workspace.materials.heads.find(h => h.materialId === id);
    if (!head || head.status !== 'available') throw new Error('Missing material head');
    return id === 'image' ? { kind: 'image_region', materialId: id, materialDigest: head.digest, x: 2, y: 1, width: 6, height: 5 } : { kind: 'table_cell', materialId: id, materialDigest: head.digest, row: 1, column: 1, value: '' };
  }
  return { update, finding, material, anchor, current: () => report };
}
function wire(report: ResearchReview): unknown { return JSON.parse(JSON.stringify(report)); }
afterEach(() => { vi.unstubAllGlobals(); });

describe('browser research response boundary', () => {
  it('reads a real empty v1 response and detaches the browser view from the wire data', () => {
    const t = setup(), report = t.current(), view = parseResearchCaseView(report);
    expect(view).toMatchObject({ caseId: 'case:browser-case', questionId: 'question:browser-case', question: start.question, revision: 1, workspaceRevision: 1, createdAt, materials: { versions: [], heads: [] }, findingViews: [], caseHistory: [] });
    expect(view.caseRecord).toEqual(inquiryCase(report.document.workspace));
    view.caseRecord.coverage.limitations.push('UI-only change');
    expect(inquiryCase(report.document.workspace).coverage.limitations).not.toContain('UI-only change');
  });

  it('preserves questions, exact text/time anchors, source limitations, citations and correction history', () => {
    const t = setup();
    t.update({ kind: 'subquestion', value: { kind: 'subquestion', id: 'q2', question: 'Which passage was supplied?' } });
    t.update({ kind: 'hypothesis', value: { kind: 'hypothesis', id: 'h1', questionId: 'q2', explanation: 'The sources may share a passage.' } });
    t.update({ kind: 'evidence', value: evidence('a'), assets: [] });
    t.update({ kind: 'evidence', value: evidence('b'), assets: [] });
    t.update({ kind: 'finding', value: t.finding('a', { kind: 'text', start: 0, quote: 'Retained exact passage.' }) });
    const clip: MediaAsset = { id: 'clip', kind: 'video', durationMs: 2000, location: { kind: 'url', url: 'https://synthetic.example/clip.mp4' }, provenance };
    t.update({ kind: 'evidence', value: evidence('clip', { kind: 'media', assetId: 'clip', span: { kind: 'whole' } }), assets: [clip] });
    t.update({ kind: 'finding', value: t.finding('clip', { kind: 'time', startMs: 200, durationMs: 400 }) });
    for (const id of ['a', 'b']) t.update({ kind: 'citation', value: { id: `citation-${id}`, fromEvidenceId: id, targetUrl: 'https://synthetic.example/a', targetRole: 'primary', claimId: null, quote: { text: 'Retained exact passage.', start: 0 } } });
    const before = parseResearchCaseView(wire(t.current()));
    expect(before.caseRecord.evidence[0].title).toBeNull();
    expect(before.findingViews[0].support[0]).toMatchObject({ status: 'current', reason: null, retainedMaterial: null, currentMaterial: null, anchor: { kind: 'text', start: 0, quote: 'Retained exact passage.' } });
    expect(before.findingViews[1].support[0].anchor).toEqual({ kind: 'time', startMs: 200, durationMs: 400 });
    expect(before.dependencies.sharedCitations).toHaveLength(1);
    expect(before.dependencies.duplicatePassages).toHaveLength(1);
    expect(before.dependencies.citationChecks[0].quoteChecks[0]).toMatchObject({ result: 'exact_match', matchedStart: 0, attribution: 'page_quote' });
    expect(before.dependencies.independence.status).toBe('unknown');
    expect(before.dependencies.limits.length).toBeGreaterThan(0);
    t.update({ kind: 'evidence', value: evidence('a', { kind: 'text', text: 'Corrected passage.', attribution: 'search_snippet' }), assets: [] });
    const after = parseResearchCaseView(wire(t.current()));
    expect(after.findingViews[0].support[0].status).toBe('changed');
    expect(after.findingViews[0].support[0].anchor).toEqual(before.findingViews[0].support[0].anchor);
    expect(after.dependencies.citationChecks[0].quoteChecks[0].result).toBe('offset_mismatch');
    expect(after.caseHistory.some(c => c.evidence.some(e => e.content.kind === 'text' && e.content.text === 'Retained exact passage.'))).toBe(true);
    expect(after.history.some(h => h.subquestions.some(q => q.id === 'q2'))).toBe(true);
    expect(after.changes).toHaveLength(after.revision);
  });

  it('preserves image/table versions, exact empty cells, changed digests and withdrawals from v2', () => {
    const t = setup();
    const image: MediaAsset = { id: 'image-asset', kind: 'image', location: { kind: 'not_retained' }, provenance };
    t.update({ kind: 'evidence', value: evidence('image', { kind: 'media', assetId: image.id, span: { kind: 'whole' } }), assets: [image] });
    t.update({ kind: 'evidence', value: evidence('table', { kind: 'reference' }), assets: [] });
    for (const id of ['image', 'table'] as const) {
      t.update({ kind: 'material', value: { kind: 'retain', material: t.material(id) } });
      t.update({ kind: 'finding', value: t.finding(id, t.anchor(id)) });
    }
    const before = parseResearchCaseView(wire(t.current()));
    expect(before.materials.versions).toHaveLength(2);
    expect(before.findingViews[0].support[0]).toMatchObject({ status: 'current', retainedMaterial: { revision: 1, content: { kind: 'image', width: 8, height: 6 } } });
    expect(before.findingViews[1].support[0].anchor).toMatchObject({ kind: 'table_cell', value: '' });
    t.update({ kind: 'material', value: { kind: 'retain', material: t.material('image', 2, { kind: 'image', mimeType: 'image/png', base64: fixture.replacement.base64 }) } });
    t.update({ kind: 'material', value: { kind: 'withdraw', materialId: 'table', reason: 'Reviewer withdrew the supplied table' } });
    const after = parseResearchCaseView(wire(t.current()));
    expect(after.findingViews[0]).toMatchObject({ reviewStatus: 'needs_review', support: [{ status: 'changed', retainedMaterial: { revision: 1 }, currentMaterial: { revision: 2 } }] });
    expect(after.findingViews[0].support[0].retainedMaterial?.digest).not.toBe(after.findingViews[0].support[0].currentMaterial?.digest);
    expect(after.findingViews[1].support[0]).toMatchObject({ status: 'unavailable', reason: 'Reviewer withdrew the supplied table', currentMaterial: null });
    expect(after.materials.versions).toHaveLength(3);
    expect(after.materials.heads.find(h => h.materialId === 'table')?.status).toBe('unavailable');
  });

  it('rejects incompatible, malformed and identity-mismatched response envelopes', () => {
    const report = setup().current();
    const invalid = [null, [], {}, { ...report, document: { ...report.document, schemaVersion: 'future' } },
      { ...report, document: { ...report.document, revision: 1.5 } },
      { ...report, document: { ...report.document, workspace: { ...report.document.workspace, schemaVersion: 'contexttrail-inquiry-v2' } } },
      { ...report, dependencies: { ...report.dependencies, caseId: 'another-case' } },
      { ...report, anchorSources: [{ evidenceId: 'unknown', evidenceDigest: `sha256:${'0'.repeat(64)}` }] },
      { ...report, document: { ...report.document, workspace: { ...report.document.workspace, hypotheses: [{ kind: 'hypothesis', id: 'h', questionId: 'missing', explanation: 'Unknown question' }] } } }];
    for (const input of invalid) expect(() => parseResearchCaseView(input)).toThrow(ResearchClientError);
  });

  it('rejects malformed retained tables, material heads and stale-reference substitutions', () => {
    const t = setup();
    t.update({ kind: 'evidence', value: evidence('table', { kind: 'reference' }), assets: [] });
    t.update({ kind: 'material', value: { kind: 'retain', material: t.material('table') } });
    t.update({ kind: 'finding', value: t.finding('table', t.anchor('table')) });
    const report = t.current(), workspace = report.document.workspace;
    if (workspace.schemaVersion !== 'contexttrail-inquiry-v2') throw new Error('Expected v2 fixture');
    const first = workspace.materials.versions[0], view = report.findings[0];
    const invalidStores = [
      { ...workspace.materials, versions: [{ ...first, content: { kind: 'table', columns: ['A', 'B'], rows: [['only one']] } }] },
      { ...workspace.materials, versions: [{ ...first, digest: 'not-a-digest' }] },
      { ...workspace.materials, heads: [{ materialId: 'table', status: 'available', digest: `sha256:${'0'.repeat(64)}`, sourceStatus: 'bound' }] },
      { ...workspace.materials, heads: [{ materialId: 'missing', status: 'unavailable', reason: 'No history' }] },
    ];
    for (const materials of invalidStores) expect(() => parseResearchCaseView({ ...report, document: { ...report.document, workspace: { ...workspace, materials } } })).toThrow(ResearchClientError);
    expect(() => parseResearchCaseView({ ...report, findings: [{ ...view, support: [{ ...view.support[0], currentMaterial: { materialId: 'table', revision: 900, digest: first.digest, evidenceId: first.evidenceId, content: { kind: 'table', rowCount: 2, columnCount: 2 } } }] }] })).toThrow('reference does not match');
    expect(() => parseResearchCaseView({ ...report, findings: [{ ...view, support: [{ ...view.support[0], currentMaterial: null }] }] })).toThrow('lacks its bound material');
  });

  it('rejects dependency citations and source references that disagree with the current case', () => {
    const t = setup();
    t.update({ kind: 'evidence', value: evidence('a'), assets: [] });
    t.update({ kind: 'citation', value: { id: 'citation-a', fromEvidenceId: 'a', targetUrl: 'https://synthetic.example/a', targetRole: 'unspecified', claimId: null, quote: null } });
    const report = t.current();
    expect(() => parseResearchCaseView({ ...report, dependencies: { ...report.dependencies, sources: [{ ...report.dependencies.sources[0], evidenceIds: ['missing'] }] } })).toThrow('unknown evidence reference');
    expect(() => parseResearchCaseView({ ...report, dependencies: { ...report.dependencies, citationChecks: [] } })).toThrow('differs from saved citations');
  });

  it('rejects unsafe source links, invalid anchors and inconsistent review states', () => {
    const t = setup();
    t.update({ kind: 'evidence', value: evidence('a'), assets: [] });
    t.update({ kind: 'finding', value: t.finding('a', { kind: 'text', start: 0, quote: 'Retained' }) });
    const report = t.current(), f = report.findings[0], record = inquiryCase(report.document.workspace);
    expect(() => parseResearchCaseView({ ...report, document: { ...report.document, workspace: { ...report.document.workspace, collection: { ...report.document.workspace.collection, cases: [{ ...record, evidence: [{ ...record.evidence[0], sourceUrl: 'javascript:alert(1)' }] }] } } } })).toThrow(ResearchClientError);
    for (const changed of [
      { ...f, reviewStatus: 'verified' },
      { ...f, reviewStatus: 'needs_review' },
      { ...f, support: [{ ...f.support[0], status: 'verified' }] },
      { ...f, support: [{ ...f.support[0], anchor: { kind: 'text', start: -1, quote: 'Retained' } }] },
      { ...f, support: [{ ...f.support[0], anchor: { kind: 'text', start: 1, quote: 'Retained' } }] },
    ]) expect(() => parseResearchCaseView({ ...report, findings: [changed] })).toThrow(ResearchClientError);
  });

  it('validates summary identities, UTC dates and revisions', () => {
    const summary = { caseId: 'case:browser-case', question: start.question, createdAt, revision: 1 };
    expect(parseResearchCaseList({ cases: [summary] })).toEqual({ cases: [summary], warnings: [] });
    for (const input of [{ cases: [summary, summary] }, { cases: [{ ...summary, createdAt: '2026-02-30T00:00:00Z' }] }, { cases: [{ ...summary, revision: 0 }] }, { cases: [{ ...summary, question: null }] }, { cases: {} }]) expect(() => parseResearchCaseList(input)).toThrow(ResearchClientError);
  });
});

describe('same-origin research API client', () => {
  it('sends explicit GET/POST requests with no cache, credentials scope and AbortSignal', async () => {
    const report = setup().current(), signal = new AbortController().signal;
    const summary = { caseId: report.document.workspace.inquiry.caseId, question: start.question, createdAt, revision: 1 };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(Response.json({ cases: [summary] })).mockResolvedValueOnce(Response.json(report)).mockResolvedValueOnce(Response.json(report));
    vi.stubGlobal('fetch', fetch);
    expect(await listResearchCases({ signal })).toEqual({ cases: [summary], warnings: [] });
    expect((await getResearchCase(summary.caseId, { signal })).caseId).toBe(summary.caseId);
    expect((await startResearchCase(start, { signal })).revision).toBe(1);
    expect(fetch.mock.calls[0]).toEqual(['/api/research', { method: 'GET', signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error' }]);
    expect(fetch.mock.calls[1][0]).toBe('/api/research?caseId=case%3Abrowser-case');
    expect(fetch.mock.calls[2]).toEqual(['/api/research', { method: 'POST', signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...start, kind: 'start' }) }]);
  });

  it('serializes updates with the caller operation ID and expected revision', async () => {
    const t = setup(), change: ResearchChange = { kind: 'subquestion', value: { kind: 'subquestion', id: 'q2', question: 'What changed?' } };
    const updated = t.update(change), request = { caseId: updated.document.workspace.inquiry.caseId, operationId: 'my-stable-operation', expectedRevision: 1, change };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(updated)); vi.stubGlobal('fetch', fetch);
    expect((await updateResearchCase(request)).subquestions[0].id).toBe('q2');
    expect(fetch.mock.calls[0][1]?.body).toBe(JSON.stringify({ ...request, kind: 'update' }));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([[503, 'LOCAL_SERVICE_DISABLED'], [403, 'LOCAL_ONLY'], [404, 'NOT_FOUND'], [409, 'REVISION_CONFLICT']])('surfaces %i %s without retrying or losing the saved case', async (status, code) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ code, error: 'Reopen the last saved case.' }, { status })); vi.stubGlobal('fetch', fetch);
    await expect(listResearchCases()).rejects.toMatchObject({ name: 'ResearchClientError', status, code, message: 'Reopen the last saved case.' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects HTML, malformed success data and wrong-case replies', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response('<html>Unavailable</html>', { status: 502 })).mockResolvedValueOnce(Response.json({ cases: null })).mockResolvedValueOnce(Response.json(setup().current())); vi.stubGlobal('fetch', fetch);
    await expect(listResearchCases()).rejects.toMatchObject({ code: 'INVALID_RESPONSE', status: 502 });
    await expect(listResearchCases()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(getResearchCase('other')).rejects.toThrow('different case');
  });

  it('preserves cancellation and network errors without retrying', async () => {
    const controller = new AbortController(), abort = new DOMException('Cancelled', 'AbortError');
    controller.abort();
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValueOnce(abort).mockRejectedValueOnce(new TypeError('Failed to fetch')); vi.stubGlobal('fetch', fetch);
    await expect(listResearchCases({ signal: controller.signal })).rejects.toBe(abort);
    await expect(listResearchCases()).rejects.toThrow('Failed to fetch');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('has a browser-safe runtime import graph after type erasure', () => {
    const seen = new Set<string>();
    function inspect(path: string) {
      if (seen.has(path)) return;
      seen.add(path);
      const source = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
      expect(source).not.toMatch(/\b(?:Buffer|process|require)\b|node:|pngjs/);
      const module = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      for (const node of module.statements) {
        if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
        const target = node.moduleSpecifier.text;
        expect(target.startsWith('.')).toBe(true);
        inspect(resolve(dirname(path), `${target}.ts`));
      }
    }
    inspect(resolve('src/lib/research/client.ts'));
    expect(seen.size).toBe(6); // Adds the grounded report parser and browser-safe model identity helpers.
  });
});

it('validates recovery warnings and keeps them beside readable case summaries', () => {
  const warning = { file: 'a'.repeat(64) + '.json', code: 'RECOVERY_REQUIRED', message: 'Preserve the original file.' };
  expect(parseResearchCaseList({ cases: [], warnings: [warning] })).toEqual({ cases: [], warnings: [warning] });
  for (const changed of [{ ...warning, file: '/private/path' }, { ...warning, code: 'SAFE_TO_DELETE' }, { ...warning, message: null }]) {
    expect(() => parseResearchCaseList({ cases: [], warnings: [changed] })).toThrow(ResearchClientError);
  }
});
