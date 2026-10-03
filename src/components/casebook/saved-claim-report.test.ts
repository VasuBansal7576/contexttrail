/** @vitest-environment jsdom */
import React, { act } from 'react';
import { webcrypto } from 'node:crypto';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Casebook from './Casebook';
import SaveToCasebook from './SaveToCasebook';
import { assessClaimSource, buildClaimReport } from '@/lib/research/claim-report';
import { inquiryCase, researchWorkflow } from '@/lib/research/workflow';
import { getResearchCase, importResearchCase, listResearchCases, parseResearchCaseView } from '@/lib/research/client';
vi.mock('@/lib/research/client', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/research/client')>(), getResearchCase: vi.fn(), importResearchCase: vi.fn(), listResearchCases: vi.fn() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('case=case%3Asource&chapter=evidence'), useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => React.createElement('a', props) }));
let root: Root, container: HTMLDivElement;
beforeEach(() => { vi.stubGlobal('React', React); vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.mocked(listResearchCases).mockResolvedValue({ cases: [], warnings: [] }); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
function fixture(text = 'Original retained text.') {
  const question = 'What is in the record?';
  const record = inquiryCase(researchWorkflow({ kind: 'start', operationId: 'source', question, createdAt: '2026-10-01T00:00:00Z' }).document.workspace);
  record.evidence = [{ id: 'e1', sourceUrl: 'https://example.com/record', title: 'Original source', content: { kind: 'text', text, attribution: 'page_quote' }, publicationDate: { status: 'unknown', reason: 'No known date' }, provenance: { method: 'retrieval', toolVersion: null, capturedAt: null, retrievedAt: null, rights: 'public_reference', retention: 'reference_only', contentHash: null } }];
  record.coverage.limitations = ['Primary-source coverage has not been independently established.', 'Source 3 could not be read; its original search lead remains.', 'Source 5 led to an unrelated destination; destination text and dates were not used.', 'Some relevance assessments were unavailable; those sources remain unassessed leads.'];
  const claimReport = buildClaimReport(question, record, [assessClaimSource(record.evidence[0], null, null)]);
  const saved = researchWorkflow({ kind: 'import_case', operationId: 'save', question, createdAt: record.createdAt, caseRecord: record, claimReport });
  return { question, record, claimReport, saved };
}
it.each(['current', 'stale', 'legacy'])('selects a clean saved %s passage without rewriting the original report or snapshot', async status => {
  const prefix = 'PostLog inSign upPostLog inSign up';
  const body = 'Synthetic publisher: “The agency described the current launch programme and its commercial partners.”';
  const f = fixture(prefix + body);
  const { claimReportCase: _snapshot, claimReportCaseOrigin: _origin, ...legacyDocument } = f.saved.document;
  const saved = status === 'current' ? f.saved : status === 'legacy' ? { ...f.saved, document: legacyDocument } : researchWorkflow({ kind: 'update', document: f.saved.document, operationId: 'correct', expectedRevision: 1, change: { kind: 'evidence', value: { ...f.record.evidence[0], sourceUrl: 'https://corrected.example.org/record', title: 'Corrected source', content: { kind: 'text', text: 'Corrected current passage.', attribution: 'page_quote' } }, assets: [] } });
  const before = JSON.stringify(saved.document);
  const view = parseResearchCaseView(saved);
  expect(view.reportStatus).toBe(status === 'stale' ? 'stale' : 'current');
  vi.mocked(getResearchCase).mockResolvedValue(view);
  await act(async () => root.render(React.createElement(Casebook)));
  const report = container.querySelector('[aria-label="Saved grounded report"]');
  expect(report?.querySelector('blockquote')?.textContent).toBe(body);
  expect(report?.textContent).toContain(`characters ${prefix.length}–${prefix.length + body.length}`);
  expect(report?.textContent).toContain('Model assessment applies to the full retained excerpt');
  expect(report?.querySelector('details.claim-original-excerpt')?.textContent).toContain(prefix + body);
  expect(report?.querySelector('a[href="https://example.com/record"]')).not.toBeNull();
  expect(report?.querySelector('a[href="https://corrected.example.org/record"]')).toBeNull();
  expect(view.claimReport).toEqual(f.claimReport);
  expect(view.claimReportCase).toEqual(f.record);
  expect(JSON.stringify(saved.document)).toBe(before);
  expect(importResearchCase).not.toHaveBeenCalled();
});
it('shows retained investigation warnings beside a reopened report, independent of mutable current coverage', async () => {
  const f = fixture();
  f.saved.document.workspace.collection.cases[0].coverage.limitations = ['Current case coverage changed later.'];
  vi.mocked(getResearchCase).mockResolvedValue(parseResearchCaseView(f.saved));
  await act(async () => root.render(React.createElement(Casebook)));
  const report = container.querySelector('[aria-label="Saved grounded report"]');
  for (const warning of f.record.coverage.limitations) expect(report?.textContent).toContain(warning);
  expect(report?.textContent).not.toContain('Current case coverage changed later.');
});
it('Save report sends the exact grounded report through the existing import path', async () => {
  const f = fixture(); vi.mocked(importResearchCase).mockResolvedValue(parseResearchCaseView(f.saved));
  await act(async () => root.render(React.createElement(SaveToCasebook, { value: f.record, question: f.question, claimReport: f.claimReport })));
  expect(container.textContent).toContain('Save report');
  await act(async () => { container.querySelector('button')?.click(); await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(importResearchCase).toHaveBeenCalledTimes(1);
  expect(vi.mocked(importResearchCase).mock.calls[0][0]).toMatchObject({ question: f.question, caseRecord: f.record, claimReport: f.claimReport });
  expect(container.textContent).toContain('Open saved case');
});
it('reopened corrected cases show needs review with original report collapsed as historical', async () => {
  const f = fixture();
  const corrected = researchWorkflow({ kind: 'update', document: f.saved.document, operationId: 'correct', expectedRevision: 1, change: { kind: 'evidence', value: { ...f.record.evidence[0], content: { kind: 'text', text: 'Corrected retained text.', attribution: 'page_quote' } }, assets: [] } });
  vi.mocked(getResearchCase).mockResolvedValue(parseResearchCaseView(corrected));
  await act(async () => root.render(React.createElement(Casebook)));
  const report = container.querySelector('[aria-label="Saved grounded report"]');
  expect(report?.textContent).toContain('Needs review');
  expect(report?.textContent).toContain('historical record');
  const details = report?.querySelector<HTMLDetailsElement>('.saved-original-report');
  expect(details?.open).toBe(false);
  expect(details?.textContent).toContain('Original retained text.');
  const coverage = report?.querySelector('[aria-label="Saved investigation coverage"]');
  expect(coverage?.closest('details')).toBeNull();
  expect(coverage?.textContent).toContain('original historical report');
  expect(coverage?.textContent).toContain(f.record.coverage.limitations[0]);
  expect(container.textContent).toContain('Corrected retained text.');
});
it('does not claim original coverage for an older report with no retained snapshot', async () => {
  const f = fixture(); delete f.saved.document.claimReportCase; delete f.saved.document.claimReportCaseOrigin;
  vi.mocked(getResearchCase).mockResolvedValue(parseResearchCaseView(f.saved));
  await act(async () => root.render(React.createElement(Casebook)));
  const coverage = container.querySelector('[aria-label="Saved investigation coverage"]');
  expect(coverage?.textContent).toContain('original investigation coverage snapshot was not retained');
  expect(coverage?.textContent).not.toContain(f.record.coverage.limitations[0]);
  expect(container.textContent).toContain('Source-quoted candidate assertion');
});
it('labels absent limitation text and read audit without implying complete or successful coverage', async () => {
  const f = fixture();
  if (!f.saved.document.claimReportCase) throw new Error('Missing fixture snapshot');
  f.saved.document.claimReportCase.coverage.limitations = [];
  vi.mocked(getResearchCase).mockResolvedValue(parseResearchCaseView(f.saved));
  await act(async () => root.render(React.createElement(Casebook)));
  const coverage = container.querySelector('[aria-label="Saved investigation coverage"]');
  expect(coverage?.textContent).toContain('No investigation-wide limitation text was retained');
  expect(coverage?.textContent).toContain('Missing audit metadata does not establish successful reads');
});
it('shows known failed and rejected reads even when limitation prose is absent', async () => {
  const f = fixture(); if (!f.saved.document.claimReportCase) throw new Error('Missing fixture snapshot');
  f.saved.document.claimReportCase.coverage.limitations = [];
  f.saved.document.claimReportCase.coverage.sourceReads = [
    { evidenceId: 'e1', requestedUrl: 'https://example.com/record', finalUrl: null, sourceBinding: 'not_established', outcome: 'fetch_failed' },
    { evidenceId: 'e2', requestedUrl: 'https://example.com/other', finalUrl: 'https://example.com/login', sourceBinding: 'blocked_destination', outcome: 'binding_rejected' },
  ];
  vi.mocked(getResearchCase).mockResolvedValue(parseResearchCaseView(f.saved));
  await act(async () => root.render(React.createElement(Casebook)));
  const coverage = container.querySelector('[aria-label="Saved investigation coverage"]');
  expect(coverage?.textContent).toContain('Failed reads: 1');
  expect(coverage?.textContent).toContain('Rejected destinations: 1');
  expect(coverage?.textContent).toContain('do not establish complete coverage');
});
it('shows recovery warnings without hiding the readable saved case', async () => {
  const f = fixture();
  vi.mocked(getResearchCase).mockResolvedValue(parseResearchCaseView(f.saved));
  vi.mocked(listResearchCases).mockResolvedValue({ cases: [], warnings: [{ file: 'a'.repeat(64) + '.json', code: 'RECOVERY_REQUIRED', message: 'Preserve the original file for recovery.' }] });
  await act(async () => root.render(React.createElement(Casebook)));
  expect(container.textContent).toContain('Some saved cases need recovery');
  expect(container.textContent).toContain('Original retained text.');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('original files have not been changed');
});
