/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { webcrypto } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import SaveToCasebook from './SaveToCasebook';
import { CasebookShell } from './CasebookShell';
import { localResearchService } from '@/lib/research/service';
import { inquiryCase, researchWorkflow } from '@/lib/research/workflow';
vi.mock('next/link', () => ({ default: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => React.createElement('a', props) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
it('saves once across double click, lost response and component remount', async () => {
  vi.stubGlobal('React', React); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('crypto', webcrypto);
  const directory = await mkdtemp(join(tmpdir(), 'ct-save-ui-')), service = localResearchService(directory);
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const record = inquiryCase(researchWorkflow({ kind: 'start', operationId: 'original', question: 'Q?', createdAt: '2026-10-01T00:00:00Z' }).document.workspace);
  const requests: unknown[] = []; let lose = true;
  vi.stubGlobal('fetch', async (_: unknown, init: RequestInit) => { const body: unknown = JSON.parse(String(init.body)); requests.push(body); const result = await service.apply(body); if (lose) { lose = false; throw new Error('Lost response'); } return Response.json(result); });
  const render = async (key: string) => act(async () => { root.render(React.createElement(SaveToCasebook, { key, value: record, question: 'Q?' })); });
  const settle = async () => act(async () => { await new Promise(r => setTimeout(r, 100)); });
  try {
    await render('first'); await act(async () => { container.querySelector('button')?.click(); container.querySelector('button')?.click(); }); await settle();
    expect(requests).toHaveLength(1); expect(container.textContent).toContain('Lost response'); expect((await service.list()).cases).toHaveLength(1);
    await render('remount'); await act(async () => container.querySelector('button')?.click()); await settle();
    expect(requests[1]).toEqual(requests[0]); expect((await service.list()).cases).toHaveLength(1); expect(container.querySelector('a')?.href).toContain('chapter=evidence');
    await act(async () => root.render(React.createElement(SaveToCasebook, { value: null, question: 'Q?' }))); expect(container.textContent).toBe('');
  } finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); }
});

it('automatically keeps a completed result through strict effects and remount without duplicating the case', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('crypto', webcrypto);
  const directory = await mkdtemp(join(tmpdir(),'ct-autosave-ui-')), service = localResearchService(directory);
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const record = inquiryCase(researchWorkflow({ kind:'start',operationId:'automatic-result',question:'A retained automatic investigation',createdAt:'2026-10-04T00:00:00Z' }).document.workspace);
  vi.stubGlobal('fetch', async (_: unknown, init: RequestInit) => Response.json(await service.apply(JSON.parse(String(init.body)))));
  sessionStorage.setItem('contexttrail.chapter-case', 'previous-case');
  const render = async (key: string) => {
    await act(async () => root.render(React.createElement(React.StrictMode, {}, React.createElement(CasebookShell,{chapter:'questions',children:React.createElement(SaveToCasebook,{key,value:record,question:'A retained automatic investigation',autoSave:true})}))));
    for (let attempt=0;attempt<50 && !container.textContent?.includes('Kept in your casebook');attempt++) await act(async () => { await new Promise(done=>setTimeout(done,20)); });
  };
  try {
    await render('first'); expect(container.textContent).toContain('Kept in your casebook');
    expect(container.querySelector('nav[aria-label="Chapters"] a[href*="chapter=evidence"]')?.getAttribute('href')).toBe(`/casebook?case=${encodeURIComponent(record.id)}&chapter=evidence`);
    expect(container.querySelector('nav[aria-label="Chapters"] a[href*="/watch"]')?.getAttribute('href')).toBe(`/watch?case=${encodeURIComponent(record.id)}`);
    expect(sessionStorage.getItem('contexttrail.chapter-case')).toBe(record.id);
    await render('second'); expect((await service.list()).cases).toHaveLength(1);
    const saved = await service.get(record.id); expect(inquiryCase(saved.document.workspace).createdAt).toBe(record.createdAt);
  } finally { await act(async()=>root.unmount()); container.remove(); sessionStorage.clear(); vi.unstubAllGlobals(); await rm(directory,{recursive:true,force:true}); }
});
