/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CaseEvidence } from '@/lib/cases/model';
import { parseResearchCaseView, type ResearchCaseView, type ResearchFindingSupport } from '@/lib/research/client';
import { inquiryCase, researchWorkflow } from '@/lib/research/workflow';
import EvidenceDetail, { evidenceOrigin } from './EvidenceDetail';

const extractedText = "ਫ਼ੇਸਬੁੱਕ ਨੂੰ ਆਪਣੇ ਫ਼ੋਨ 'ਤੇ ਚਲਾਓਕਿਸੇ ਵੀ ਵੇਲੇ, ਕਿਸੇ ਵੀ ਥਾਂ ਜੁੜੇ ਰਹੋ।";
function evidence(): CaseEvidence {
  return {
    id: 'ev-muqowfsl-65', sourceUrl: 'https://www.instagram.com/p/DSphsDeDA2O/',
    title: 'On this day in 1968, the crew of Apollo 8 became the first humans to ...',
    content: { kind: 'text', attribution: 'page_quote', text: extractedText },
    publicationDate: { status: 'unknown', reason: 'Not recorded' },
    provenance: { method: 'page_extraction', toolVersion: null, capturedAt: null, retrievedAt: '2026-10-02T08:16:55.034Z', rights: 'unknown', retention: 'reference_only', contentHash: null },
  };
}
function savedView(source: CaseEvidence): ResearchCaseView {
  const question = 'What does this source establish?';
  const record = inquiryCase(researchWorkflow({ kind: 'start', operationId: 'source', question, createdAt: '2026-10-02T00:00:00Z' }).document.workspace);
  record.evidence = [source];
  return parseResearchCaseView(researchWorkflow({ kind: 'import_case', operationId: 'save', question, createdAt: record.createdAt, caseRecord: record }));
}
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('React', React); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function render(source = evidence(), view = savedView(source), support?: ResearchFindingSupport) {
  const onCorrect = vi.fn(), onFinding = vi.fn();
  await act(async () => root.render(React.createElement(EvidenceDetail, { evidence: source, view, support, onClose: vi.fn(), onCorrect, onFinding })));
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) throw new Error('Evidence inspector did not open');
  return { dialog, onCorrect, onFinding };
}
function metadata(dialog: Element, label: string) {
  return [...dialog.querySelectorAll('dt')].find(term => term.textContent === label)?.nextElementSibling?.textContent;
}
it('reproduces the saved Instagram extraction without calling it supplied or diagnosing its language', async () => {
  const source = evidence(), before = JSON.stringify(source);
  const { dialog, onCorrect, onFinding } = await render(source);
  expect(dialog.querySelector('.evidence-passage')?.textContent).toBe(extractedText);
  expect(dialog.textContent).toContain('Retrieved page text');
  expect(dialog.textContent).toContain('Not linked to a finding');
  expect(dialog.textContent).toContain('do not establish relevance or truth');
  expect(dialog.textContent).not.toMatch(/supplied evidence|access blocked|fake|unreadable/i);
  expect(metadata(dialog, 'Current source retrieved')).toBe('2026-10-02T08:16:55.034Z');
  expect(metadata(dialog, 'Current source captured')).toBe('Not recorded');
  expect(metadata(dialog, 'Publication date')).toBe('Unknown');
  await act(async () => { [...dialog.querySelectorAll('button')].find(button => button.textContent === 'Record a correction')?.click(); });
  await act(async () => { [...dialog.querySelectorAll('button')].find(button => button.textContent === 'Add a finding')?.click(); });
  expect(onCorrect).toHaveBeenCalledOnce(); expect(onFinding).toHaveBeenCalledOnce();
  expect(JSON.stringify(source)).toBe(before);
});
it('preserves legitimate non-English source text under the same origin rules', async () => {
  const source = evidence(); source.title = 'La mission Apollo 8';
  source.content = { kind: 'text', attribution: 'page_quote', text: 'Apollo 8 a atteint la Lune en décembre 1968.' };
  const { dialog } = await render(source);
  expect(dialog.querySelector('.evidence-passage')?.textContent).toBe(source.content.text);
  expect(dialog.textContent).toContain('Retrieved page text');
  expect(dialog.textContent).not.toMatch(/fake|blocked|unreadable/i);
});
it.each(['manual', 'user_submission'] as const)('labels %s provenance as user supplied even with page quote attribution', async method => {
  const source = evidence(); source.provenance = { ...source.provenance, method, retrievedAt: null };
  const { dialog } = await render(source);
  expect(dialog.textContent).toContain('User-supplied evidence');
  expect(metadata(dialog, 'Current source retrieved')).toBe('Not recorded');
});
it('distinguishes search snippets, model-derived unknown origins, and absent dates', async () => {
  const source = evidence(); source.provenance.method = 'retrieval';
  source.content = { kind: 'text', attribution: 'search_snippet', text: 'Search result description.' };
  expect(evidenceOrigin(source)).toBe('Retrieved search snippet');
  source.provenance = { ...source.provenance, method: 'model_assessment', retrievedAt: null };
  source.content = { kind: 'text', attribution: 'classification_context', text: 'Retained classification context.' };
  source.title = null;
  const { dialog } = await render(source);
  expect(dialog.textContent).toContain('Source origin unknown');
  expect(dialog.textContent).toContain('Untitled source');
  expect(metadata(dialog, 'Current source retrieved')).toBe('Not recorded');
  expect(metadata(dialog, 'Current source captured')).toBe('Not recorded');
});
it('does not call linked evidence unreviewed when opened outside its finding', async () => {
  const source = evidence(), view = savedView(source);
  const support: ResearchFindingSupport = { evidenceId: source.id, relationship: 'context', anchor: { kind: 'text', start: 0, quote: extractedText }, status: 'current', reason: null, evidence: source, retainedMaterial: null, currentMaterial: null, historicalText: null };
  view.findingViews = [{ finding: { kind: 'finding', id: 'f1', questionId: view.questionId, text: 'A retained passage.', assessment: { kind: 'source_statement', reviewer: 'Reviewer', rationale: 'Inspect the source.' }, support: [support] }, reviewStatus: 'current', support: [support], limitation: 'Source truth unverified.' }];
  const { dialog } = await render(source, view);
  expect(dialog.textContent).toContain('Finding link current');
  expect(dialog.textContent).not.toContain('No finding links');
  expect(dialog.textContent).toContain('Retrieved page text');
});
it('keeps original historical text and retrieval dates separate after a correction', async () => {
  const historical = evidence(), source = evidence();
  source.content = { kind: 'text', attribution: 'page_quote', text: 'Corrected current passage.' };
  source.provenance.retrievedAt = '2026-10-02T09:00:00Z';
  const support: ResearchFindingSupport = { evidenceId: source.id, relationship: 'context', anchor: { kind: 'text', start: 0, quote: extractedText }, status: 'changed', reason: 'Source changed.', evidence: source, retainedMaterial: null, currentMaterial: null, historicalText: { caseRevision: 1, evidence: historical } };
  const { dialog } = await render(source, savedView(source), support);
  expect([...dialog.querySelectorAll('.evidence-passage')].map(p => p.textContent)).toEqual([extractedText, 'Corrected current passage.']);
  expect(dialog.textContent).toContain('Historical source retrieved: 2026-10-02T08:16:55.034Z');
  expect(metadata(dialog, 'Current source retrieved')).toBe('2026-10-02T09:00:00Z');
  expect(dialog.textContent).toContain('Finding needs review');
});
