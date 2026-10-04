/** @vitest-environment jsdom */
import React, {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {CasebookShell,CoverActions} from './CasebookShell';
import {ChapterTourStep} from './ChapterTour';
import {SourceLinkedAnswer} from './SourceLinkedAnswer';
import {SourceMap} from './SourceMap';
import {Changes} from './Casebook';
import {assessClaimSource,buildClaimReport} from '@/lib/research/claim-report';
import {inquiryCase,researchWorkflow} from '@/lib/research/workflow';
import {parseResearchCaseView} from '@/lib/research/client';
const navigation = vi.hoisted(() => ({push:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>navigation}));
vi.mock('next/link',()=>({default:(props:React.AnchorHTMLAttributes<HTMLAnchorElement>)=>React.createElement('a',props)}));
let root:Root, container:HTMLDivElement;
beforeEach(()=>{vi.stubGlobal('React',React);vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);sessionStorage.clear();container=document.createElement('div');document.body.append(container);root=createRoot(container);navigation.push.mockClear();});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
function fixture() {
  const question='What explains UPI payment growth in India?';
  const record=inquiryCase(researchWorkflow({kind:'start',operationId:'chapter-test',question,createdAt:'2026-10-01T00:00:00Z'}).document.workspace);
  record.evidence=[{id:'one',sourceUrl:'https://one.example.org/report',title:'Payment research',content:{kind:'text',text:'UPI payment growth in India increased because interoperable applications lowered transaction costs.',attribution:'page_quote'},publicationDate:{status:'unknown',reason:'No date'},provenance:{method:'page_extraction',toolVersion:null,capturedAt:null,retrievedAt:'2026-10-01T00:00:00Z',rights:'unknown',retention:'reference_only',contentHash:null}}];
  const claimReport=buildClaimReport(question,record,[assessClaimSource(record.evidence[0],null,null)]);
  return researchWorkflow({kind:'import_case',operationId:'chapter-import',question,createdAt:record.createdAt,caseRecord:record,claimReport});
}
it('pauses automatic chapter navigation when someone interacts with the evidence and retains the case in watch navigation',async()=>{
  vi.useFakeTimers();const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  await act(async()=>root.render(React.createElement(CasebookShell,{chapter:'evidence',caseId:'saved-case',children:React.createElement('main',null,React.createElement('button',null,'Inspect'))})));
  expect(container.querySelector('a[href="/watch?case=saved-case"]')).not.toBeNull();
  await act(async()=>container.querySelector<HTMLButtonElement>('[aria-label="Play the guided tour"]')?.click());
  await act(async()=>{vi.advanceTimersByTime(24_000);});expect(navigation.push).toHaveBeenLastCalledWith('/casebook?case=saved-case&chapter=sources');
  navigation.push.mockClear();await act(async()=>container.querySelector<HTMLButtonElement>('main button')?.click());
  await act(async()=>vi.advanceTimersByTime(36_000));expect(navigation.push).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
});
it('plays through real retained source selections, pauses for inspection, and stops advancing while the tab is hidden',async()=>{
  vi.useFakeTimers();const hidden=vi.spyOn(document,'hidden','get').mockReturnValue(false);
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  const initial=parseResearchCaseView(fixture()),one=initial.caseRecord.evidence[0];
  const record={...initial.caseRecord,evidence:[one,{...one,id:'two',sourceUrl:'https://two.example.org/report',title:'Another payment report'}]};
  const report=buildClaimReport(initial.question,record,record.evidence.map(e=>assessClaimSource(e,null,null)));
  const view=parseResearchCaseView(researchWorkflow({kind:'import_case',operationId:'tour-import',question:initial.question,createdAt:record.createdAt,caseRecord:record,claimReport:report}));
  await act(async()=>root.render(React.createElement(CasebookShell,{chapter:'sources',caseId:view.caseId,children:React.createElement('main',null,React.createElement(SourceMap,{view,onInspect:vi.fn(),onCitation:vi.fn()}))})));
  await act(async()=>container.querySelector<HTMLButtonElement>('[aria-label="Play the guided tour"]')?.click());
  await act(async()=>vi.advanceTimersByTime(4500));
  expect(container.querySelector('.source-map-node[aria-pressed=true]')?.textContent).toContain('Another payment report');
  hidden.mockReturnValue(true);await act(async()=>vi.advanceTimersByTime(36_000));expect(navigation.push).not.toHaveBeenCalled();
  hidden.mockReturnValue(false);
  await act(async()=>container.querySelector<HTMLButtonElement>('.source-map-node')?.click());
  await act(async()=>vi.advanceTimersByTime(36_000));
  expect(container.querySelector('.source-map-node[aria-pressed=true]')?.textContent).toContain('Payment research');
  expect(navigation.push).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
});
it('keeps the answer assertions bound to original retained text and URL after a source correction',async()=>{
  const initial=fixture(),original=initial.document.workspace.collection.cases[0].evidence[0];
  const corrected=researchWorkflow({kind:'update',document:initial.document,operationId:'correct',expectedRevision:1,change:{kind:'evidence',value:{...original,sourceUrl:'https://new.example.org/changed',content:{kind:'text',text:'A different current record.',attribution:'page_quote'}},assets:[]}});
  await act(async()=>root.render(React.createElement(SourceLinkedAnswer,{view:parseResearchCaseView(corrected)})));
  expect(container.textContent).toContain('Needs review. These assertions come from the original report’s retained evidence');expect(container.textContent).toContain(original.content.kind==='text'?original.content.text:'');
  expect(container.querySelector('a[href="https://one.example.org/report"]')).not.toBeNull();expect(container.querySelector('a[href="https://new.example.org/changed"]')).toBeNull();
  expect(container.textContent).toContain('Quoted from retained sources');
});
it('leaves unlinked reporting origins unresolved rather than drawing an inferred citation edge',async()=>{
  const view=parseResearchCaseView(fixture());
  await act(async()=>root.render(React.createElement(SourceMap,{view,onInspect:vi.fn(),onCitation:vi.fn()})));
  expect(container.querySelectorAll('.source-map-canvas svg>path')).toHaveLength(0);expect(container.textContent).toContain('Lineage unresolved');expect(container.textContent).toContain('0 inspected references');
});

