import type { CaseRecord } from '../cases/model';
import type { ClaimReport } from './claim-report';
import type { SavedVideoReport } from './saved-video';
import type { LocalComparisonResponse } from '../video/matching/application-contract';
import type { ResearchChange } from './workflow';
export type ResearchApplicationRequest =
  | { kind: 'start'; operationId: string; question: string; createdAt: string }
  | { kind: 'import_case'; operationId: string; question: string; createdAt: string; caseRecord: CaseRecord; claimReport?: ClaimReport; videoReport?: SavedVideoReport }
  | { kind: 'import_comparison'; operationId: string; question: string; createdAt: string; comparison: LocalComparisonResponse }
  | { kind: 'update'; caseId: string; operationId: string; expectedRevision: number; change: ResearchChange };
import { object } from '../watchlists/parse';
import { inquiryCase, parseResearchDocument, researchWorkflow, reviewResearch, ResearchOperationConflict, type ResearchDocument } from './workflow';
import { database, files, ownerId } from '../hosted/context';
export const MAX_RESEARCH_BYTES = 5 * 1024 * 1024;
export class ResearchServiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
async function storage<T>(operation:()=>Promise<T>):Promise<T>{
  try{return await operation()}catch{throw new ResearchServiceError(503,'STORAGE_ERROR','Private evidence storage is unavailable. The last saved revision has been preserved.')}
}
function caseId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new Error('Invalid case ID');
  return value;
}
/** D1 indexes and atomically selects immutable, private R2 case revisions. */
export function localResearchService(_directory = '') {
  const owner = ownerId(), db = database(), bucket = files();
  async function read(id: string): Promise<{ document: ResearchDocument; key: string } | null> {
    const row = await storage(()=>db.prepare('SELECT object_key FROM research_cases WHERE owner = ? AND id = ?').bind(owner,id).first<{ object_key: string }>());
    if (!row) return null;
    const stored = await storage(()=>bucket.get(row.object_key));
    if (!stored || stored.size > MAX_RESEARCH_BYTES) throw new ResearchServiceError(503, 'STORAGE_ERROR', 'Saved evidence is unavailable. Its index has been preserved.');
    const document = await storage(async()=>parseResearchDocument(JSON.parse(await stored.text())));
    if (document.workspace.inquiry.caseId !== id) throw new Error('Saved case identity mismatch');
    return {document,key:row.object_key};
  }
  async function write(document: ResearchDocument, priorKey: string | null): Promise<void> {
    const bytes = JSON.stringify(document);
    if (new TextEncoder().encode(bytes).length > MAX_RESEARCH_BYTES) throw new ResearchServiceError(413, 'STATE_TOO_LARGE', 'This edit exceeds the 5 MiB case limit. The prior case is unchanged.');
    const id = document.workspace.inquiry.caseId;
    const key = `cases/${encodeURIComponent(owner)}/${encodeURIComponent(id)}/${crypto.randomUUID()}.json`;
    await storage(()=>bucket.put(key,bytes,{httpMetadata:{contentType:'application/json'}}));
    const result = await storage(()=>priorKey === null
      ? db.prepare('INSERT OR IGNORE INTO research_cases (owner,id,object_key,revision,question,created_at) SELECT ?,?,?,?,?,? WHERE (SELECT count(*) FROM research_cases WHERE owner = ?) < 100').bind(owner,id,key,document.revision,document.workspace.inquiry.question,inquiryCase(document.workspace).createdAt,owner).run()
      : db.prepare('UPDATE research_cases SET object_key = ?, revision = ?, question = ? WHERE owner = ? AND id = ? AND object_key = ?').bind(key,document.revision,document.workspace.inquiry.question,owner,id,priorKey).run());
    if (result.meta.changes !== 1) {
      await storage(()=>bucket.delete(key));
      throw new ResearchServiceError(409,'REVISION_CONFLICT','The case changed or your casebook reached its 100-case limit. Reopen it before retrying.');
    }
    // Prior objects remain private, immutable recovery copies. Never expose R2 URLs.
  }
  async function get(input: unknown) {
    const stored = await read(caseId(input));
    if (!stored) throw new ResearchServiceError(404,'NOT_FOUND','Research case not found');
    return reviewResearch(stored.document);
  }
  async function list() {
    const rows = await storage(()=>db.prepare('SELECT id,question,revision,created_at FROM research_cases WHERE owner = ? ORDER BY created_at DESC LIMIT 100').bind(owner).all<{id:string;question:string;revision:number;created_at:string}>());
    return {cases:rows.results.map(row=>({caseId:row.id,question:row.question,revision:row.revision,createdAt:row.created_at})),warnings:[]};
  }
  async function apply(input: unknown) {
    const request = object(input);
    if (request.kind === 'start' || request.kind === 'import_case' || request.kind === 'import_comparison') {
      const candidate = researchWorkflow(request), existing = await read(candidate.document.workspace.inquiry.caseId);
      if (existing) {
        const replay = request.kind === 'import_comparison' ? researchWorkflow({...request,createdAt:inquiryCase(existing.document.workspace).createdAt}) : candidate;
        if (existing.document.applied.find(item=>item.operationId===request.operationId)?.digest !== replay.document.applied[0].digest) throw new ResearchServiceError(409,'OPERATION_CONFLICT','Creation operation ID reused with different input');
        return reviewResearch(existing.document);
      }
      await write(candidate.document,null); return candidate;
    }
    if (request.kind !== 'update') throw new Error('Expected start or update');
    const existing = await read(caseId(request.caseId));
    if (!existing) throw new ResearchServiceError(404,'NOT_FOUND','Research case not found');
    if (!Number.isSafeInteger(request.expectedRevision) || typeof request.expectedRevision !== 'number' || request.expectedRevision < 1) throw new Error('Expected a positive research revision');
    if (!existing.document.applied.some(item=>item.operationId===request.operationId) && request.expectedRevision !== existing.document.revision) throw new ResearchServiceError(409,'REVISION_CONFLICT','The case changed. Reopen it before retrying.');
    let result;
    try { result = researchWorkflow({...request,document:existing.document}); }
    catch (error) { if (error instanceof ResearchOperationConflict) throw new ResearchServiceError(409,'OPERATION_CONFLICT',error.message); throw error; }
    if (result.document.revision !== existing.document.revision) await write(result.document,existing.key);
    return result;
  }
  return {get,list,apply};
}
