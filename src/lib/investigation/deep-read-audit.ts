/** Frozen acquisition diagnostics, never a truth/identity/date assessment. */
import { diagnosticReferenceUrl } from '../pages/diagnostic-reference';
import { MAX_DEEP_READ_PAGES, RETENTION_CAPS } from './limits';

export const DEEP_READ_AUDIT_LIMIT = Object.values(RETENTION_CAPS).reduce((sum, cap) => sum + cap, 0);
export type DeepReadReason = 'core_anchor' | 'conflict' | 'support' | 'fact_check' | 'current_reporting' | 'core_recovery' | 'historical_lead' | 'filler';
export type DeepReadPlan = { kind: 'selected'; position: number; reason: DeepReadReason } | { kind: 'not_selected' };
export interface FrozenReadCandidate {
  evidenceId: string;
  sourceUrl: string;
  judgment: { kind: 'unassessed' } | { kind: 'assessed'; relevance: number; factCheck: number };
  historicalMediaCue: boolean;
  factCheckWinner: boolean;
  plan: DeepReadPlan;
}
export type FinalReadDecision =
  | { kind: 'deadline' | 'no_final_page' }
  | { kind: 'original_plan' | 'inspected_link'; evidenceId: string }
  | { kind: 'alternate_fact_check'; evidenceId: string; failedFactCheckId: string; displacedEvidenceId: string };
export interface DeepReadSelectionAudit {
  schemaVersion: 'deep-read-selection-v1';
  candidates: FrozenReadCandidate[];
  withheldCandidateCount: number;
  finalDecision: FinalReadDecision;
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function probability(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1; }
function reason(value: unknown): value is DeepReadReason {
  return value === 'core_anchor' || value === 'conflict' || value === 'support' || value === 'fact_check' || value === 'current_reporting'
    || value === 'core_recovery' || value === 'historical_lead' || value === 'filler';
}
function identifier(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256; }

/** Invalid/absent additive diagnostics are withheld; old reports stay readable.
 * Bind to the original frame snapshot, never a user's subsequently edited case.
 */
export function parseDeepReadSelectionAudit(value: unknown, sources: readonly { evidenceId: string; sourceUrl: string }[]): DeepReadSelectionAudit | null {
  if (!object(value) || value.schemaVersion !== 'deep-read-selection-v1' || !Array.isArray(value.candidates) || value.candidates.length > DEEP_READ_AUDIT_LIMIT
    || typeof value.withheldCandidateCount !== 'number' || !Number.isSafeInteger(value.withheldCandidateCount) || value.withheldCandidateCount < 0
    || value.candidates.length + value.withheldCandidateCount > DEEP_READ_AUDIT_LIMIT || !object(value.finalDecision)) return null;
  const candidates: FrozenReadCandidate[] = [], positions = new Set<number>(), ids = new Set<string>();
  for (const row of value.candidates) {
    if (!object(row) || !identifier(row.evidenceId) || ids.has(row.evidenceId) || typeof row.sourceUrl !== 'string' || typeof row.historicalMediaCue !== 'boolean' || typeof row.factCheckWinner !== 'boolean'
      || !object(row.judgment) || !object(row.plan)) return null;
    const sourceUrl = diagnosticReferenceUrl(row.sourceUrl);
    if (!sourceUrl || sources.filter(source => source.evidenceId === row.evidenceId && diagnosticReferenceUrl(source.sourceUrl) === sourceUrl).length !== 1) return null;
    let judgment: FrozenReadCandidate['judgment'];
    if (row.judgment.kind === 'unassessed') judgment = { kind: 'unassessed' };
    else if (row.judgment.kind === 'assessed' && probability(row.judgment.relevance) && probability(row.judgment.factCheck))
      judgment = { kind: 'assessed', relevance: row.judgment.relevance, factCheck: row.judgment.factCheck };
    else return null;
    let plan: DeepReadPlan;
    if (row.plan.kind === 'not_selected') plan = { kind: 'not_selected' };
    else if (row.plan.kind === 'selected' && typeof row.plan.position === 'number' && Number.isSafeInteger(row.plan.position)
      && row.plan.position >= 1 && row.plan.position <= MAX_DEEP_READ_PAGES && !positions.has(row.plan.position) && reason(row.plan.reason)) {
      if (judgment.kind === 'unassessed') return null;
      plan = { kind: 'selected', position: row.plan.position, reason: row.plan.reason }; positions.add(plan.position);
    } else return null;
    ids.add(row.evidenceId); candidates.push({ evidenceId: row.evidenceId, sourceUrl, judgment, historicalMediaCue: row.historicalMediaCue, factCheckWinner: row.factCheckWinner, plan });
  }
  // Unsafe references keep their original positions withheld, not renumbered.
  const missingPositions = Math.max(0, ...positions) - positions.size;
  if (missingPositions > value.withheldCandidateCount || candidates.filter(row => row.factCheckWinner).length > 1
    || candidates.some(row => row.factCheckWinner && (row.judgment.kind !== 'assessed' || row.judgment.factCheck <= 0))) return null;
  const decision = value.finalDecision;
  let finalDecision: FinalReadDecision;
  if (decision.kind === 'deadline' || decision.kind === 'no_final_page') finalDecision = { kind: decision.kind };
  else if ((decision.kind === 'original_plan' || decision.kind === 'inspected_link') && identifier(decision.evidenceId)) {
    if (sources.filter(source => source.evidenceId === decision.evidenceId && diagnosticReferenceUrl(source.sourceUrl)).length !== 1) return null;
    if (decision.kind === 'original_plan' && !candidates.some(row => row.evidenceId === decision.evidenceId && row.plan.kind === 'selected' && row.plan.position === MAX_DEEP_READ_PAGES)) return null;
    finalDecision = { kind: decision.kind, evidenceId: decision.evidenceId };
  } else if (decision.kind === 'alternate_fact_check' && identifier(decision.evidenceId) && identifier(decision.failedFactCheckId) && identifier(decision.displacedEvidenceId)) {
    const alternate = candidates.find(row => row.evidenceId === decision.evidenceId), failed = candidates.find(row => row.evidenceId === decision.failedFactCheckId), displaced = candidates.find(row => row.evidenceId === decision.displacedEvidenceId);
    if (!alternate || !failed || !displaced || alternate.plan.kind !== 'not_selected' || !alternate.historicalMediaCue
      || alternate.judgment.kind !== 'assessed' || failed.judgment.kind !== 'assessed' || failed.judgment.factCheck <= 0 || alternate.judgment.factCheck < failed.judgment.factCheck
      || failed.plan.kind !== 'selected' || !failed.factCheckWinner || failed.plan.position >= MAX_DEEP_READ_PAGES
      || displaced.plan.kind !== 'selected' || displaced.plan.position !== MAX_DEEP_READ_PAGES || (displaced.plan.reason !== 'core_recovery' && displaced.plan.reason !== 'filler')) return null;
    finalDecision = { kind: decision.kind, evidenceId: decision.evidenceId, failedFactCheckId: decision.failedFactCheckId, displacedEvidenceId: decision.displacedEvidenceId };
  } else return null;
  return { schemaVersion: 'deep-read-selection-v1', candidates, withheldCandidateCount: value.withheldCandidateCount, finalDecision };
}
