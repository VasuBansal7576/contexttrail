/** @vitest-environment jsdom */
import React, { act } from 'react';
import { webcrypto } from 'node:crypto';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ClaimReportView } from './ClaimReportView';
import Casebook from './Casebook';
import { assessClaimSource, buildClaimReport, explicitTopicClaim } from '@/lib/research/claim-report';
import { JEV_MODEL, type JevAskResult } from '@/lib/jev/client';
import { inquiryCase, researchWorkflow } from '@/lib/research/workflow';
import { getResearchCase, importResearchCase, listResearchCases, parseResearchCaseView } from '@/lib/research/client';
vi.mock('@/lib/research/client', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/research/client')>(), getResearchCase: vi.fn(), importResearchCase: vi.fn(), listResearchCases: vi.fn() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('case=case%3Asource&chapter=evidence'), useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => React.createElement('a', props) }));
let root: Root, container: HTMLDivElement;
beforeEach(() => { vi.stubGlobal('React', React); vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.mocked(listResearchCases).mockResolvedValue({ cases: [], warnings: [] }); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
function fixture(scores: (number | null)[] = [.01, .97, .01, .03, .01, .03, .01, .02], question = 'Was the synthetic bridge inaugurated in April 2021 or June 2025?') {
  const record = inquiryCase(researchWorkflow({ kind: 'start', operationId: 'source', question, createdAt: '2026-10-01T00:00:00Z' }).document.workspace);
  record.evidence = scores.map((_score, index) => ({ id: `e${index}`, sourceUrl: `https://source${index}.example/record`, title: index === 1 ? 'Synthetic bridge inauguration and arch closure' : `Synthetic lead ${index}`, content: { kind: 'text', text: index === 1 ? 'Synthetic publisher reports June 2025 inauguration and April 2021 arch closure.' : `Synthetic unrelated retained passage ${index}.`, attribution: 'page_quote' }, publicationDate: { status: 'unknown', reason: 'No known date' }, provenance: { method: 'retrieval', toolVersion: null, capturedAt: null, retrievedAt: null, rights: 'public_reference', retention: 'reference_only', contentHash: null } }));
  const sources = record.evidence.map((evidence, index) => {
    const score = scores[index];
    const choice = (keys: string[], winner: string) => ({ type: 'choice', choice: winner, probabilities: Object.fromEntries(keys.map(key => [key, key === winner ? 1 : 0])) });
    const answer: JevAskResult | null = score === null ? null : { model: JEV_MODEL, identity: { requested: JEV_MODEL, reported: JEV_MODEL, status: 'verified', pinned: true }, answers: { relevance: { type: 'noul', noul: score }, relation: choice(['support', 'challenge', 'context', 'insufficient'], 'insufficient'), entity_property: choice(['compatible', 'different', 'unknown'], 'unknown'), time: choice(['compatible', 'different', 'unknown'], 'unknown'), variant: choice(['compatible', 'different', 'unknown'], 'unknown') } };
    return assessClaimSource(evidence, explicitTopicClaim(question), answer);
  });
  return { question, record, report: buildClaimReport(question, record, sources) };
}
function order() { return Array.from(container.querySelectorAll('.claim-report-source h4'), item => item.textContent); }
async function renderFixture(f: ReturnType<typeof fixture>) { await act(async () => root.render(React.createElement(ClaimReportView, { report: f.report, caseRecord: f.record }))); }
async function chooseOriginal() { const button = Array.from(container.querySelectorAll('button')).find(item => item.textContent === 'Original retrieval order'); expect(button).toBeDefined(); await act(async () => button?.click()); }
it('puts the already-retained relevant source first and exposes low relevance without opening inspection', async () => {
  const f = fixture(), before = JSON.stringify(f); await renderFixture(f);
  expect(order()[0]).toBe(f.record.evidence[1].title);
  expect(order()).toHaveLength(8);
  const labels = Array.from(container.querySelectorAll('.claim-topic-relevance'));
  expect(labels[0]?.textContent).toContain('0.97');
  expect(labels.every(label => label.closest('details') === null)).toBe(true);
  expect(container.querySelectorAll('.claim-report-source')[1]?.querySelector('.claim-topic-relevance')?.textContent).toContain('Low topic relevance');
  expect(container.textContent).toContain('not factual accuracy');
  expect(container.querySelectorAll('.claim-report-source .eyebrow')[0]?.textContent).toBe('Insufficient evidence');
  await chooseOriginal(); expect(order()).toEqual(f.record.evidence.map(item => item.title));
  expect(JSON.stringify(f)).toBe(before);
});
it('preserves ties and distinguishes unassessed from a measured zero', async () => {
  const f = fixture([null, 0, .97, .97, null]); await renderFixture(f);
  expect(order()).toEqual([f.record.evidence[2].title, f.record.evidence[3].title, f.record.evidence[1].title, f.record.evidence[0].title, f.record.evidence[4].title]);
  const labels = Array.from(container.querySelectorAll('.claim-topic-relevance'), item => item.textContent);
  expect(labels.filter(label => label?.includes('unassessed'))).toHaveLength(2);
  expect(labels[2]).toContain('0'); expect(labels[2]).not.toContain('unassessed');
  await chooseOriginal(); expect(order()).toEqual(f.record.evidence.map(item => item.title));
});
it.each([[.01, .03, .02], [null, null, null]])('keeps every all-low or all-unassessed lead inspectable: %j', async (...scores) => {
  const f = fixture(scores); await renderFixture(f); expect(order()).toHaveLength(scores.length);
  for (const evidence of f.record.evidence) expect(container.querySelector(`a[href="${evidence.sourceUrl}"]`)).not.toBeNull();
});
it('does not favour supporting relationships over relevant challenges', async () => {
  const f = fixture([.8, .9]); f.report.sources[0].relation = 'support'; f.report.sources[1].relation = 'challenge';
  await renderFixture(f); expect(order()[0]).toBe(f.record.evidence[1].title);
  expect(container.querySelector('.claim-report-source .eyebrow')?.textContent).toBe('Challenging excerpt');
});
it('preserves explicit-claim ordering and does not offer a topic ordering control', async () => {
  const f = fixture([.01, .97], 'Claim: The synthetic bridge opened in 2021.'); await renderFixture(f);
  expect(order()).toEqual(f.record.evidence.map(item => item.title));
  expect(container.textContent).not.toContain('Original retrieval order');
});
it('resets pagination when changing order and exposes the active order accessibly', async () => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: vi.fn(), configurable: true });
  const f = fixture([.1, .2, .3, .4, .5, .6, .7, .8, .9]); await renderFixture(f);
  expect(container.querySelector('[role="group"][aria-label="Source assessment order"]')).not.toBeNull();
  const relevance = Array.from(container.querySelectorAll('button')).find(item => item.textContent === 'Topic relevance order');
  expect(relevance?.getAttribute('aria-pressed')).toBe('true');
  const next = Array.from(container.querySelectorAll('button')).find(item => item.textContent === 'Next');
  await act(async () => next?.click()); expect(order()).toEqual([f.record.evidence[0].title]);
  await chooseOriginal(); expect(order()).toEqual(f.record.evidence.slice(0, 8).map(item => item.title));
  expect(container.textContent).toContain('Source assessments: 1–8 of 9');
  const original = Array.from(container.querySelectorAll('button')).find(item => item.textContent === 'Original retrieval order');
  expect(original?.getAttribute('aria-pressed')).toBe('true'); expect(relevance?.getAttribute('aria-pressed')).toBe('false');
  await act(async () => relevance?.click()); expect(order()[0]).toBe(f.record.evidence[8].title);
});
it.each(['current', 'stale', 'legacy'])('uses the retained saved %s report assessments without rewriting archive or inspecting current evidence', async status => {
  const f = fixture(); let saved = researchWorkflow({ kind: 'import_case', operationId: 'save', question: f.question, createdAt: f.record.createdAt, caseRecord: f.record, claimReport: f.report });
  if (status === 'stale') saved = researchWorkflow({ kind: 'update', document: saved.document, operationId: 'correct', expectedRevision: 1, change: { kind: 'evidence', value: { ...f.record.evidence[1], title: 'Current corrected source', content: { kind: 'text', text: 'Current unrelated text.', attribution: 'page_quote' } }, assets: [] } });
  if (status === 'legacy') { delete saved.document.claimReportCase; delete saved.document.claimReportCaseOrigin; }
  const before = JSON.stringify(saved.document), view = parseResearchCaseView(saved);
  vi.mocked(getResearchCase).mockResolvedValue(view); await act(async () => root.render(React.createElement(Casebook)));
  expect(order()[0]).toBe(f.record.evidence[1].title); expect(order()).toHaveLength(8);
  expect(container.querySelector('.claim-topic-relevance')?.textContent).toContain('0.97');
  await chooseOriginal(); expect(order()).toEqual(f.record.evidence.map(item => item.title));
  expect(view.claimReport).toEqual(f.report); expect(JSON.stringify(saved.document)).toBe(before); expect(importResearchCase).not.toHaveBeenCalled();
});
