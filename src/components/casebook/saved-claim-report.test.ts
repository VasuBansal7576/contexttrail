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
function fixture() {
  const question = 'What is in the record?';
  const record = inquiryCase(researchWorkflow({ kind: 'start', operationId: 'source', question, createdAt: '2026-10-01T00:00:00Z' }).document.workspace);
  record.evidence = [{ id: 'e1', sourceUrl: 'https://example.com/record', title: 'Original source', content: { kind: 'text', text: 'Original retained text.', attribution: 'page_quote' }, publicationDate: { status: 'unknown', reason: 'No known date' }, provenance: { method: 'retrieval', toolVersion: null, capturedAt: null, retrievedAt: null, rights: 'public_reference', retention: 'reference_only', contentHash: null } }];
  const claimReport = buildClaimReport(question, record, [assessClaimSource(record.evidence[0], null, null)]);
  const saved = researchWorkflow({ kind: 'import_case', operationId: 'save', question, createdAt: record.createdAt, caseRecord: record, claimReport });
  return { question, record, claimReport, saved };
}
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
  const details = report?.querySelector('details');
  expect(details?.open).toBe(false);
  expect(details?.textContent).toContain('Original retained text.');
  expect(container.textContent).toContain('Corrected retained text.');
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
