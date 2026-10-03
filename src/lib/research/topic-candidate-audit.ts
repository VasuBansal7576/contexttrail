import { TOPIC_CANDIDATE_AUDIT_LIMIT, type TopicCandidateAudit, type TopicCandidateReference, type TopicCandidateSearchAudit } from '../cases/topic-candidate-audit';
import { retainableSourceUrl } from '../pages/source-reference';
import type { TopicCandidate } from './topic-selection';

/** Capture bounded references only; no provider text, dates, judgments or authority. */
export function buildTopicCandidateAudit(entries: readonly TopicCandidate[], selected: readonly TopicCandidate[], searches: TopicCandidateSearchAudit[]): TopicCandidateAudit {
  const selectedIds = new Set(selected.map(entry => entry.candidate.id));
  const references: TopicCandidateReference[] = [];
  let safeReferenceCount = 0;
  for (const entry of [...selected, ...entries.filter(entry => !selectedIds.has(entry.candidate.id))]) {
    const sourceUrl = retainableSourceUrl(entry.candidate.sourceUrl);
    if (!sourceUrl) continue;
    safeReferenceCount++;
    if (references.length >= TOPIC_CANDIDATE_AUDIT_LIMIT) continue;
    const rank = entry.candidate.serpPosition;
    references.push({ candidateId: entry.candidate.id, sourceUrl, searchIndex: entry.search,
      providerRank: rank !== null && Number.isSafeInteger(rank) && rank >= 0 ? rank : null,
      disposition: selectedIds.has(entry.candidate.id) ? 'retained' : 'not_retained' });
  }
  return { schemaVersion: 'contexttrail-topic-candidate-audit-v1', uniqueNormalizedCount: entries.length,
    safeReferenceCount, withheldReferenceCount: entries.length - safeReferenceCount, retainedCount: selected.length,
    notRetainedCount: safeReferenceCount - selected.length, uncapturedSafeReferenceCount: safeReferenceCount - references.length,
    searches, references };
}
