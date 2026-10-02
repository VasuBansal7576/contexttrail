import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { syntheticPng } from '../video/matching/fixtures';
import { compareSuppliedMedia } from '../video/matching/application';
import { localResearchService } from './service';
import { parseResearchDocument } from './workflow';
import { parseResearchCaseView } from './client';
import { parseSavedComparison } from './saved-comparison';
it('retains a real decoded video/still comparison across disk reopen and later edits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ct-comparison-save-'));
  try {
    const bytes = syntheticPng(912); await writeFile(join(directory, 'frame.png'), bytes);
    execFileSync('ffmpeg', ['-v', 'error', '-loop', '1', '-i', join(directory, 'frame.png'), '-t', '1', '-an', '-threads', '1', '-c:v', 'mpeg4', '-pix_fmt', 'yuv420p', join(directory, 'clip.mp4')], { timeout: 10000 });
    const comparison = await compareSuppliedMedia({ left: { kind: 'image', bytes, rights: 'user_provided' }, right: { kind: 'video', bytes: await readFile(join(directory, 'clip.mp4')), rights: 'user_provided' } }, new AbortController().signal);
    expect(parseSavedComparison(comparison)).toEqual(comparison);
    const service = localResearchService(join(directory, 'cases'));
    const input = { kind: 'import_comparison', operationId: 'actual-native-comparison', question: 'What overlaps?', createdAt: '2026-10-02T00:00:00Z', comparison };
    const saved = await service.apply(input), id = saved.document.workspace.inquiry.caseId;
    expect(saved.document.schemaVersion).toBe('contexttrail-research-v3');
    expect(parseResearchCaseView(saved).comparison).toEqual(comparison);
    const reopened = await localResearchService(join(directory, 'cases')).get(id);
    expect(reopened).toEqual(saved);
    expect(parseResearchDocument(JSON.parse(JSON.stringify(saved.document)))).toEqual(saved.document);
    const updated = await service.apply({ kind: 'update', caseId: id, expectedRevision: 1, operationId: 'question', change: { kind: 'subquestion', value: { kind: 'subquestion', id: 'q2', question: 'Which moments were not sampled?' } } });
    expect(parseResearchCaseView(updated).comparison).toEqual(comparison);
    expect(await service.apply(input)).toEqual(updated);
    // A fresh browser/session has a new save timestamp for the exact same report.
    const freshSession = { ...input, createdAt: '2026-10-02T03:00:00Z' };
    const freshService = localResearchService(join(directory, 'cases'));
    expect(await freshService.apply(freshSession)).toEqual(updated);
    expect(parseResearchCaseView(await freshService.get(id)).createdAt).toBe(input.createdAt);
    await expect(freshService.apply({ ...freshSession, question: 'A changed question?' })).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    const corrupted = structuredClone(comparison); corrupted.frames.right[0].base64 = comparison.frames.left[0].base64;
    expect(() => parseSavedComparison(corrupted)).toThrow('hash');
    await expect(service.apply({ ...input, operationId: 'bad', comparison: corrupted })).rejects.toThrow('hash');
    const changed = structuredClone(comparison); changed.report.limitations.push('Extra limitation');
    await expect(service.apply({ ...input, comparison: changed })).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    expect((await service.list()).cases).toHaveLength(1);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30000);