it('starts the authored cover tour immediately and the chapter chooser pauses it without provider requests',async()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  await act(async()=>root.render(React.createElement(CasebookShell,{children:React.createElement('main',null,React.createElement(CoverActions))})));
  await act(async()=>{const button=[...container.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent?.includes('Walk through the casebook'));button?.click();});
  expect(navigation.push).toHaveBeenLastCalledWith('/investigate');
  expect(sessionStorage.getItem('contexttrail.chapter-tour')).toBe('playing');
  await act(async()=>{const button=[...container.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Choose a chapter');button?.click();});
  expect(document.querySelector('[role=dialog]')?.textContent).toContain('Come in through any question.');
  expect(sessionStorage.getItem('contexttrail.chapter-tour')).toBeNull();expect(fetch).not.toHaveBeenCalled();
});
it('uses the authored evidence selection interval and resumes the remaining reading time after inspection',async()=>{
  vi.useFakeTimers();vi.spyOn(document,'hidden','get').mockReturnValue(false);
  await act(async()=>root.render(React.createElement(CasebookShell,{chapter:'evidence',children:React.createElement('main',null,React.createElement(ChapterTourStep.Consumer,{children:(step:number|null)=>React.createElement('p',{'data-step':step},String(step))}))})));
  await act(async()=>container.querySelector<HTMLButtonElement>('[aria-label="Play the guided tour"]')?.click());
  await act(async()=>vi.advanceTimersByTime(4500));expect(container.querySelector('[data-step]')?.textContent).toBe('0');
  await act(async()=>vi.advanceTimersByTime(3000));expect(container.querySelector('[data-step]')?.textContent).toBe('1');
  await act(async()=>container.querySelector<HTMLButtonElement>('[aria-label="Pause the guided tour"]')?.click());
  await act(async()=>vi.advanceTimersByTime(30_000));expect(navigation.push).not.toHaveBeenCalled();
  await act(async()=>container.querySelector<HTMLButtonElement>('[aria-label="Play the guided tour"]')?.click());
  await act(async()=>vi.advanceTimersByTime(16_250));expect(navigation.push).not.toHaveBeenCalled();
  await act(async()=>vi.advanceTimersByTime(250));expect(navigation.push).toHaveBeenLastCalledWith('/casebook?chapter=sources');
});
it('keeps a selected case available when returning to the cover',async()=>{
  sessionStorage.setItem('contexttrail.chapter-case','a-retained-case');
  await act(async()=>root.render(React.createElement(CasebookShell,{children:React.createElement('main')})));
  expect(container.querySelector('a[href="/casebook?case=a-retained-case&chapter=evidence"]')).not.toBeNull();
  expect(container.querySelector('a[href="/watch?case=a-retained-case"]')).not.toBeNull();
});

it('opens video intake for a text case instead of an empty recording chapter',async()=>{
  await act(async()=>root.render(React.createElement(CasebookShell,{chapter:'evidence',caseId:'text-case',children:React.createElement('main')})));
  expect(container.querySelector('nav[aria-label="Chapters"] a[href="/video"]')).not.toBeNull();
  expect(container.querySelector('a[href="/casebook?case=text-case&chapter=video"]')).toBeNull();
});
it('keeps the saved video chapter available for an actual media case',async()=>{
  await act(async()=>root.render(React.createElement(CasebookShell,{chapter:'evidence',caseId:'media-case',mediaCase:true,children:React.createElement('main')})));
  expect(container.querySelector('a[href="/casebook?case=media-case&chapter=video"]')).not.toBeNull();
});
it('reflows the reading surface on a phone instead of shrinking the entire casebook',async()=>{
  vi.stubGlobal('innerWidth',390);vi.stubGlobal('innerHeight',844);
  await act(async()=>root.render(React.createElement(CasebookShell,{chapter:'questions',children:React.createElement('main')})));
  expect(container.querySelector('.desktop-folio')).toBeNull();
});

it('shows the actual starting snapshot without inventing a blank before comparison',async()=>{
  await act(async()=>root.render(React.createElement(Changes,{view:parseResearchCaseView(fixture())})));
  expect(container.querySelectorAll('.revision-paper')).toHaveLength(1);
  expect(container.textContent).toContain('first retained version');
  expect(container.textContent).toContain('No later source correction is recorded');
  expect(container.textContent).not.toContain('Before this source was retained');
});
