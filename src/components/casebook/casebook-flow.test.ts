/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localResearchService } from '@/lib/research/service';
import Casebook from './Casebook';

const navigation = vi.hoisted(() => ({ search: '', next: '' }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(navigation.search), useRouter: () => ({ push: (url: string) => { navigation.next = url; } }) }));
vi.mock('next/link', () => ({ default: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => React.createElement('a', props) }));

let directory: string, root: Root, container: HTMLDivElement, store: ReturnType<typeof localResearchService>;
let posts: unknown[];
async function settle() { await act(async () => { await new Promise(done => setTimeout(done, 35)); }); }
function button(name: string): HTMLButtonElement { const result = [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === name); if (!result) throw new Error(`Missing button: ${name}. ${document.body.textContent}`); return result; }
async function click(name: string) { await act(async () => { button(name).click(); }); await settle(); }
function field(label: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const parent = [...document.querySelectorAll('label')].find(item => item.childNodes[0]?.textContent?.trim() === label);
  const result = parent?.querySelector('input,textarea,select');
  if (!(result instanceof HTMLInputElement || result instanceof HTMLTextAreaElement || result instanceof HTMLSelectElement)) throw new Error(`Missing field: ${label}`);
  return result;
}
async function fill(label: string, value: string) {
  const target = field(label), prototype = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : target instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(target,value); target.dispatchEvent(new Event('input',{bubbles:true})); target.dispatchEvent(new Event('change',{bubbles:true})); });
}
async function submit() { const form=document.querySelector('[role=dialog] form'); if (!form) throw new Error('Missing dialog form');await act(async()=>{form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});await settle(); for(let attempt=0;attempt<80 && document.querySelector('[role=dialog] button[type=submit]:disabled, [role=dialog] .primary:disabled');attempt++) await settle(); }
async function render(search='') { navigation.search=search;await act(async()=>root.render(React.createElement(Casebook)));await settle(); }
beforeEach(async()=>{
  vi.stubGlobal('React',React);vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  directory=await mkdtemp(join(tmpdir(),'ct-casebook-ui-'));store=localResearchService(directory);posts=[];navigation.search='';navigation.next='';container=document.createElement('div');document.body.append(container);root=createRoot(container);
  vi.stubGlobal('fetch',vi.fn(async(input: string, init?: RequestInit)=>{
    if(init?.signal?.aborted)throw new DOMException('Aborted','AbortError');
    const url=new URL(input,'http://localhost');
    try {
      if(init?.method==='POST'){const body:unknown=JSON.parse(String(init.body));posts.push(body);return Response.json(await store.apply(body));}
      const id=url.searchParams.get('caseId');return Response.json(id?await store.get(id):{cases:await store.list()});
    }catch(error){return Response.json({error:error instanceof Error?error.message:'Error',code:'TEST_REQUEST_REJECTED'},{status:400});}
  }));
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.unstubAllGlobals();await rm(directory,{recursive:true,force:true});});

