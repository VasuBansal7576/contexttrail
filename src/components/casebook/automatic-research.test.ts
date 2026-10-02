/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AutomaticResearch, { AutomaticResult } from './AutomaticResearch';
import { investigateAutomatically, type AutomaticResearchView } from '@/lib/research/automatic-client';
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
    expect(body.get('video')).toBe(file); expect(body.has('topic')).toBe(false);
    expect(container.textContent).toContain('113 questions');
  });
  it('opens timestamped frame sources with explicit incomplete coverage', async () => {
    const source = { evidenceId: 'frame-source', sourceUrl: 'https://example.com/frame', title: 'Frame source', excerpt: 'Frame passage.', dateStatus: 'unknown', observedAt: null, identityBasis: 'unknown', excerptSource: 'search_snippet', displayAttribution: null };
    await act(async () => root.render(React.createElement(AutomaticResult, { result: { ...result, kind: 'video', frames: [{ timestampMs: 1250, imageResult: { limitations: ['One frame only.'], timeline: [], undatedEvidence: [source], supportingEvidence: [], contextualEvidence: [] } }] } })));
    await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent?.startsWith('Sampled frames'))?.click(); });
    expect(container.textContent).toContain('Frame passage.'); expect(container.textContent).toContain('One frame only.'); expect(container.textContent).toContain('Identity basis: unknown'); expect(container.querySelector('a[href="https://example.com/frame"]')).not.toBeNull();
  });
});
