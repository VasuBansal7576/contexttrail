import type { SavedVideoReport } from './saved-video';
import type { ClaimReport } from './claim-report';
import type { LocalComparisonResponse } from '../video/matching/application-contract';
/** Single-user, explicitly enabled local application storage. No hosted account boundary. */
import type { CaseRecord } from '../cases/model';
import { createHash } from 'node:crypto';
import { mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { object } from '../watchlists/parse';
import { inquiryCase, parseResearchDocument, researchWorkflow, reviewResearch, type ResearchChange, type ResearchDocument, type ResearchReview, ResearchOperationConflict } from './workflow';

export const MAX_RESEARCH_BYTES = 5 * 1024 * 1024;
export type ResearchApplicationRequest =
  | { kind: 'start'; operationId: string; question: string; createdAt: string }
  | { kind: 'import_case'; operationId: string; question: string; createdAt: string; caseRecord: CaseRecord; claimReport?: ClaimReport; videoReport?: SavedVideoReport }
  | { kind: 'import_comparison'; operationId: string; question: string; createdAt: string; comparison: LocalComparisonResponse }
  | { kind: 'update'; caseId: string; operationId: string; expectedRevision: number; change: ResearchChange };
export class ResearchServiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
function errorCode(error: unknown): unknown {
  return error && typeof error === 'object' && 'code' in error ? error.code : null;
}
function caseId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new Error('Invalid case ID');
  return value;
}
function filename(id: string): string { return createHash('sha256').update(id).digest('hex'); }

export function localResearchService(directory: string) {
  const root = resolve(directory);
  async function read(id: string): Promise<ResearchDocument | null> {
    let file;
    try { file = await open(join(root, `${filename(id)}.json`), 'r'); }
    catch (error) { if (errorCode(error) === 'ENOENT') return null; throw error; }
    try {
      if ((await file.stat()).size > MAX_RESEARCH_BYTES) throw new ResearchServiceError(413, 'STATE_TOO_LARGE', 'Saved case exceeds 5 MiB. The original file has not been changed.');
      const input: unknown = JSON.parse(await file.readFile('utf8'));
      const document = parseResearchDocument(input);
      if (document.workspace.inquiry.caseId !== id) throw new Error('Saved case identity mismatch');
      return document;
    } finally { await file.close(); }
  }
  async function write(document: ResearchDocument): Promise<void> {
    const bytes = `${JSON.stringify(document)}\n`;
    if (Buffer.byteLength(bytes) > MAX_RESEARCH_BYTES) throw new ResearchServiceError(413, 'STATE_TOO_LARGE', 'This edit would exceed the 5 MiB case limit. The prior case is unchanged.');
    const name = filename(document.workspace.inquiry.caseId), temporary = join(root, `${name}.tmp`);
    let file;
    try { file = await open(temporary, 'wx', 0o600); }
    catch (error) {
      if (errorCode(error) === 'EEXIST') throw new ResearchServiceError(409, 'RECOVERY_REQUIRED', 'An interrupted save needs inspection. Reopen the case to inspect the last committed revision; preserve the temporary file.');
      throw error;
    }
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await rename(temporary, join(root, `${name}.json`));
    const directoryHandle = await open(root, 'r');
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  }
  async function withLock<T>(id: string, action: () => Promise<T>): Promise<T> {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const path = join(root, `${filename(id)}.lock`);
    let lock;
    try { lock = await open(path, 'wx', 0o600); }
    catch (error) {
      if (errorCode(error) === 'EEXIST') throw new ResearchServiceError(409, 'CASE_BUSY', 'The case has an active or interrupted writer. Reopen to inspect the last saved revision; retry only after the writer finishes. Do not remove an unexplained lock.');
      throw error;
    }
    try { return await action(); } finally { await lock.close(); await unlink(path); }
  }
  async function get(idInput: unknown): Promise<ResearchReview> {
    const document = await read(caseId(idInput));
    if (!document) throw new ResearchServiceError(404, 'NOT_FOUND', 'Research case not found');
    return reviewResearch(document);
  }
  async function list() {
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch (error) { if (errorCode(error) === 'ENOENT') return { cases: [], warnings: [] }; throw error; }
    const summaries: Array<{ caseId: string; question: string; revision: number; createdAt: string }> = [];
    const warnings: Array<{ file: string; code: 'RECOVERY_REQUIRED'; message: string }> = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      try {
        const file = await open(join(root, entry.name), 'r');
        let document;
        try {
          if ((await file.stat()).size > MAX_RESEARCH_BYTES) throw new ResearchServiceError(413, 'STATE_TOO_LARGE', 'A saved case exceeds 5 MiB. Existing files have not been changed.');
          const input: unknown = JSON.parse(await file.readFile('utf8'));
          document = parseResearchDocument(input);
        } finally { await file.close(); }
        if (`${filename(document.workspace.inquiry.caseId)}.json` !== entry.name) throw new Error('Saved case filename mismatch');
        summaries.push({ caseId: document.workspace.inquiry.caseId, question: document.workspace.inquiry.question, revision: document.revision, createdAt: inquiryCase(document.workspace).createdAt });
      } catch {
        warnings.push({ file: entry.name, code: 'RECOVERY_REQUIRED', message: 'This saved case could not be read or validated. Preserve the original file for recovery; it has not been changed.' });
      }
    }
    return { cases: summaries, warnings };
  }
  async function apply(input: unknown): Promise<ResearchReview> {
    const request = object(input);
    if (request.kind === 'start' || request.kind === 'import_case' || request.kind === 'import_comparison') {
      const candidate = researchWorkflow(request);
      const id = candidate.document.workspace.inquiry.caseId;
      return withLock(id, async () => {
        const existing = await read(id);
        if (existing) {
          // Comparison identity is content-derived across browser sessions. Keep the
          // first app-owned creation time rather than treating a later save click as
          // changed evidence. Recompute against the original timestamp so existing
          // v3 documents remain compatible; all report/question fields still bind.
          const replayCandidate = request.kind === 'import_comparison'
            ? researchWorkflow({ ...request, createdAt: inquiryCase(existing.workspace).createdAt })
            : candidate;
          if (existing.applied.find(item => item.operationId === request.operationId)?.digest !== replayCandidate.document.applied[0].digest) throw new ResearchServiceError(409, 'OPERATION_CONFLICT', 'Creation operation ID reused with different input');
          return reviewResearch(existing);
        }
        await write(candidate.document);
        return candidate;
      });
    }
    if (request.kind !== 'update') throw new Error('Expected start or update');
    const id = caseId(request.caseId);
    if (typeof request.expectedRevision !== 'number' || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1) throw new Error('Expected a positive integer research revision');
    return withLock(id, async () => {
      const existing = await read(id);
      if (!existing) throw new ResearchServiceError(404, 'NOT_FOUND', 'Research case not found');
      if (!existing.applied.some(item => item.operationId === request.operationId) && request.expectedRevision !== existing.revision) throw new ResearchServiceError(409, 'REVISION_CONFLICT', 'The case changed since it was read. Reopen it and review your edit against the latest revision.');
      let result;
      try { result = researchWorkflow({ ...request, document: existing }); }
      catch (error) {
        if (error instanceof ResearchOperationConflict) throw new ResearchServiceError(409, 'OPERATION_CONFLICT', error.message);
        throw error;
      }
      if (result.document.revision !== existing.revision) await write(result.document);
      return result;
    });
  }
  return { apply, get, list };
}
