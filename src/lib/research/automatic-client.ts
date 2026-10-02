import { JEV_MODEL } from '@/lib/jev/client';
import { parseCaseRecord } from '@/lib/cases/parse';
import type { AutomaticResearchResult } from './automatic-contract';

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
}
export type AutomaticResearchView = Omit<AutomaticResearchResult, 'frames'> & {
  frames: Array<{ timestampMs: number; imageResult: { limitations: string[]; timeline: AutomaticFrameSource[]; undatedEvidence: AutomaticFrameSource[]; supportingEvidence: AutomaticFrameSource[]; contextualEvidence: AutomaticFrameSource[] } }>;
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
    return [{ evidenceId: nullableText(source.evidenceId) ?? sourceUrl, title: nullableText(source.title), sourceUrl, dateStatus: nullableText(source.dateStatus) ?? 'unknown', observedAt: nullableText(source.observedAt), identityBasis: nullableText(source.identityBasis) ?? 'unknown', excerpt: nullableText(source.excerpt), displayAttribution: nullableText(source.displayAttribution), excerptSource: nullableText(source.excerptSource) ?? 'attribution_unknown' }];
  });
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
  return { kind: result.kind, question: result.question, caseRecord, assessments, limitations: strings(result.limitations), frames: result.frames.map(item => {
    const frame = record(item), image = record(frame.imageResult);
    if (typeof frame.timestampMs !== 'number' || !Number.isFinite(frame.timestampMs) || frame.timestampMs < 0) throw new Error('The research service returned an invalid frame timestamp.');
    return { timestampMs: frame.timestampMs, imageResult: { limitations: strings(image.limitations), timeline: sources(image.timeline), undatedEvidence: sources(image.undatedEvidence), supportingEvidence: sources(image.supportingEvidence), contextualEvidence: sources(image.contextualEvidence) } };
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
