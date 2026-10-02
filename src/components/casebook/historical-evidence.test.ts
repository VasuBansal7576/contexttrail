/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Casebook from './Casebook';
import { getResearchCase, listResearchCases, parseResearchCaseView } from '@/lib/research/client';
import { historicalEvidenceFixture } from '@/lib/research/historical-evidence-fixture';
import { researchWorkflow } from '@/lib/research/workflow';
import { originalEvidence } from './HistoricalEvidence';
vi.mock('@/lib/research/client', async original => ({ ...await original<typeof import('@/lib/research/client')>(), getResearchCase: vi.fn(), listResearchCases: vi.fn() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('case=synthetic&chapter=questions'), useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => React.createElement('a', props) }));
let root: Root, container: HTMLDivElement;
beforeEach(() => { vi.stubGlobal('React', React); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network expected'); })); vi.mocked(listResearchCases).mockResolvedValue({ cases: [], warnings: [] }); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.clearAllMocks(); vi.unstubAllGlobals(); });
it.each(['text', 'image', 'table'] as const)('opens bound original %s when current source is missing, without editing review', async kind => {
  const report = historicalEvidenceFixture(kind), before = JSON.stringify(report.document), view = parseResearchCaseView(report);
  vi.mocked(getResearchCase).mockResolvedValue(view);
  await act(async () => root.render(React.createElement(Casebook)));
  expect(container.textContent).toContain('Current source is unavailable');
  await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === 'Inspect original evidence')?.click(); });
  const dialog = document.querySelector('[role=dialog]'); expect(dialog).not.toBeNull();
  expect(dialog?.textContent).toContain('Read-only original evidence'); expect(dialog?.textContent).toContain('Finding needs review');
  expect(dialog?.textContent).toContain('https://example.com/historical-source');
  expect(dialog?.textContent).toContain('2026-09-30T00:00:00Z'); expect(dialog?.textContent).toContain('2026-10-01T00:00:00Z');
  if (kind === 'text') expect(dialog?.querySelector('mark')?.textContent).toBe('the exact saved quote');
  if (kind === 'table') expect(dialog?.querySelector('.selected-cell')?.textContent).toBe('18');
  if (kind === 'image') { expect(dialog?.querySelector('.retained-image')).not.toBeNull(); expect(dialog?.querySelector('.region-selection')?.getAttribute('aria-label')).toContain('x 2, y 1, width 6, height 5'); }
  expect(dialog?.textContent).not.toContain('Record a correction'); expect(dialog?.textContent).not.toContain('Add a finding');
  expect(JSON.stringify(report.document)).toBe(before); expect(fetch).not.toHaveBeenCalled();
});
it('distinguishes absent history and rejects substituting similar text or another material digest', async () => {
  const report = historicalEvidenceFixture('text'); report.document.workspace.collection.caseHistory = [];
  const view = parseResearchCaseView(researchWorkflow({ kind: 'read', document: report.document })); vi.mocked(getResearchCase).mockResolvedValue(view);
  await act(async () => root.render(React.createElement(Casebook)));
  expect(container.textContent).toContain('Matching historical text is absent'); expect(container.textContent).not.toContain('Inspect original evidence');
  const materialView = parseResearchCaseView(historicalEvidenceFixture('table')), support = materialView.findingViews[0].support[0];
  materialView.materials.versions[0].digest = `sha256:${'0'.repeat(64)}`;
  expect(originalEvidence(materialView, support).kind).toBe('absent');
});
it('does not guess historical material provenance from a similar record and rejects invalid history references', () => {
  const report = historicalEvidenceFixture('table');
  const forged = structuredClone(report);
  const bound = forged.findings[0].support[0];
  if (!('historicalEvidence' in bound) || !bound.historicalEvidence) throw new Error('Missing original fixture binding');
  bound.historicalEvidence.caseRevision = 999;
  expect(() => parseResearchCaseView(forged)).toThrow('historical material source');
  for (const record of report.document.workspace.collection.caseHistory) for (const evidence of record.evidence) evidence.title = 'Similar source, different binding';
  const reopened = parseResearchCaseView(researchWorkflow({ kind: 'read', document: report.document }));
  expect(reopened.findingViews[0].support[0].historicalEvidence).toBeNull();
  expect(originalEvidence(reopened, reopened.findingViews[0].support[0]).kind).toBe('absent');
});
it.each(['changed', 'withdrawn'] as const)('labels %s originals distinctly and preserves provenance on reopen', async state => {
  const report = historicalEvidenceFixture('table', state), view = parseResearchCaseView(report); vi.mocked(getResearchCase).mockResolvedValue(view);
  await act(async () => root.render(React.createElement(Casebook)));
  expect(container.textContent).toContain(state === 'changed' ? 'Current source or material changed' : 'Retained material was withdrawn');
  await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === 'Inspect original evidence')?.click(); });
  expect(document.querySelector('[role=dialog]')?.querySelector('.selected-cell')?.textContent).toBe('18');
  expect(parseResearchCaseView(researchWorkflow({ kind: 'read', document: report.document })).findingViews[0].reviewStatus).toBe('needs_review');
});
