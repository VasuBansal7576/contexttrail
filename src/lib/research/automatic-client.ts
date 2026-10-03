import { retainVideoResult, type RetainedVideoResult } from './video-retention';
import { JEV_MODEL } from '../jev/model';
import { parseCaseRecord } from '../cases/parse';
import { parseClaimReport } from './claim-report';
import type { CaseEvidence } from '../cases/model';
import type { ClaimStatus, Takeaway } from '../investigation/contracts/investigation';
import type { AutomaticResearchResult } from './automatic-contract';
import { projectCaptionFindings, type CaptionFindingsView } from './caption-findings';
import { parseDeepReadSelectionAudit, type DeepReadSelectionAudit } from '../investigation/deep-read-audit';

export interface AutomaticFrameSource {
  evidenceId: string;
  title: string | null;
  sourceUrl: string;
  dateStatus: string;
  observedAt: string | null;
  identityBasis: string;
  excerpt: string | null;
  displayAttribution: string | null;
  excerptSource: string;
  classificationContext: string | null;
  mediaRelationship: string | null;
}
export type AutomaticResearchView = Omit<AutomaticResearchResult, 'frames'> & {
  /** Exact completed video report archive; never input media bytes. */
  retainedResult?: RetainedVideoResult;
  frames: Array<{ timestampMs: number; imageResult: { captionComparison?: { mode: 'claim_check'; claim: string; status: ClaimStatus; takeaways: Takeaway[]; evidenceWarning?: string }; captionFindings: CaptionFindingsView; readSelectionAudit?: DeepReadSelectionAudit | null; limitations: string[]; timeline: AutomaticFrameSource[]; undatedEvidence: AutomaticFrameSource[]; supportingEvidence: AutomaticFrameSource[]; contextualEvidence: AutomaticFrameSource[] } }>;
};
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The research service returned an invalid result.');
  return value as Record<string, unknown>;
}
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }
function nullableText(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value : null; }
function sources(value: unknown): AutomaticFrameSource[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    const source = record(item);
    const sourceUrl = nullableText(source.sourceUrl);
    if (!sourceUrl) return [];
    let url: URL;
    try { url = new URL(sourceUrl); } catch { return []; }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return [];
    return [{ evidenceId: nullableText(source.evidenceId) ?? sourceUrl, title: nullableText(source.title), sourceUrl, dateStatus: nullableText(source.dateStatus) ?? 'unknown', observedAt: nullableText(source.observedAt), identityBasis: nullableText(source.identityBasis) ?? 'unknown', excerpt: nullableText(source.excerpt), displayAttribution: nullableText(source.displayAttribution), excerptSource: nullableText(source.excerptSource) ?? 'attribution_unknown', classificationContext: nullableText(source.classificationContext), mediaRelationship: nullableText(source.mediaRelationship) }];
  });
}
function captionComparison(image: Record<string, unknown>, evidence: AutomaticFrameSource[], retained: CaseEvidence[]): AutomaticResearchView['frames'][number]['imageResult']['captionComparison'] {
  if (image.mode !== 'claim_check') return undefined;
  const status = image.status;
  if ((status !== 'CONTEXT_CONFLICT' && status !== 'POSSIBLE_CONTEXT_CONFLICT' && status !== 'NO_CONFLICT_FOUND' && status !== 'INSUFFICIENT_EVIDENCE') || typeof image.claim !== 'string' || !image.claim.trim()) throw new Error('The research service returned an invalid caption comparison.');
  const ids = new Set(evidence.filter(source => retained.some(item => item.id === source.evidenceId && item.sourceUrl === source.sourceUrl)).map(source => source.evidenceId));
  const takeaways: Takeaway[] = [];
  if (Array.isArray(image.takeaways)) for (const value of image.takeaways) {
    const item = record(value), code = item.code;
    if (code !== 'temporal_conflict' && code !== 'location_conflict' && code !== 'historical_reuse' && code !== 'no_current_media_corroboration') continue;
    if (!Array.isArray(item.evidenceIds) || !item.evidenceIds.length || item.evidenceIds.some(id => typeof id !== 'string' || !ids.has(id))) continue;
    takeaways.push({ code, evidenceIds: strings(item.evidenceIds) });
  }
  function boundGate(name: string, minimum: number, passedRequired: boolean): boolean {
    if (!Array.isArray(image.policyReasons)) return false;
    return image.policyReasons.some(value => {
      if (!value || typeof value !== 'object' || !('gate' in value) || value.gate !== name || !('supportIds' in value) || !Array.isArray(value.supportIds)) return false;
      if (passedRequired && (!('passed' in value) || value.passed !== true)) return false;
      return value.supportIds.every((id: unknown) => typeof id === 'string' && ids.has(id)) && new Set(value.supportIds).size >= minimum;
    });
  }
  // Upstream policy can have a real context conflict without date/location
  // takeaways. Its qualifying/corroborating support must still survive this
  // display projection; a dropped source cannot leave an unsupported verdict.
  const supported = status === 'CONTEXT_CONFLICT'
    ? boundGate('qualifying_conflicts', 2, true) && boundGate('corroborating_pair', 2, true)
    : status === 'POSSIBLE_CONTEXT_CONFLICT' ? boundGate('qualifying_conflicts', 1, false)
    : status !== 'NO_CONFLICT_FOUND' || (boundGate('relevant_core_coverage', 3, true) && boundGate('distinct_domains', 2, true) && boundGate('distinct_reporting_groups', 2, true) && boundGate('corroborating_pair', 2, true) && boundGate('strong_support', 1, true));
  if (!supported) return { mode: 'claim_check', claim: image.claim, status: 'INSUFFICIENT_EVIDENCE', takeaways: [], evidenceWarning: 'The stronger caption result could not be bound to enough safe retained evidence. This view therefore reports insufficient evidence.' };
  return { mode: 'claim_check', claim: image.claim, status, takeaways };
}
/** Validate the case and project only inspected frame fields. No trust cast to InvestigationResult. */
export function parseAutomaticResearchResult(value: unknown): AutomaticResearchView {
  const result = record(value);
  if ((result.kind !== 'topic' && result.kind !== 'video') || typeof result.question !== 'string' || !Array.isArray(result.frames)) throw new Error('The research service returned an invalid result.');
  const caseRecord = parseCaseRecord(result.caseRecord);
  if (!Array.isArray(result.assessments)) throw new Error('The research service returned invalid relevance assessments.');
  const evidenceIds = new Set(caseRecord.evidence.map(item => item.id));
  const seenAssessments = new Set<string>();
  const assessments = result.assessments.map(value => {
    const assessment = record(value);
    if (typeof assessment.evidenceId !== 'string' || !evidenceIds.has(assessment.evidenceId) || seenAssessments.has(assessment.evidenceId)) throw new Error('Relevance assessment does not match a unique source.');
    seenAssessments.add(assessment.evidenceId);
    if (assessment.relevance === null && assessment.model === null) return { evidenceId: assessment.evidenceId, relevance: null, model: null };
    if (typeof assessment.relevance !== 'number' || !Number.isFinite(assessment.relevance) || assessment.relevance < 0 || assessment.relevance > 1 || assessment.model !== JEV_MODEL) throw new Error('The research service returned an invalid or unverified relevance assessment.');
    return { evidenceId: assessment.evidenceId, relevance: assessment.relevance, model: assessment.model };
  });
  const claimReport = result.claimReport === undefined ? null : parseClaimReport(result.claimReport, caseRecord, result.question);
  if (result.claimReport !== undefined && !claimReport) throw new Error('The research service returned an invalid or stale claim report.');
  return { ...(result.kind === 'video' ? { retainedResult: retainVideoResult(result) } : {}), kind: result.kind, question: result.question, caseRecord, assessments, ...(claimReport ? { claimReport } : {}), limitations: strings(result.limitations), frames: result.frames.map(item => {
    const frame = record(item), image = record(frame.imageResult);
    if (typeof frame.timestampMs !== 'number' || !Number.isFinite(frame.timestampMs) || frame.timestampMs < 0) throw new Error('The research service returned an invalid frame timestamp.');
    const timeline = sources(image.timeline), undatedEvidence = sources(image.undatedEvidence), supportingEvidence = sources(image.supportingEvidence), contextualEvidence = sources(image.contextualEvidence);
    const frameSources = [...timeline, ...undatedEvidence, ...supportingEvidence, ...contextualEvidence];
    const comparison = captionComparison(image, frameSources, caseRecord.evidence);
    const readSelectionAudit = parseDeepReadSelectionAudit(image.sourceLinkedReport && typeof image.sourceLinkedReport === 'object' && 'readSelectionAudit' in image.sourceLinkedReport ? image.sourceLinkedReport.readSelectionAudit : undefined, frameSources);
    const captionFindings = projectCaptionFindings(image.sourceLinkedReport, frameSources, caseRecord.evidence, image.policyReasons);
    return { timestampMs: frame.timestampMs, imageResult: { ...(comparison ? { captionComparison: comparison } : {}), captionFindings, readSelectionAudit, limitations: strings(image.limitations), timeline, undatedEvidence, supportingEvidence, contextualEvidence } };
  }) };
}
export async function investigateAutomatically(body: FormData, signal: AbortSignal, onProgress: (message: string) => void): Promise<AutomaticResearchView> {
  const response = await fetch('/api/research/investigate', { method: 'POST', body, signal });
  if (!response.ok) {
    let message = `Research request failed (${response.status}).`;
    try { const error = record(await response.json()); message = nullableText(error.error) ?? nullableText(error.message) ?? message; } catch { /* Keep the HTTP failure. */ }
    throw new Error(message);
  }
  if (!response.body) throw new Error('The research service returned no response stream.');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  let receivedBytes = 0;
  const maximumBytes = 8 * 1024 * 1024;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  function line(text: string): AutomaticResearchView | null {
    if (!text.trim()) return null;
    const event = record(JSON.parse(text));
    if (event.type === 'research.progress' && typeof event.message === 'string') onProgress(event.message);
    if (event.type === 'research.error') throw new Error(nullableText(event.message) ?? 'Research failed.');
    return event.type === 'research.completed' ? parseAutomaticResearchResult(event.result) : null;
  }
  try {
    for (;;) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const { value, done } = await reader.read();
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      receivedBytes += value?.byteLength ?? 0;
      if (receivedBytes > maximumBytes) throw new Error('The research response exceeded the 8 MiB limit.');
      buffer += decoder.decode(value, { stream: !done });
      let boundary: number;
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        const result = line(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 1);
        if (result) return result;
      }
      if (done) { const result = line(buffer); if (result) return result; break; }
    }
    throw new Error('The connection ended before a complete result arrived. Please try again.');
  } finally { signal.removeEventListener('abort', abort); void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
