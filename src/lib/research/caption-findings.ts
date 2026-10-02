import type { CaseEvidence } from '../cases/model';
import type { AutomaticFrameSource } from './automatic-client';
import { JEV_MODEL } from '../jev/model';
import { STRONG_RELATION_THRESHOLD } from '../investigation/contracts/judgment';
import type { SourceLinkedReport } from '../investigation/report';
import { DHASH_HAMMING_ELIGIBILITY } from '../investigation/limits';

type SignalKind = SourceLinkedReport['captionFindings'][number]['signals'][number]['kind'];
export interface CaptionFinding {
  evidenceId: string;
  title: string | null;
  sourceUrl: string;
  signals: Array<{ kind: SignalKind; probability: number }>;
  identityBasis: 'unverified' | 'contextual' | 'lens_exact_collection' | 'local_spatial_verification';
  policyEligibleIdentity: boolean;
  reportingOrigin: 'unresolved' | 'shared_origin' | 'separate_origin_evidenced';
  passage: { kind: 'page_quote' | 'search_snippet' | 'classification_context'; text: string } | null;
  classificationContext: string | null;
}
export type CaptionFindingsView =
  | { kind: 'unavailable'; reason: 'not_retained' | 'invalid_report' }
  | { kind: 'available'; findings: CaptionFinding[]; withheldCount: number; gates: Array<{ gate: 'qualifying_conflicts' | 'corroborating_pair' | 'relevant_core_coverage' | 'distinct_domains' | 'distinct_reporting_groups' | 'strong_support'; passed: boolean }> };
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
// Finding URLs are sanitized audit metadata, never the source link. The bound
// frame + case record owns the exact resource URL, including semantic queries.
function auditUrl(value: string): string | null {
  try { const url = new URL(value); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    url.search = ''; url.hash = ''; return url.toString();
  } catch { return null; }
}
function signal(value: unknown): CaptionFinding['signals'][number] | null {
  const item = object(value); if (!item) return null;
  const kind = item.kind, probability = item.probability;
  if (kind !== 'caption_contradiction' && kind !== 'different_context' && kind !== 'different_location' && kind !== 'caption_support') return null;
  if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < STRONG_RELATION_THRESHOLD || probability > 1) return null;
  return { kind, probability };
}
function finding(value: unknown, sources: readonly AutomaticFrameSource[], retained: readonly CaseEvidence[]): CaptionFinding | null {
  const item = object(value);
  if (!item || typeof item.evidenceId !== 'string' || item.assessment !== 'model_assessed_source_relation' || item.model !== JEV_MODEL || item.authority !== 'not_established' || item.independentCorroboration !== 'see_existing_policy_gates' || item.excerptEntailment !== 'not_separately_verified') return null;
  const rows = sources.filter(source => source.evidenceId === item.evidenceId);
  const records = retained.filter(source => source.id === item.evidenceId);
  if (rows.length !== 1 || records.length !== 1) return null;
  const row = rows[0], source = records[0];
  if (row.sourceUrl !== source.sourceUrl || typeof item.sourceUrl !== 'string' || item.sourceUrl !== auditUrl(row.sourceUrl)) return null;
  const identity = object(item.mediaIdentity), basis = identity?.basis;
  if (!identity || (basis !== 'unverified' && basis !== 'contextual' && basis !== 'lens_exact_collection' && basis !== 'local_spatial_verification') || basis !== row.identityBasis) return null;
  const verification = identity.verificationStatus;
  if (verification !== 'provider_reported' && verification !== 'passed' && verification !== 'failed' && verification !== 'ambiguous' && verification !== 'unavailable') return null;
  const metrics = object(identity.comparisonMetrics);
  const core = (row.mediaRelationship === 'EXACT_MATCH' && basis === 'lens_exact_collection' && verification === 'provider_reported') || (row.mediaRelationship === 'NEAR_MATCH' && basis === 'local_spatial_verification' && verification === 'passed' && typeof identity.verifierVersion === 'string' && !!identity.verifierVersion && typeof identity.verifierConfigId === 'string' && !!identity.verifierConfigId && typeof identity.hashDistance === 'number' && Number.isFinite(identity.hashDistance) && identity.hashDistance >= 0 && identity.hashDistance <= DHASH_HAMMING_ELIGIBILITY && metrics !== null && Object.keys(metrics).length > 0 && Object.values(metrics).every(value => typeof value === 'number' && Number.isFinite(value)));
  if ((row.mediaRelationship === 'EXACT_MATCH' || row.mediaRelationship === 'NEAR_MATCH') && !core) return null;
  if (typeof item.policyEligibleIdentity !== 'boolean' || item.policyEligibleIdentity !== core) return null;
  const reportingOrigin = item.reportingOrigin;
  if (reportingOrigin !== 'unresolved' && reportingOrigin !== 'shared_origin' && reportingOrigin !== 'separate_origin_evidenced') return null;
  if (!Array.isArray(item.signals) || !item.signals.length || item.signals.length > 4) return null;
  const signals = item.signals.map(signal);
  if (signals.some(item => item === null)) return null;
  const validSignals = signals.filter(item => item !== null);
  if (new Set(validSignals.map(item => item.kind)).size !== validSignals.length) return null;
  // A quote must agree with both independently retained projections. Title or
  // composite classifier input is always separate, never a fabricated quote.
  let passage: CaptionFinding['passage'] = null;
  if (item.excerpt !== null) {
    if (typeof item.excerpt !== 'string' || !item.excerpt.trim() || item.excerpt !== row.excerpt || item.excerptSource !== row.excerptSource || source.content.kind !== 'text' || source.content.text !== item.excerpt) return null;
    const expected = item.excerptSource === 'page_text' ? 'page_quote' : item.excerptSource === 'serp_snippet' ? 'search_snippet' : item.excerptSource === 'page_composite' ? 'classification_context' : null;
    if (!expected || source.content.attribution !== expected) return null;
    passage = { kind: expected, text: source.content.text };
  } else if (row.excerpt !== null) return null;
  const context = item.classificationContext;
  if (context !== null && (typeof context !== 'string' || !context.trim() || context !== row.classificationContext)) return null;
  return { evidenceId: source.id, title: source.title, sourceUrl: source.sourceUrl, signals: validSignals, identityBasis: basis, policyEligibleIdentity: core, reportingOrigin, passage, classificationContext: typeof context === 'string' ? context : null };
}
/** Additive explanation only. Never selects a status, threshold, or identity. */
export function projectCaptionFindings(value: unknown, sources: readonly AutomaticFrameSource[], retained: readonly CaseEvidence[], reasons: unknown): CaptionFindingsView {
  if (value === undefined) return { kind: 'unavailable', reason: 'not_retained' };
  const report = object(value);
  if (!report || report.version !== 'source-linked-report-v1' || !Array.isArray(report.captionFindings)) return { kind: 'unavailable', reason: 'invalid_report' };
  const findings: CaptionFinding[] = [], seen = new Set<string>();
  const duplicateIds = new Set(report.captionFindings.flatMap(item => { const id = object(item)?.evidenceId; if (typeof id !== 'string') return []; if (seen.has(id)) return [id]; seen.add(id); return []; }));
  for (const raw of report.captionFindings) { const parsed = finding(raw, sources, retained); if (parsed && !duplicateIds.has(parsed.evidenceId)) findings.push(parsed); }
  const ids = new Set(sources.filter(source => retained.some(item => item.id === source.evidenceId && item.sourceUrl === source.sourceUrl && auditUrl(item.sourceUrl) !== null)).map(source => source.evidenceId));
  const gates: Extract<CaptionFindingsView, { kind: 'available' }>['gates'] = [];
  const seenGates = new Set<string>();
  if (Array.isArray(reasons)) for (const raw of reasons) {
    const reason = object(raw), gate = reason?.gate;
    if (!reason || (gate !== 'qualifying_conflicts' && gate !== 'corroborating_pair' && gate !== 'relevant_core_coverage' && gate !== 'distinct_domains' && gate !== 'distinct_reporting_groups' && gate !== 'strong_support') || typeof reason.passed !== 'boolean' || !Array.isArray(reason.supportIds) || reason.supportIds.some(id => typeof id !== 'string' || !ids.has(id)) || seenGates.has(gate)) continue;
    seenGates.add(gate); gates.push({ gate, passed: reason.passed });
  }
  return { kind: 'available', findings, withheldCount: report.captionFindings.length - findings.length, gates };
}
