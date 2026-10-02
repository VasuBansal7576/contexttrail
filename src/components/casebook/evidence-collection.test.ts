/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EvidenceCollection, EvidencePassage, SourceActions, safeSourceUrl } from './EvidenceCollection';
let root: Root, container: HTMLDivElement;
beforeEach(() => { vi.stubGlobal('React', React); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: vi.fn(), configurable: true }); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it('bounds 103 records and keeps the final record reachable with keyboard-safe paging', async () => {
 const items = Array.from({length:103}, (_, index) => index);
 await act(async () => root.render(React.createElement(EvidenceCollection<number>, { items, label:'Sources', children: item => React.createElement('article', {key:item}, `Record ${item}`) })));
 expect(container.querySelectorAll('article')).toHaveLength(8);
 for (let page=0; page<12; page++) await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === 'Next')?.click(); });
 expect(container.textContent).toContain('Record 102'); expect(container.querySelectorAll('article')).toHaveLength(7);
 expect(document.activeElement).toBe(container.querySelector('.evidence-collection'));
 expect([...container.querySelectorAll('button')].find(button => button.textContent === 'Next')?.disabled).toBe(true);
});
it('keeps complete long text behind an explicit disclosure without dropping its tail', async () => {
 const text='Unbroken'.repeat(500)+' UNIQUE END';
 await act(async () => root.render(React.createElement(EvidencePassage, {text})));
 const details=container.querySelector('details'); expect(details?.open).toBe(false); expect(container.querySelector('details > p')?.textContent).toBe(text);
});
it('displays exact URLs and never opens a source on render or title inspection', async () => {
 const url='https://example.com/path?exact=a%20b'; const open=vi.spyOn(window,'open');
 await act(async () => root.render(React.createElement(SourceActions, {url})));
 expect(container.querySelector('.source-url')?.textContent).toBe(url); expect(container.querySelector('a')?.getAttribute('href')).toBe(url); expect(container.querySelector('a')?.target).toBe('_blank'); expect(open).not.toHaveBeenCalled(); open.mockRestore();
 expect(safeSourceUrl('javascript:alert(1)')).toBeNull(); expect(safeSourceUrl('https://user:secret@example.com')).toBeNull(); expect(safeSourceUrl('/internal')).toBeNull();
});
it('renders no paging for empty results', async () => {
 await act(async () => root.render(React.createElement(EvidenceCollection<number>, {items:[],label:'Sources',children:item=>String(item)})));
 expect(container.querySelector('nav')).toBeNull();
});
it('renders the large offline response through the real parser and actual result UI', async () => {
 const { createLargeResearchResult } = await import('../../../scripts/fixtures/large-research-result.mjs');
 const { parseAutomaticResearchResult } = await import('@/lib/research/automatic-client');
 const { AutomaticResult } = await import('./AutomaticResearch');
 const result = parseAutomaticResearchResult(createLargeResearchResult());
 await act(async () => root.render(React.createElement(AutomaticResult,{result})));
 expect(result.caseRecord.evidence).toHaveLength(103);
 expect(result.caseRecord.evidence[0].sourceUrl.length).toBeGreaterThan(300);
 expect(result.caseRecord.evidence[0].title).toContain('VeryLongUnbrokenSourceTitle'.repeat(12));
 expect(createLargeResearchResult()).toEqual(createLargeResearchResult());
 expect(container.querySelectorAll('.automatic-source')).toHaveLength(8);
 expect(container.querySelector('.source-inspection')?.hasAttribute('open')).toBe(false);
 expect(container.querySelector('a')?.textContent).toContain('Open in new tab');
 for(let i=0;i<12;i++) await act(async () => { [...container.querySelectorAll('button')].find(button=>button.textContent==='Next')?.click(); });
 expect(container.textContent).toContain('FINAL RECORD 103');
});
