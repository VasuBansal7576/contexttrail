/** Opaque report JSON is archived for inspection, never trusted as an assessment. */
export type ReportJson = null | boolean | number | string | ReportJson[] | { [key: string]: ReportJson };
export interface RetainedVideoResult { [key: string]: ReportJson }
const resultKeys = new Set(['kind', 'question', 'caseRecord', 'frames', 'limitations', 'assessments', 'claimReport', 'visualScan', 'transcript', 'submittedClaim', 'spokenResearch']);
const frameKeys = new Set(['timestampMs', 'imageResult']);
const reportKeys = new Set(['mode', 'headline', 'caseRecord', 'caseProjectionError', 'sourceLinkedReport', 'earliestObservedOccurrence', 'sourceDomainCount', 'reportingGroupCount', 'unresolvedOriginCount', 'contextSegmentCount', 'firstObservedContextDivergence', 'comparisonCoverage', 'requestLog', 'reportingGroups', 'unresolvedCandidateIds', 'comparisons', 'provenance', 'limitations', 'undatedEvidence', 'timeline', 'supportingEvidence', 'contextualEvidence', 'status', 'statusBasis', 'policyReasons', 'claim', 'claimDate', 'doesNotProveClaimTrue', 'webContextAvailable', 'takeaways']);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid retained video report');
  return value as Record<string, unknown>;
}
function json(value: unknown, depth = 0): ReportJson {
  if (depth > 30) throw new Error('Retained video report is too deeply nested');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length <= 20_000 && !/^(data:|blob:)/i.test(value)) return value;
  if (Array.isArray(value) && value.length <= 10_000) return value.map(item => json(item, depth + 1));
  const source = object(value), copy: RetainedVideoResult = {};
  for (const [key, item] of Object.entries(source)) {
    if (/bytes|base64|buffer|payload|^(video|audio|file|media)$/i.test(key) && key !== 'media') throw new Error('Original media bytes cannot be retained in a video report');
    // The public provenance graph's media node carries only an identifier.
    if (key === 'media' && (Object.keys(object(item)).length !== 1 || object(item).id !== 'media')) throw new Error('Invalid public media reference');
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error('Invalid report key');
    copy[key] = json(item, depth + 1);
  }
  return copy;
}
function keys(value: Record<string, unknown>, allowed: Set<string>) {
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error('Unexpected video report field; input media must not be archived');
}
export function retainVideoResult(value: unknown): RetainedVideoResult {
  const result = object(value); keys(result, resultKeys);
  if ((result.kind !== 'video' && result.kind !== 'audio') || !Array.isArray(result.frames) || result.frames.length > 32) throw new Error('Expected a completed video report');
  for (const item of result.frames) {
    const frame = object(item); keys(frame, frameKeys); keys(object(frame.imageResult), reportKeys);
  }
  const retained = json(result);
  if (retained === null || Array.isArray(retained) || typeof retained !== 'object') throw new Error('Invalid video report');
  if (new TextEncoder().encode(JSON.stringify(retained)).length > 4 * 1024 * 1024) throw new Error('Video report exceeds the retention limit');
  return retained;
}