describe('casebook application flow against real local storage, without a rendered browser',()=>{
  it('cancels creation without saving, then creates and reopens a case',async()=>{
    await render();await click('Start a question');await fill('Research question','Synthetic bridge question?');await click('Cancel');expect(posts).toHaveLength(0);expect(await store.list()).toHaveLength(0);
    await click('Start a question');await fill('Research question','Synthetic bridge question?');await submit();expect(await store.list()).toHaveLength(1);expect(navigation.next).toContain('/casebook?case=');await render(navigation.next.split('?')[1]);expect(document.body.textContent).toContain('Synthetic bridge question?');expect(document.body.textContent).toContain('No findings yet.');
  });
  it('saves hypotheses, passage evidence, an exact finding, and a correction that marks review stale',async()=>{
    const started=await store.apply({kind:'start',operationId:'ui-start',question:'Synthetic bridge question?',createdAt:'2026-10-01T00:00:00Z'});const id=started.document.workspace.inquiry.caseId;await render(`case=${encodeURIComponent(id)}&chapter=questions`);
    await click('Add explanation');await fill('Possible explanation','Opening and inspection were separate.');await submit();expect(document.body.textContent).toContain('Opening and inspection were separate.');
    await render(`case=${encodeURIComponent(id)}&chapter=evidence`);await click('Add evidence');await fill('Source title','Synthetic bridge record');await fill('Source URL','https://synthetic.example/bridge');await fill('Retained passage','The bridge opened on Monday. Inspection is pending.');await act(async()=>{document.querySelector<HTMLInputElement>('input[type=checkbox]')?.click();});await submit();expect(document.querySelector('[role=dialog]')).toBeNull();
    const evidenceButton=[...document.querySelectorAll<HTMLButtonElement>('button')].find(item=>item.classList.contains('evidence-row'));expect(evidenceButton).toBeTruthy();await act(async()=>evidenceButton?.click());await settle();await click('Add a finding');await fill('Finding','The source says Monday.');await fill('Exact quote','The bridge opened on Monday.');await fill('Reviewer','Synthetic reviewer');await fill('Review rationale','Exact supplied passage, no independent verification.');await submit();let saved=await store.get(id);expect(saved.findings[0].reviewStatus).toBe('current');expect(saved.findings[0].support[0].anchor).toEqual({kind:'text',start:0,quote:'The bridge opened on Monday.'});
    await act(async()=>document.querySelector<HTMLButtonElement>('.evidence-row')?.click());await settle();await click('Record a correction');await fill('Retained passage','Correction: the bridge opened on Tuesday.');await act(async()=>{document.querySelector<HTMLInputElement>('input[type=checkbox]')?.click();});await submit();saved=await store.get(id);expect(saved.findings[0].reviewStatus).toBe('needs_review');
    await render(`case=${encodeURIComponent(id)}&chapter=questions`);expect(document.body.textContent).toContain('Needs review');await click('Read the exact evidence');expect(document.querySelector('mark')?.textContent).toBe('The bridge opened on Monday.');expect(document.body.textContent).toContain('exact historical source revision is not resolved here');
  });
  it('saves a retained table and preserves literal empty cells',async()=>{
    const started=await store.apply({kind:'start',operationId:'ui-table',question:'Synthetic counts?',createdAt:'2026-10-01T00:00:00Z'});const id=started.document.workspace.inquiry.caseId;await render(`case=${encodeURIComponent(id)}&chapter=evidence`);await click('Add evidence');await fill('Evidence type','table');await fill('Source title','Synthetic counts');await fill('Source URL','https://synthetic.example/counts');await fill('Table with column headers','Year\tCount\n2024\t18\n2025\t');await act(async()=>document.querySelector<HTMLInputElement>('input[type=checkbox]')?.click());await submit();const saved=await store.get(id);expect(saved.document.workspace.schemaVersion).toBe('contexttrail-inquiry-v2');if(saved.document.workspace.schemaVersion==='contexttrail-inquiry-v2')expect(saved.document.workspace.materials.versions[0].content).toEqual({kind:'table',columns:['Year','Count'],rows:[['2024','18'],['2025','']]});
  });
  it('retries a lost creation response with the same operation instead of duplicating the case',async()=>{
    const original=fetch;let lose=true;vi.stubGlobal('fetch',vi.fn(async(input:string,init?:RequestInit)=>{const response=await original(input,init);if(init?.method==='POST'&&lose){lose=false;throw new TypeError('Synthetic lost response');}return response;}));
    await render();await click('Start a question');await fill('Research question','Synthetic uncertain creation?');await submit();expect(document.body.textContent).toContain('Synthetic lost response');expect(await store.list()).toHaveLength(1);await submit();expect(await store.list()).toHaveLength(1);expect(navigation.next).toContain('/casebook?case=');expect(posts).toHaveLength(2);expect(posts[0]).toEqual(posts[1]);
  });
  it('reconciles a lost committed edit and keeps a conflicting draft while loading latest revision',async()=>{
    const started=await store.apply({kind:'start',operationId:'ui-recovery',question:'Synthetic save recovery?',createdAt:'2026-10-01T00:00:00Z'});const id=started.document.workspace.inquiry.caseId;await render(`case=${encodeURIComponent(id)}&chapter=questions`);
    const original=fetch;let lose=true;vi.stubGlobal('fetch',vi.fn(async(input:string,init?:RequestInit)=>{const response=await original(input,init);if(init?.method==='POST'&&lose){lose=false;throw new TypeError('Synthetic lost response');}return response;}));
    await click('Add explanation');await fill('Possible explanation','A committed explanation.');await submit();expect(document.querySelector('[role=dialog]')).toBeNull();expect((await store.get(id)).document.workspace.hypotheses).toHaveLength(1);expect(document.body.textContent).toContain('Save confirmed after reopening');
    await click('Add explanation');await fill('Possible explanation','The draft survives a concurrent edit.');const current=await store.get(id);await store.apply({kind:'update',caseId:id,operationId:'concurrent',expectedRevision:current.document.revision,change:{kind:'subquestion',value:{kind:'subquestion',id:'q-concurrent',question:'Another reviewer question?'}}});await submit();expect(field('Possible explanation').value).toBe('The draft survives a concurrent edit.');expect(document.body.textContent).toContain('latest saved revision is loaded');await submit();expect(document.querySelector('[role=dialog]')).toBeNull();expect((await store.get(id)).document.workspace.hypotheses).toHaveLength(2);
  });
  it('re-retains a corrected table and preserves its exact selected cell on re-review',async()=>{
    const started=await store.apply({kind:'start',operationId:'ui-correct-table',question:'Synthetic table review?',createdAt:'2026-10-01T00:00:00Z'});const id=started.document.workspace.inquiry.caseId;await render(`case=${encodeURIComponent(id)}&chapter=evidence`);await click('Add evidence');await fill('Evidence type','table');await fill('Source title','Synthetic counts');await fill('Source URL','https://synthetic.example/counts');await fill('Table with column headers','Year\tCount\n2024\t18\n2025\t20');await act(async()=>document.querySelector<HTMLInputElement>('input[type=checkbox]')?.click());await submit();await act(async()=>document.querySelector<HTMLButtonElement>('.evidence-row')?.click());await settle();await click('Add a finding');await fill('Finding','The retained second count is twenty.');await fill('Data row','1');await fill('Column','1');await fill('Reviewer','Synthetic reviewer');await fill('Review rationale','Literal second row.');await submit();
    await act(async()=>document.querySelector<HTMLButtonElement>('.evidence-row')?.click());await settle();await click('Record a correction');await fill('Source title','Corrected synthetic counts title');await act(async()=>document.querySelector<HTMLInputElement>('input[type=checkbox]')?.click());await submit();let saved=await store.get(id);expect(saved.findings[0].reviewStatus).toBe('needs_review');if(saved.document.workspace.schemaVersion==='contexttrail-inquiry-v2')expect(saved.document.workspace.materials.versions.map(v=>v.revision)).toEqual([1,2]);
    await render(`case=${encodeURIComponent(id)}&chapter=questions`);await click('Review this finding again');expect(field('Data row').value).toBe('1');expect(field('Column').value).toBe('1');await fill('Review rationale','Reviewed the corrected source title and the same exact second-row cell.');await submit();saved=await store.get(id);expect(saved.findings[0].reviewStatus).toBe('current');expect(saved.findings[0].support[0].anchor).toMatchObject({kind:'table_cell',row:1,column:1,value:'20'});
  });

  it('retries a stable draft after both the write response and reconciliation read fail',async()=>{
    const started=await store.apply({kind:'start',operationId:'ui-offline',question:'Synthetic offline save?',createdAt:'2026-10-01T00:00:00Z'});const id=started.document.workspace.inquiry.caseId;await render(`case=${encodeURIComponent(id)}&chapter=questions`);
    const original=fetch;let lose=true,offline=false;vi.stubGlobal('fetch',vi.fn(async(input:string,init?:RequestInit)=>{if(offline)throw new TypeError('Synthetic offline');const response=await original(input,init);if(init?.method==='POST'&&lose){lose=false;offline=true;throw new TypeError('Synthetic lost response');}return response;}));
    await click('Add explanation');await fill('Possible explanation','Keep this exact draft.');await submit();expect(document.body.textContent).toContain('save outcome is uncertain');offline=false;await submit();expect(document.querySelector('[role=dialog]')).toBeNull();expect((await store.get(id)).document.workspace.hypotheses).toHaveLength(1);expect(posts).toHaveLength(2);expect(posts[0]).toEqual(posts[1]);
  });
  it('retries only the pending material stage and never drops newer source metadata',async()=>{
    const started=await store.apply({kind:'start',operationId:'ui-material-offline',question:'Synthetic material save?',createdAt:'2026-10-01T00:00:00Z'});const id=started.document.workspace.inquiry.caseId;await render(`case=${encodeURIComponent(id)}&chapter=evidence`);
    const original=fetch;let lose=true,offline=false;vi.stubGlobal('fetch',vi.fn(async(input:string,init?:RequestInit)=>{if(offline)throw new TypeError('Synthetic offline');const response=await original(input,init);if(init?.method==='POST'&&String(init.body).includes('"kind":"material"')&&lose){lose=false;offline=true;throw new TypeError('Synthetic lost material response');}return response;}));
    await click('Add evidence');await fill('Evidence type','table');await fill('Source title','Original synthetic title');await fill('Source URL','https://synthetic.example/retry-table');await fill('Table with column headers','Year\tCount\n2024\t18');await act(async()=>document.querySelector<HTMLInputElement>('input[type=checkbox]')?.click());await submit();expect(document.body.textContent).toContain('snapshot save could not be confirmed');offline=false;await fill('Source title','Newer unsaved title');await submit();expect(field('Source title').value).toBe('Newer unsaved title');expect(document.body.textContent).toContain('snapshot save is still unconfirmed');await fill('Source title','Original synthetic title');await submit();expect(document.querySelector('[role=dialog]')).toBeNull();const saved=await store.get(id);if(saved.document.workspace.schemaVersion!=='contexttrail-inquiry-v2')throw new Error('Missing retained material');expect(saved.document.workspace.materials.versions).toHaveLength(1);expect(saved.document.workspace.collection.cases[0].evidence[0].title).toBe('Original synthetic title');
  });
  it('does not bind supplied material to a source corrected by another writer after a lost response',async()=>{
    const started=await store.apply({kind:'start',operationId:'ui-source-race',question:'Synthetic source race?',createdAt:'2026-10-01T00:00:00Z'});const id=started.document.workspace.inquiry.caseId;await render(`case=${encodeURIComponent(id)}&chapter=evidence`);
    const original=fetch;let race=true;vi.stubGlobal('fetch',vi.fn(async(input:string,init?:RequestInit)=>{const response=await original(input,init);if(init?.method==='POST'&&String(init.body).includes('"kind":"evidence"')&&race){race=false;const saved=await store.get(id),evidence=saved.document.workspace.collection.cases[0].evidence[0];await store.apply({kind:'update',caseId:id,operationId:'other-source-correction',expectedRevision:saved.document.revision,change:{kind:'evidence',value:{...evidence,title:'Another writer source'},assets:[]}});throw new TypeError('Synthetic lost source response');}return response;}));
    await click('Add evidence');await fill('Evidence type','table');await fill('Source title','My source');await fill('Source URL','https://synthetic.example/race');await fill('Table with column headers','Year\tCount\n2024\t18');await act(async()=>document.querySelector<HTMLInputElement>('input[type=checkbox]')?.click());await submit();expect(document.body.textContent).toContain('source changed after your evidence save');const saved=await store.get(id);expect(saved.document.workspace.schemaVersion).toBe('contexttrail-inquiry-v1');expect(saved.document.workspace.collection.cases[0].evidence[0].title).toBe('Another writer source');
  });

});
