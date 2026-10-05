/** @vitest-environment jsdom */
import React,{act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import Watchlists from './Watchlists';
vi.mock('next/navigation',()=>({useRouter:()=>({push:vi.fn()})}));
vi.mock('next/link',()=>({default:(props:React.AnchorHTMLAttributes<HTMLAnchorElement>)=>React.createElement('a',props)}));
let root:Root,container:HTMLDivElement;
const date='2026-10-01T00:00:00Z';
const status={version:1,workerConnected:false,running:false,checkedAt:date,watches:[{id:'watch-one',question:'What explains interoperable payment growth?',intervalHours:24,state:'paused',createdAt:date,nextCheckAt:date,lastCaseId:null,seen:[],checks:[{id:'check-one',at:date,caseId:null,error:null,baseline:false,changes:[]}]}]};
beforeEach(()=>{vi.stubGlobal('React',React);vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);container=document.createElement('div');document.body.append(container);root=createRoot(container);});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.useRealTimers();vi.unstubAllGlobals();});
it('keeps rejected watch-action feedback visible after a successful status poll',async()=>{
  vi.useFakeTimers();const fetch=vi.fn(async(_url:unknown,options?:RequestInit)=>options?.method==='POST'?Response.json({error:'The approved search allowance is exhausted.'},{status:403}):Response.json(status));vi.stubGlobal('fetch',fetch);
  await act(async()=>root.render(React.createElement(Watchlists)));
  expect(container.textContent).toContain('1 retained check');expect(container.textContent).not.toContain('1 retained checks');
  await act(async()=>container.querySelector<HTMLButtonElement>('.watch-event')?.click());
  await act(async()=>[...document.querySelectorAll('button')].find(button=>button.textContent==='Resume watch')?.click());
  expect(document.querySelector('[role=dialog]')?.textContent).toContain('approved search allowance is exhausted');
  await act(async()=>vi.advanceTimersByTime(10_000));
  expect(document.querySelector('[role=dialog]')?.textContent).toContain('approved search allowance is exhausted');
  expect(fetch.mock.calls.filter(call=>call[1]?.method==='POST')).toHaveLength(1);
});
it('does not create a watch for whitespace-only questions',async()=>{
  const fetch=vi.fn(async()=>Response.json({...status,watches:[]}));vi.stubGlobal('fetch',fetch);
  await act(async()=>root.render(React.createElement(Watchlists)));
  const question=container.querySelector('textarea');if(!question)throw new Error('Missing watch question');
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set?.call(question,'     ');question.dispatchEvent(new Event('input',{bubbles:true}));});
  expect(container.querySelector<HTMLButtonElement>('form button')?.disabled).toBe(true);
  await act(async()=>container.querySelector('form')?.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  expect(fetch).toHaveBeenCalledTimes(1);
});
