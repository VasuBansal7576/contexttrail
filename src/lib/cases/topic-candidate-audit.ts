import { diagnosticReferenceUrl } from '../pages/diagnostic-reference';

export const TOPIC_CANDIDATE_AUDIT_LIMIT = 100;
export interface TopicCandidateReference {
  candidateId: string;
  sourceUrl: string;
  /** First owning search after canonical deduplication, not all appearances. */
  searchIndex: number;
  providerRank: number | null;
  disposition: 'retained' | 'not_retained';
}
export type TopicSearchFailure =
  | { category: 'http'; httpStatus: number }
  | { category: 'timeout' | 'aborted' | 'network' | 'malformed' | 'unconfigured' | 'provider_reported' | 'unrecognized_surface' | 'unknown'; httpStatus: null };
export type TopicCandidateSearchAudit = { searchIndex: number } & (
  | { outcome: 'succeeded'; normalizedCount: number; droppedBeforeNormalizationCount: number; duplicateCount: number }
  | { outcome: 'unavailable'; normalizedCount: null; droppedBeforeNormalizationCount: null; duplicateCount: null; failure?: TopicSearchFailure }
);
export interface TopicCandidateAudit {
  schemaVersion: 'contexttrail-topic-candidate-audit-v1';
  uniqueNormalizedCount: number;
  safeReferenceCount: number;
  withheldReferenceCount: number;
  retainedCount: number;
  notRetainedCount: number;
  uncapturedSafeReferenceCount: number;
  searches: TopicCandidateSearchAudit[];
  references: TopicCandidateReference[];
}
function invalid(): never { throw new Error('Invalid bounded topic candidate audit.'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) return invalid();
  return value;
}
function parseFailure(value: unknown): TopicSearchFailure {
  const failure = object(value);
  switch (failure.category) {
    case 'http': {
      const httpStatus = integer(failure.httpStatus, 599);
      if (httpStatus < 100) return invalid();
      return { category: 'http', httpStatus };
    }
    case 'timeout': case 'aborted': case 'network': case 'malformed': case 'unconfigured':
    case 'provider_reported': case 'unrecognized_surface': case 'unknown':
      if (failure.httpStatus !== null) return invalid();
      return { category: failure.category, httpStatus: null };
    default: return invalid();
  }
}

/** Additive, browser-safe boundary. Deliberately excludes provider text/raw fields. */
export function parseTopicCandidateAudit(value: unknown, logs: readonly { returned: number; retained: number }[], sourceReads: readonly { evidenceId: string; requestedUrl: string }[] | undefined): TopicCandidateAudit {
  const v = object(value);
  if (v.schemaVersion !== 'contexttrail-topic-candidate-audit-v1' || !Array.isArray(v.searches) || v.searches.length !== logs.length || v.searches.length > 3
    || !Array.isArray(v.references) || v.references.length > TOPIC_CANDIDATE_AUDIT_LIMIT) return invalid();
  const searches = v.searches.map((value, searchIndex): TopicCandidateSearchAudit => {
    const search = object(value);
    if (search.searchIndex !== searchIndex) return invalid();
    if (search.outcome === 'unavailable') {
      if (search.normalizedCount !== null || search.droppedBeforeNormalizationCount !== null || search.duplicateCount !== null || logs[searchIndex].returned !== 0 || logs[searchIndex].retained !== 0) return invalid();
      return { searchIndex, outcome: 'unavailable', normalizedCount: null, droppedBeforeNormalizationCount: null, duplicateCount: null,
        ...(search.failure === undefined ? {} : { failure: parseFailure(search.failure) }) };
    }
    if (search.outcome !== 'succeeded' || 'failure' in search) return invalid();
    const normalizedCount = integer(search.normalizedCount), droppedBeforeNormalizationCount = integer(search.droppedBeforeNormalizationCount), duplicateCount = integer(search.duplicateCount);
    if (duplicateCount > normalizedCount || normalizedCount + droppedBeforeNormalizationCount !== logs[searchIndex].returned) return invalid();
    return { searchIndex, outcome: 'succeeded', normalizedCount, droppedBeforeNormalizationCount, duplicateCount };
  });
  const references = v.references.map((value): TopicCandidateReference => {
    const row = object(value);
    if (typeof row.candidateId !== 'string' || !row.candidateId.trim() || row.candidateId.length > 256 || typeof row.sourceUrl !== 'string') return invalid();
    const sourceUrl = diagnosticReferenceUrl(row.sourceUrl), searchIndex = integer(row.searchIndex, 2);
    if (!sourceUrl || searches[searchIndex]?.outcome !== 'succeeded' || (row.disposition !== 'retained' && row.disposition !== 'not_retained')) return invalid();
    return { candidateId: row.candidateId, sourceUrl, searchIndex, providerRank: row.providerRank === null ? null : integer(row.providerRank), disposition: row.disposition };
  });
  // Existing pool dedup and safe reference normalization are different steps:
  // trailing-dot aliases can remain separate candidates but share a safe URL.
  if (new Set(references.map(row => row.candidateId)).size !== references.length) return invalid();
  const uniqueNormalizedCount = integer(v.uniqueNormalizedCount), safeReferenceCount = integer(v.safeReferenceCount), withheldReferenceCount = integer(v.withheldReferenceCount);
  const retainedCount = integer(v.retainedCount, 8), notRetainedCount = integer(v.notRetainedCount), uncapturedSafeReferenceCount = integer(v.uncapturedSafeReferenceCount);
  if (uniqueNormalizedCount !== searches.reduce((total, search) => total + (search.normalizedCount ?? 0) - (search.duplicateCount ?? 0), 0)
    || uniqueNormalizedCount !== safeReferenceCount + withheldReferenceCount || safeReferenceCount !== retainedCount + notRetainedCount
    || safeReferenceCount !== references.length + uncapturedSafeReferenceCount || references.length !== Math.min(safeReferenceCount, TOPIC_CANDIDATE_AUDIT_LIMIT)
    || references.filter(row => row.disposition === 'retained').length !== retainedCount || references.slice(0, retainedCount).some(row => row.disposition !== 'retained')
    || retainedCount !== logs.reduce((total, log) => total + log.retained, 0)) return invalid();
  for (const search of searches) {
    const rows = references.filter(row => row.searchIndex === search.searchIndex);
    if (rows.filter(row => row.disposition === 'retained').length !== logs[search.searchIndex].retained || rows.length > (search.normalizedCount ?? 0) - (search.duplicateCount ?? 0)) return invalid();
  }
  // Original requested leads own retained disposition, including after source
  // corrections/removals. Current evidence URLs are deliberately not substituted.
  if (!sourceReads || sourceReads.length !== retainedCount || new Set(sourceReads.map(read => read.evidenceId)).size !== retainedCount) return invalid();
  for (const row of references.filter(row => row.disposition === 'retained')) {
    const read = sourceReads.find(read => read.evidenceId === row.candidateId);
    if (!read || diagnosticReferenceUrl(read.requestedUrl) !== row.sourceUrl) return invalid();
  }
  return { schemaVersion: 'contexttrail-topic-candidate-audit-v1', uniqueNormalizedCount, safeReferenceCount, withheldReferenceCount, retainedCount, notRetainedCount, uncapturedSafeReferenceCount, searches, references };
}
