import { parseAutomaticResearchResult, type AutomaticResearchView } from './automatic-client';
import { retainVideoResult, type RetainedVideoResult } from './video-retention';
import type { CaseRecord } from '../cases/model';
export interface SavedVideoReport { schemaVersion: 'contexttrail-video-report-v1'; result: RetainedVideoResult }
export function parseSavedVideoReport(value: unknown): SavedVideoReport {
  if (!value || typeof value !== 'object' || !('schemaVersion' in value) || value.schemaVersion !== 'contexttrail-video-report-v1' || !('result' in value)) throw new Error('Invalid saved video report');
  const result = retainVideoResult(value.result);
  if (!Array.isArray(result.frames) || !Array.isArray(result.limitations)) throw new Error('Incomplete saved video report');
  for (const frame of result.frames) {
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('Invalid saved frame report');
    const report = frame.imageResult;
    if (!report || typeof report !== 'object' || Array.isArray(report) || (report.mode !== 'trace' && report.mode !== 'claim_check')) throw new Error('Missing completed frame report');
    for (const field of ['limitations', 'timeline', 'undatedEvidence', 'supportingEvidence', 'contextualEvidence']) if (!Array.isArray(report[field])) throw new Error('Incomplete completed frame report');
  }
  parseAutomaticResearchResult(result);
  return { schemaVersion: value.schemaVersion, result };
}
export function savedVideoView(report: SavedVideoReport): AutomaticResearchView { return parseAutomaticResearchResult(report.result); }
export function videoReportMatches(report: SavedVideoReport, record: CaseRecord, question: string): boolean {
  const original = savedVideoView(report);
  return original.question === question && JSON.stringify(original.caseRecord) === JSON.stringify(record);
}
