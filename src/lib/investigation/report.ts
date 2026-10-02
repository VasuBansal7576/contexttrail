/** Additive explanatory projection. Never selects a verdict or promotes identity. */
import type { EvidenceCandidate } from './contracts/evidence';
import type { TimelineItem, ComparisonCoverage } from './contracts/investigation';
import { STRONG_RELATION_THRESHOLD, RELEVANCE_THRESHOLD } from './contracts/judgment';
import { ProviderError } from '../providers/http';
import { isCoreOccurrence } from './identity';
import type { SourceBinding } from '../pages/source-binding';
import type { SourceLink } from '../pages/source-links';

export interface PageReadOutcome {
  evidenceId: string;
  requestedUrl: string | null;
  finalUrl: string | null;
  /** Absent only in results saved before source binding was audited. */
  sourceBinding?: SourceBinding;
  /** Inspected references, with selection deferrals visible. No dates inferred. */
  sourceLinks?: Array<SourceLink & { followup: 'not_historical' | 'pending' | 'selected' | 'already_read' | 'retention_limit' | 'classification_limit' | 'page_limit' | 'deadline'; evidenceId: string | null }>;
  selection: 'selected' | 'not_selected';
  fetch: 'succeeded' | 'failed' | 'not_attempted';
  extraction: 'usable_text' | 'empty_text' | 'failed' | 'not_attempted';
  failureCode: 'timeout' | 'aborted' | 'http' | 'malformed' | 'network' | 'unknown' | 'extraction_failed' | 'source_binding_rejected' | null;
  httpStatus: number | null;
}

/** New audit URLs omit credentials, query and fragment; old source records stay untouched. */
export function auditUrl(raw: string): string | null {
  try { const u = new URL(raw); if (!['http:', 'https:'].includes(u.protocol)) return null;
    u.username = ''; u.password = ''; u.search = ''; u.hash = ''; return u.toString();
  } catch { return null; }
}
export function readFailure(err: unknown): Pick<PageReadOutcome, 'failureCode' | 'httpStatus'> {
  if (!(err instanceof ProviderError)) return { failureCode: 'unknown', httpStatus: null };
  const kinds = ['timeout', 'aborted', 'http', 'malformed', 'network'] as const;
  return { failureCode: kinds.find(k => k === err.kind) ?? 'unknown',
    httpStatus: err.kind === 'http' && err.status !== null && err.status >= 100 && err.status <= 599 ? err.status : null };
}

export function deriveReport(input: {
  candidates: readonly EvidenceCandidate[];
  items: readonly TimelineItem[];
  coverage: ComparisonCoverage;
  earliestObservedOccurrence: string | null;
  pageReads?: readonly PageReadOutcome[];
  claimMode: boolean;
}) {
  const roles = input.candidates.map(c => ({
    evidenceId: c.id,
    documentRole: { basis: c.judgment ? 'model_assessed' : 'unresolved', distribution: c.judgment?.pageRole ?? null },
    // An image on a correction page proves an occurrence, not false-caption circulation.
    eventRole: isCoreOccurrence(c) ? 'media_occurrence' : 'unresolved',
    captionCirculation: 'unresolved',
    correctionPublication: 'unresolved',
    originalPublication: 'unresolved',
  }));
  const findings = input.claimMode ? input.candidates.flatMap(c => {
    const j = c.judgment;
    if (!j || j.relevance < RELEVANCE_THRESHOLD) return [];
    const signals = [
      ['caption_contradiction', j.claimRelation?.contradicts ?? 0],
      ['different_context', j.contextRelation?.differentContext ?? 0],
      ['different_location', j.locationRelation?.differentLocation ?? 0],
      ['caption_support', j.claimRelation?.supports ?? 0],
    ] as const;
    const strong = signals.filter(([, p]) => p >= STRONG_RELATION_THRESHOLD);
    if (!strong.length) return [];
    const item = input.items.find(i => i.evidenceId === c.id);
    return [{ evidenceId: c.id, sourceUrl: auditUrl(c.sourceUrl),
      assessment: 'model_assessed_source_relation', signals: strong.map(([kind, probability]) => ({ kind, probability })),
      mediaIdentity: c.identityEvidence, policyEligibleIdentity: isCoreOccurrence(c),
      authority: 'not_established', independentCorroboration: 'see_existing_policy_gates',
      // A displayed quote is inspectable context, not a guaranteed entailment span.
      excerpt: item?.excerpt ?? null, excerptSource: item?.excerptSource ?? null,
      classificationContext: item?.classificationContext ?? null,
      excerptEntailment: 'not_separately_verified', model: j.model,
      reportingOrigin: c.reportingOrigin.status,
    }];
  }) : [];
  return {
    version: 'source-linked-report-v1',
    captionFindings: findings,
    sourceRoles: roles,
    provenanceCompleteness: {
      earliestObservedOccurrence: input.earliestObservedOccurrence,
      originalPublication: { status: 'unknown', evidenceIds: [] as string[] },
      datedCoreOccurrences: input.coverage.displayedDatedCore,
      comparisonCoverage: input.coverage,
      unresolvedReportingOrigins: input.candidates.filter(c => isCoreOccurrence(c) && c.reportingOrigin.status === 'unresolved').map(c => c.id),
      // No percentage, original-upload claim, or automatic promotion of visual leads.
      unverifiedVisualLeadIds: input.candidates.filter(c => c.mediaRelationship === 'VISUAL_LEAD').map(c => c.id),
    },
    pageReads: input.pageReads ?? [],
    pageReadAuditAvailable: input.pageReads !== undefined,
  };
}
export type SourceLinkedReport = ReturnType<typeof deriveReport>;
