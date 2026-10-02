/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AutomaticResearch, { AutomaticResult } from './AutomaticResearch';
import { investigateAutomatically, type AutomaticResearchView } from '@/lib/research/automatic-client';
import { buildClaimReport, assessClaimSource } from '@/lib/research/claim-report';
import { ClaimReportView } from './ClaimReportView';
import { CASE_SCHEMA_VERSION } from '@/lib/cases/model';
vi.mock('@/lib/research/automatic-client', () => ({ investigateAutomatically: vi.fn() }));
vi.mock('next/link', () => ({ default: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => React.createElement('a', props) }));
let root: Root, container: HTMLDivElement;
const scrollIntoView = vi.fn();
const result: AutomaticResearchView = { kind: 'topic', question: 'Source question?', caseRecord: { schemaVersion: CASE_SCHEMA_VERSION, id: 'test', revision: 1, createdAt: '2026-10-01T00:00:00Z', claims: [], assets: [], evidence: [{ id: 'source', sourceUrl: 'https://example.com/article', title: 'Source title', content: { kind: 'text', text: 'The actual retrieved passage.', attribution: 'search_snippet' }, publicationDate: { status: 'unknown', reason: 'No date in source.' }, provenance: { method: 'retrieval', toolVersion: null, capturedAt: null, retrievedAt: null, rights: 'public_reference', retention: 'reference_only', contentHash: null } }], occurrences: [], relations: [], coverage: { scope: 'retrieved_evidence', completeness: 'partial', omittedEvidenceCount: 0, originalPublication: { status: 'unknown', reason: 'No original established.' }, limitations: [], searches: [] } }, frames: [], assessments: [], limitations: [] };
beforeEach(() => { scrollIntoView.mockReset(); Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: scrollIntoView, configurable: true }); vi.stubGlobal('React', React); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.mocked(investigateAutomatically).mockReset(); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function fillTopic() { const field = container.querySelector('textarea'); if (!field) throw new Error('Missing topic'); await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field, 'Source question?'); field.dispatchEvent(new Event('input', { bubbles: true })); }); }
async function submit() { await act(async () => { container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); }
describe('automatic research UI', () => {
  it('starts from one question without creating a manual case and renders returned source text', async () => {
    vi.mocked(investigateAutomatically).mockResolvedValue(result);
    await act(async () => root.render(React.createElement(AutomaticResearch, { kind: 'topic' })));
    await fillTopic(); await submit();
    expect(investigateAutomatically).toHaveBeenCalledTimes(1);
    expect(vi.mocked(investigateAutomatically).mock.calls[0][0].get('topic')).toBe('Source question?');
    expect(container.textContent).toContain('The actual retrieved passage.');
    expect(container.textContent).toContain('Publication date unknown');
    expect(container.textContent).toContain('partial coverage');
    expect(container.querySelector('a[href="https://example.com/article"]')).not.toBeNull();
  });
  it('focuses and explicitly reveals an error above the fixed chapter navigation', async () => {
    vi.mocked(investigateAutomatically).mockRejectedValue(new Error('Live investigations are disabled. This preview does not contact providers.'));
    await act(async () => root.render(React.createElement(AutomaticResearch, { kind: 'topic' })));
    await fillTopic(); await submit();
    const status = container.querySelector('.automatic-status');
    expect(status?.contains(container.querySelector('[role=alert]'))).toBe(true);
    expect(document.activeElement).toBe(status);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'instant' });
    expect(scrollIntoView.mock.instances.at(-1)).toBe(status);
  });
  it('labels model relevance separately from truth and retains exact probability', async () => {
    await act(async () => root.render(React.createElement(AutomaticResult, { result: { ...result, assessments: [{ evidenceId: 'source', relevance: 0.82461, model: 'jev-1.13.0' }] } })));
    expect(container.textContent).toContain('Topic relevance · model assessment');
    expect(container.textContent).toContain('Relevance probability: 0.82461. Model: jev-1.13.0.');
    expect(container.textContent).toContain('not factual accuracy or whether the source supports the claim');
  });
  it('blocks duplicate submits and ignores results arriving after cancellation', async () => {
    let finish: ((value: AutomaticResearchView) => void) | undefined;
    vi.mocked(investigateAutomatically).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => root.render(React.createElement(AutomaticResearch, { kind: 'topic' })));
    await fillTopic(); await submit(); await submit(); expect(investigateAutomatically).toHaveBeenCalledTimes(1);
    const signal = vi.mocked(investigateAutomatically).mock.calls[0][1];
    await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === 'Cancel investigation')?.click(); finish?.(result); });
    expect(signal.aborted).toBe(true); expect(container.textContent).toContain('Investigation cancelled.'); expect(container.textContent).not.toContain('The actual retrieved passage.');
  });
  it('aborts on navigation/unmount and keeps the explicit comparison link', async () => {
    vi.mocked(investigateAutomatically).mockImplementation(() => new Promise(() => {}));
    await act(async () => root.render(React.createElement(AutomaticResearch, { kind: 'topic' }))); await fillTopic(); await submit();
    const signal = vi.mocked(investigateAutomatically).mock.calls[0][1];
    await act(async () => root.render(React.createElement(AutomaticResearch, { kind: 'video', key: 'video' })));
    expect(signal.aborted).toBe(true); expect(container.querySelector('a[href="/compare"]')).not.toBeNull();
    expect(container.textContent).toContain('Audio and remaining frames are not searched.');
  });
  it('requires video permission and submits one supplied file with rights', async () => {
    vi.mocked(investigateAutomatically).mockResolvedValue({ ...result, kind: 'video' });
    await act(async () => root.render(React.createElement(AutomaticResearch, { kind: 'video' })));
    await submit(); expect(investigateAutomatically).not.toHaveBeenCalled();
    const file = new File(['test-only-video'], 'test.webm', { type: 'video/webm' });
    const field = container.querySelector<HTMLInputElement>('input[type=file]');
    if (!field) throw new Error('Missing video picker');
    await act(async () => { Object.defineProperty(field, 'files', { value: [file], configurable: true }); field.dispatchEvent(new Event('change', { bubbles: true })); });
    await submit(); expect(investigateAutomatically).not.toHaveBeenCalled();
    await act(async () => { container.querySelector<HTMLInputElement>('input[type=checkbox]')?.click(); });
    await submit();
    const body = vi.mocked(investigateAutomatically).mock.calls[0][0];
    expect(body.get('kind')).toBe('video'); expect(body.get('rights')).toBe('user_provided');
    expect(body.get('video')).toBe(file); expect(body.has('topic')).toBe(false); expect(body.has('claim')).toBe(false);
    expect(container.textContent).toContain('113 questions');
  });
  it('opens timestamped frame sources with explicit incomplete coverage', async () => {
    const source = { evidenceId: 'frame-source', sourceUrl: 'https://example.com/frame', title: 'Frame source', excerpt: 'Frame passage.', dateStatus: 'unknown', observedAt: null, identityBasis: 'unknown', excerptSource: 'search_snippet', displayAttribution: null };
    await act(async () => root.render(React.createElement(AutomaticResult, { result: { ...result, kind: 'video', frames: [{ timestampMs: 1250, imageResult: { limitations: ['One frame only.'], timeline: [], undatedEvidence: [source], supportingEvidence: [], contextualEvidence: [] } }] } })));
    await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent?.startsWith('Sampled frames'))?.click(); });
    expect(container.textContent).toContain('Frame passage.'); expect(container.textContent).toContain('One frame only.'); expect(container.textContent).toContain('Identity basis: unknown'); expect(container.querySelector('a[href="https://example.com/frame"]')).not.toBeNull();
  });
});

