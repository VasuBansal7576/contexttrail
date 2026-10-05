import { resolve } from 'node:path';
import { requireLocalResearchRequest } from '@/lib/research/local-boundary';
import { localResearchService, ResearchServiceError } from '@/lib/research/service';
import { inquiryCase } from '@/lib/research/workflow';
import type { FamilyCase } from '@/lib/research/families';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    requireLocalResearchRequest(request);
    const service = localResearchService(resolve(process.env.CONTEXTTRAIL_RESEARCH_DATA_DIR || 'data/research'));
    const list = await service.list(), cases: FamilyCase[] = []; let bytes = 0, omittedCases = Math.max(0, list.cases.length - 20);
    for (const summary of list.cases.slice(0, 20)) {
      const review = await service.get(summary.caseId), document = review.document;
      const record = document.claimReport && document.claimReportCase ? document.claimReportCase : inquiryCase(document.workspace);
      const c: FamilyCase = { caseId: record.id, question: document.claimReport?.question ?? document.workspace.inquiry.question, record,
        recordState: document.claimReport ? review.reportStatus === 'current' ? 'current' : 'historical' : 'unassessed', ...(document.claimReport ? { report: document.claimReport } : {}) };
      const size = Buffer.byteLength(JSON.stringify(c));
      if (bytes + size > 5 * 1024 * 1024) { omittedCases++; continue; } bytes += size; cases.push(c);
    }
    return Response.json({ cases, omittedCases, unreadableCases: list.warnings.length }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return Response.json({ error: error instanceof ResearchServiceError ? error.message : 'Saved investigations could not be read for family comparison. Existing records are unchanged.' }, { status: error instanceof ResearchServiceError ? error.status : 400 }); }
}
