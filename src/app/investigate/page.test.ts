/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import InvestigatePage from './page';
import { useInvestigation, type InvestigationSnapshot } from '@/lib/stream/useInvestigation';
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/stream/useInvestigation', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/stream/useInvestigation')>();
  return { ...actual, useInvestigation: vi.fn(), readCachedResult: () => null };
});
vi.mock('next/link', () => ({ default: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => React.createElement('a', props) }));
let root: Root, container: HTMLDivElement;
const scrollTo = vi.fn();
const start = vi.fn(async () => {}), reset = vi.fn(), cancel = vi.fn();
function snapshot(overrides: Partial<InvestigationSnapshot> = {}): InvestigationSnapshot {
  return { phase:'upload', investigationId:null, stages:[], searchCounts:[], evidence:[], classifications:{}, partialTimeline:null, preliminaryVerdict:null, divergence:null, result:null, error:null, ...overrides };
}
async function render(state: InvestigationSnapshot) {
  vi.mocked(useInvestigation).mockReturnValue({...state,start,reset,cancel});
  await act(async () => root.render(React.createElement(InvestigatePage)));
}
beforeEach(() => {
  vi.stubGlobal('React', React); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  scrollTo.mockReset(); start.mockClear(); reset.mockClear(); cancel.mockClear();
  Object.defineProperty(window,'scrollTo',{value:scrollTo,configurable:true});
  Object.defineProperty(window,'matchMedia',{value:()=>({matches:true,addListener:vi.fn(),removeListener:vi.fn(),addEventListener:vi.fn(),removeEventListener:vi.fn()}),configurable:true});
  container=document.createElement('div');document.body.append(container);root=createRoot(container);
});
afterEach(async () => { await act(async()=>root.unmount());container.remove();vi.unstubAllGlobals(); });
it('focuses and resets the new image view once, without moving on streamed updates or result tabs', async () => {
  await render(snapshot()); expect(scrollTo).not.toHaveBeenCalled();
  await render(snapshot({phase:'preparing'}));
  expect(document.activeElement).toBe(container.querySelector('h1'));
  expect(document.activeElement?.textContent).toBe('Tracing the web…');
  expect(scrollTo).toHaveBeenCalledTimes(1);
  expect(scrollTo).toHaveBeenLastCalledWith({top:0,left:0,behavior:'instant'});
  const cancelControl=[...container.querySelectorAll('button')].find(button=>button.textContent?.includes('Cancel investigation'));
  cancelControl?.focus();
  await render(snapshot({phase:'streaming',evidence:[{id:'lead',title:'Offline lead'}]}));
  expect(document.activeElement).toBe(cancelControl);expect(scrollTo).toHaveBeenCalledTimes(1);
  await render(snapshot({phase:'completed',result:{mode:'trace',timeline:[],supportingEvidence:[],contextualEvidence:[]}}));
  expect(document.activeElement).toBe(container.querySelector('h1'));expect(scrollTo).toHaveBeenCalledTimes(2);
  const tabs=[...container.querySelectorAll<HTMLButtonElement>('[role=tab]')];
  expect(tabs.map(tab=>tab.textContent)).toEqual(['Overview','Timeline','Sources','Analysis']);
  for(const tab of tabs) { expect(tab.classList.contains('whitespace-nowrap')).toBe(true);expect(tab.classList.contains('shrink-0')).toBe(true); }
  tabs[0]?.focus();
  await act(async()=>tabs[0]?.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})));
  expect(document.activeElement).toBe(tabs[1]);expect(tabs[1]?.getAttribute('aria-selected')).toBe('true');expect(scrollTo).toHaveBeenCalledTimes(2);
});
it('reveals failure and cancellation once and keeps the selected image and caption for retry', async()=>{
  await render(snapshot());
  await act(async()=>[...container.querySelectorAll('button')].find(button=>button.textContent?.includes("NASA's public Earthrise"))?.click());
  const field=container.querySelector<HTMLTextAreaElement>('#ct-claim');
  if(!field) throw new Error('Missing caption input');
  await act(async()=>{ Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set?.call(field,'QA_SLOW');field.dispatchEvent(new Event('input',{bubbles:true})); });
  await render(snapshot({phase:'failed',error:{code:'OFFLINE_TEST',message:'Held offline test failed',partial:true}}));
  expect(document.activeElement?.textContent).toBe('Investigation interrupted.');expect(scrollTo).toHaveBeenCalledTimes(1);
  const retry=[...container.querySelectorAll('button')].find(button=>button.textContent?.includes('Return to upload'));
  expect(retry?.closest('.casebook-app')).not.toBeNull();expect(retry?.classList.contains('paper-button')).toBe(true);
  await act(async()=>retry?.click());expect(reset).toHaveBeenCalledTimes(1);
  await render(snapshot());
  expect(container.querySelector<HTMLTextAreaElement>('#ct-claim')?.value).toBe('QA_SLOW');
  await act(async()=>container.querySelector('form')?.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  expect(start).toHaveBeenCalledWith({publicImageId:'nasa-earthrise',claim:'QA_SLOW'});
  await render(snapshot({phase:'cancelled'}));
  expect(document.activeElement?.textContent).toBe('Investigation cancelled.');expect(scrollTo).toHaveBeenCalledTimes(2);
  const actions=[...container.querySelectorAll('main button')];
  expect(actions).toHaveLength(2);for(const button of actions) expect(button.classList.contains('paper-button')).toBe(true);
});
it('presents an ended stream as stopped instead of waiting or running, while retaining received evidence', async()=>{
  await render(snapshot({phase:'failed',error:{code:'stream_terminated',message:'The stream ended before a result arrived.',partial:false}}));
  expect(container.textContent).toContain('No evidence was received before this investigation stopped.');
  expect(container.textContent).toContain('No start recorded');
  expect(container.textContent).not.toContain('Waiting');
  expect(container.textContent).not.toContain('Canceling stops');
  expect(container.querySelector('[aria-label="Evidence arriving live"]')).toBeNull();
  expect(container.querySelector('[role=alert]')?.classList.contains('investigation-failure')).toBe(true);
  const stoppedSnapshot = snapshot({phase:'failed',error:{code:'stream_terminated',message:'The stream ended.',partial:true},stages:[{name:'CLIENT_PREPROCESS',label:'Upload image',status:'completed',detail:null},{name:'INITIAL_RETRIEVAL',label:'Reverse image search',status:'running',detail:null}],evidence:[{id:'retained',title:'Retained offline source'}]});
  await render(stoppedSnapshot);
  expect(container.textContent).toContain('Retained offline source');
  expect(container.textContent).toContain('Interrupted');
  expect(container.textContent).toContain('Completed');
  expect(container.textContent).not.toContain('In progress…');
  expect(container.querySelector('[aria-label="Evidence retained before interruption"]')?.getAttribute('aria-live')).toBe('off');
  expect(container.querySelector('.animate-pulse')).toBeNull();
  expect(scrollTo).toHaveBeenCalledTimes(1);
});
it('bounds partial-error grid columns while preserving complete long stage details and candidate titles', async()=>{
  const detail='QA offline fixture: preparation completed. '+ 'LongUnbrokenStageDetail'.repeat(30)+' STAGE END';
  const title='Long retained candidate '+ 'UnbrokenCandidateTitle'.repeat(30)+' TITLE END';
  await render(snapshot({phase:'failed',error:{code:'stream_terminated',message:'Offline partial interruption.',partial:true},stages:[{name:'CLIENT_PREPROCESS',label:'Preparing image',status:'completed',detail}],evidence:[{id:'first',title,domain:'example.com'},{id:'second',title:'Second retained candidate',domain:'example.org'}]}));
  const grid=container.querySelector('.investigation-work-grid');
  expect(grid?.classList.contains('grid-cols-[minmax(0,1fr)]')).toBe(true);
  const columns=grid?.querySelectorAll(':scope > section');
  expect(columns).toHaveLength(2);
  columns?.forEach(column=>expect(column.classList.contains('min-w-0')).toBe(true));
  expect(container.querySelector('.investigation-detail')?.textContent).toBe(`Last reported detail: ${detail}`);
  expect(container.querySelector('.investigation-candidate-title')?.textContent).toBe(title);
  expect(grid?.querySelector('[class*=truncate],[class*=line-clamp]')).toBeNull();
  expect(container.querySelectorAll('.progress-evidence article')).toHaveLength(2);
  expect(scrollTo).toHaveBeenCalledTimes(1);
});

it('rejects credential or query-bearing public image URLs before starting an investigation', async()=>{
  await render(snapshot());
  const url = container.querySelector<HTMLInputElement>('#ct-public-url');
  if(!url) throw new Error('Missing public URL field');
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set?.call(url,'https://example.org/photo.jpg?token=private');url.dispatchEvent(new Event('input',{bubbles:true}));});
  await act(async()=>[...container.querySelectorAll('button')].find(button=>button.textContent?.includes('Use public image URL'))?.click());
  expect(container.querySelector('[role=alert]')?.textContent).toContain('without login, tokens, query parameters');
  expect(url.getAttribute('aria-invalid')).toBe('true');
  expect(start).not.toHaveBeenCalled();
  expect(container.querySelector<HTMLInputElement>('#ct-image-input')).not.toBeNull();
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set?.call(url,'https://example.org/photo.jpg');url.dispatchEvent(new Event('input',{bubbles:true}));});
  await act(async()=>[...container.querySelectorAll('button')].find(button=>button.textContent?.includes('Use public image URL'))?.click());
  expect(container.textContent).toContain('Its preview is checked when the investigation starts.');
  expect(container.querySelector('.image-specimen-sheet img')).toBeNull();
  expect(container.querySelector<HTMLInputElement>('#ct-image-input')).not.toBeNull();
});
it('requires a caption when that intent is selected, while keeping trace available', async()=>{
  await render(snapshot());
  const click = async(text:string)=>act(async()=>[...container.querySelectorAll('button')].find(button=>button.textContent?.includes(text))?.click());
  await click("NASA's public Earthrise");await click('Check its attached caption');
  expect(container.querySelector<HTMLButtonElement>('button[type=submit]')?.disabled).toBe(true);
  await act(async()=>container.querySelector('form')?.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  expect(start).not.toHaveBeenCalled();
  await click('Trace this photograph');
  expect(container.querySelector<HTMLButtonElement>('button[type=submit]')?.disabled).toBe(false);
  await act(async()=>container.querySelector('form')?.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  expect(start).toHaveBeenCalledWith({publicImageId:'nasa-earthrise',claim:null});
});
