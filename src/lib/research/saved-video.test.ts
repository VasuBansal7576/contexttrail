import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { localResearchService } from './service';
import { parseResearchCaseView } from './client';
import { parseSavedVideoReport } from './saved-video';
import { parseAutomaticResearchResult } from './automatic-client';
import { videoSaveFixture } from './video-save-fixture';
it('retains the full original frame report, reopens without providers and keeps corrections on response-loss replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ct-video-save-'));
  try {
    const result = videoSaveFixture(), service = localResearchService(directory);
    const videoReport = parseSavedVideoReport({ schemaVersion: 'contexttrail-video-report-v1', result });
    const input = { kind: 'import_case', operationId: 'save-video', question: result.question, createdAt: result.caseRecord.createdAt, caseRecord: result.caseRecord, videoReport };
    const saved = await service.apply(input);
    expect(await localResearchService(directory).apply(input)).toEqual(saved);
    expect((await service.list()).cases).toHaveLength(1);
    const reopened = parseResearchCaseView(await localResearchService(directory).get(result.caseRecord.id));
    expect(reopened.videoReport?.result).toEqual(result);
    expect(reopened.videoReportStatus).toBe('current');
    expect(reopened.videoReport?.result.frames).toEqual(result.frames);
    const originalBytes = await readFile(join(directory, (await readdir(directory))[0]), 'utf8');
    expect(originalBytes).toContain('Synthetic offline uncertainty.');
    expect(originalBytes).not.toContain('base64');
    await expect(service.apply({ ...input, question: 'Different question' })).rejects.toThrow();
    await expect(service.apply({ ...input, videoReport: { ...videoReport, result: { ...videoReport.result, limitations: ['Changed report'] } } })).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    const corrected = { ...result.caseRecord.evidence[0], title: 'Corrected source' };
    const updated = await service.apply({ kind: 'update', caseId: result.caseRecord.id, operationId: 'correction', expectedRevision: 1, change: { kind: 'evidence', value: corrected, assets: [] } });
    expect(updated.videoReportStatus).toBe('stale');
    expect(await localResearchService(directory).apply(input)).toEqual(updated);
    const after = parseResearchCaseView(await localResearchService(directory).get(result.caseRecord.id));
    expect(after.caseRecord.evidence[0].title).toBe('Corrected source');
    expect(after.videoReport?.result).toEqual(result);
    const reverted = await service.apply({ kind: 'update', caseId: result.caseRecord.id, operationId: 'revert', expectedRevision: 2, change: { kind: 'evidence', value: result.caseRecord.evidence[0], assets: [] } });
    expect(reverted.videoReportStatus).toBe('stale');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it('rejects original media fields and inline media while retaining exact complete report JSON', () => {
  const result = videoSaveFixture();
  expect(parseAutomaticResearchResult(result).retainedResult).toEqual(result);
  for (const bad of [{ ...result, bytes: [1, 2] }, { ...result, frames: [{ ...result.frames[0], imageResult: { ...result.frames[0].imageResult, videoBytes: 'private' } }] }, { ...result, frames: [{ ...result.frames[0], imageResult: { ...result.frames[0].imageResult, provenance: { media: { id: 'media', base64: 'private' } } } }] }, { ...result, limitations: ['data:video/webm;base64,private'] }]) {
    expect(() => parseSavedVideoReport({ schemaVersion: 'contexttrail-video-report-v1', result: bad })).toThrow();
  }
});