it('sends a nonempty video caption once and shows its expanded reservation', async () => {
  vi.mocked(investigateAutomatically).mockResolvedValue({ ...result, kind: 'video' });
  await act(async () => root.render(React.createElement(AutomaticResearch, { kind: 'video' })));
  const file = new File(['fixture'], 'clip.webm', { type: 'video/webm' });
  const field = container.querySelector<HTMLInputElement>('input[type=file]');
  const caption = container.querySelector('textarea');
  if (!field || !caption) throw new Error('Missing video intake');
  expect(caption.maxLength).toBe(500); expect(field.multiple).toBe(false);
  await act(async () => {
    Object.defineProperty(field, 'files', { value: [file], configurable: true }); field.dispatchEvent(new Event('change', { bubbles: true }));
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(caption, '  This video is from yesterday.  '); caption.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { container.querySelector<HTMLInputElement>('input[type=checkbox]')?.click(); });
  expect(container.textContent).toContain('6 searches · 1 image upload · 60 TypeSafe / Jev requests · 272 questions');
  expect(container.textContent).toContain('caption also goes to SerpApi / Google');
  await submit();
  const body = vi.mocked(investigateAutomatically).mock.calls[0][0];
  expect(body.get('claim')).toBe('This video is from yesterday.'); expect(body.getAll('video')).toEqual([file]);
});

it('shows the updated question assessment ceiling', async () => {
  await act(async () => root.render(React.createElement(AutomaticResearch, { kind: 'topic' })));
  expect(container.textContent).toContain('3 searches · 0 uploads · 8 TypeSafe / Jev requests · 40 questions');
});

it('renders source-quoted candidates with unknown scope and no invented user assertion', async () => {
  const claimReport = buildClaimReport(result.question, result.caseRecord, result.caseRecord.evidence.map(evidence => assessClaimSource(evidence, null, null)));
  await act(async () => root.render(React.createElement(AutomaticResult, { result: { ...result, claimReport } })));
  expect(container.textContent).toContain('This is a research question.');
  expect(container.textContent).toContain('Source-quoted candidate assertion');
  expect(container.textContent).toContain('Independent corroboration is not established');
  expect(container.textContent).toContain('Insufficient evidence');
  expect(container.textContent).toContain('Model: Unverified or unavailable');
  expect(container.textContent).toContain('Save report');
  expect(container.querySelector('blockquote')?.textContent).toBe('The actual retrieved passage.');
  expect(container.textContent).not.toContain('User assertion to investigate');
});

it('keeps exact model probabilities, user claim, scope and source disagreements visible', async () => {
  const question = 'Claim: This hotel is closed during 2026.';
  const first = { ...result.caseRecord.evidence[0], content: { kind: 'text' as const, attribution: 'page_quote' as const, text: 'The hotel is closed during 2026.' } };
  const second = { ...first, id: 'opposing-source', sourceUrl: 'https://example.org/report', content: { ...first.content, text: 'The hotel is open during 2026.' } };
  function answer(relation: 'support' | 'challenge') {
    return { model: 'jev-1.13.0', identity: { requested: 'jev-1.13.0', reported: 'jev-1.13.0', status: 'verified' as const, pinned: true }, answers: {
      relevance: { type: 'noul', noul: 0.92461 },
      relation: { type: 'choice', choice: relation, probabilities: { support: relation === 'support' ? 0.94 : 0.02, challenge: relation === 'challenge' ? 0.94 : 0.02, context: 0.02, insufficient: 0.02 } },
      ...Object.fromEntries(['entity_property', 'time', 'variant'].map(key => [key, { type: 'choice', choice: 'compatible', probabilities: { compatible: 0.96, different: 0.02, unknown: 0.02 } }])),
    } };
  }
  const record = { ...result.caseRecord, evidence: [first, second] };
  const report = buildClaimReport(question, record, [assessClaimSource(first, 'This hotel is closed during 2026.', answer('support')), assessClaimSource(second, 'This hotel is closed during 2026.', answer('challenge'))]);
  await act(async () => root.render(React.createElement(ClaimReportView, { report, caseRecord: record })));
  expect(container.textContent).toContain('User assertion to investigate');
  expect(container.textContent).toContain('Supporting excerpt'); expect(container.textContent).toContain('Challenging excerpt');
  expect(container.textContent).toContain('0.92461'); expect(container.textContent).toContain('support: 0.94');
  expect(container.textContent).toContain('Model: jev-1.13.0');
  expect(container.textContent).toContain('The disagreement is unresolved');
  expect(container.querySelectorAll('blockquote')).toHaveLength(2);
  expect(container.querySelector('a[href="https://example.org/report"]')).not.toBeNull();
});

it('shows the sampled-frame caption outcome without hiding it behind the frame toggle', async () => {
  const imageResult = { limitations: [], timeline: [], undatedEvidence: [], supportingEvidence: [], contextualEvidence: [], captionComparison: { mode: 'claim_check' as const, claim: 'This clip is current.', status: 'NO_CONFLICT_FOUND' as const, takeaways: [] } };
  await act(async () => root.render(React.createElement(AutomaticResult, { result: { ...result, kind: 'video', frames: [{ timestampMs: 1000, imageResult }] } })));
  expect(container.textContent).toContain('Sampled-frame caption comparison');
  expect(container.textContent).toContain('This clip is current.');
  expect(container.textContent).toContain('No conflict found in the retrieved sample');
  expect(container.textContent).toContain('No conflict found does not prove the caption is true');
  expect(container.textContent).toContain('does not verify the entire video or its audio');
});
