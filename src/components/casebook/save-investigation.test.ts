/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { webcrypto } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import SaveToCasebook from './SaveToCasebook';
import { localResearchService } from '@/lib/research/service';
import { inquiryCase, researchWorkflow } from '@/lib/research/workflow';
vi.mock('next/link', () => ({ default: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => React.createElement('a', props) }));
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
