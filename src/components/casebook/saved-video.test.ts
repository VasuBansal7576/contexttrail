/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { webcrypto } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { AutomaticResult } from './AutomaticResearch';
import Casebook from './Casebook';
import { parseAutomaticResearchResult } from '@/lib/research/automatic-client';
import { localResearchService } from '@/lib/research/service';
import { videoSaveFixture } from '@/lib/research/video-save-fixture';
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('case=offline-video-save&chapter=evidence'), useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => React.createElement('a', props) }));
it('offers save for completed video, safely retries a lost response and reopens exact historical report after a correction', async () => {
  vi.stubGlobal('React', React); vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const directory = await mkdtemp(join(tmpdir(), 'ct-video-ui-')), fixture = videoSaveFixture(), result = parseAutomaticResearchResult(fixture), service = localResearchService(directory);
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const requests: unknown[] = []; let lose = true;
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    expect(path.startsWith('/api/research')).toBe(true);
    if (init.method === 'POST') {
      const body: unknown = JSON.parse(String(init.body)); requests.push(body);
      const saved = await service.apply(body);
      if (lose) { lose = false; throw new Error('Lost response'); }
      return Response.json(saved);
    }
    const id = new URL(path, 'http://localhost').searchParams.get('caseId');
    return Response.json(id ? await service.get(id) : await service.list());
  });
  const waitForUi = async (assertion: () => void) => {
    const deadline = Date.now() + 3000;
    for (;;) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
      try { assertion(); return; }
      catch (error) { if (Date.now() >= deadline) throw error; }
    }
  };
  try {
    await act(async () => root.render(React.createElement(AutomaticResult, { result })));
    expect(container.textContent).toContain('Save video report');
    expect(container.textContent).toContain('Original recording and sampled image bytes are excluded');
    await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === 'Save video report')?.click(); });
    await waitForUi(() => expect(container.textContent).toContain('Lost response')); expect(requests).toHaveLength(1);
    await act(async () => root.render(React.createElement(AutomaticResult, { result, key: 'remount' })));
    await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === 'Save video report')?.click(); });
    await waitForUi(() => expect(container.querySelector('a[href*="chapter=evidence"]')).not.toBeNull());
    expect(requests[1]).toEqual(requests[0]); expect((await service.list()).cases).toHaveLength(1);
    expect(container.querySelector('a[href*="chapter=evidence"]')).not.toBeNull();
    await act(async () => root.render(React.createElement(Casebook)));
    await waitForUi(() => expect(container.querySelector('[aria-label="Saved video report"]')?.textContent).toContain('Insufficient evidence'));
    expect(container.textContent).toContain('Synthetic offline uncertainty.');
    expect(container.textContent).not.toContain('Save video report');
    await service.apply({ kind: 'update', caseId: fixture.caseRecord.id, operationId: 'correct', expectedRevision: 1, change: { kind: 'evidence', value: { ...fixture.caseRecord.evidence[0], content: { kind: 'text', text: 'Corrected source excerpt.', attribution: 'page_quote' } }, assets: [] } });
    await act(async () => root.render(React.createElement(Casebook, { key: 'reload' })));
    await waitForUi(() => expect(container.querySelector('[aria-label="Saved video report"]')?.textContent).toContain('Needs review'));
    const report = container.querySelector('[aria-label="Saved video report"]');
    expect(report?.textContent).toContain('Needs review'); expect(report?.querySelector('details')?.open).toBe(false);
    expect(report?.textContent).toContain('Retained synthetic excerpt.'); expect(container.textContent).toContain('Corrected source excerpt.');
    expect(requests).toHaveLength(2);
  } finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); }
});
