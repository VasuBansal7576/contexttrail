import type { TopicCandidateAudit, TopicSearchFailure } from '@/lib/cases/topic-candidate-audit';

const failureCopy: Record<TopicSearchFailure['category'], string> = {
  timeout: 'search operation timed out',
  aborted: 'provider request was aborted',
  http: 'provider returned an unsuccessful HTTP response',
  network: 'network request could not complete',
  malformed: 'provider response was malformed or exceeded its size limit',
  unconfigured: 'provider configuration was unavailable',
  provider_reported: 'provider reported a search error',
  unrecognized_surface: 'response lacked a recognized completed result collection',
  unknown: 'failure cause is unknown',
};
function failureDescription(failure: TopicSearchFailure | undefined): string {
  if (!failure) return 'failure cause was not captured and remains unknown';
  return `${failureCopy[failure.category]}${failure.category === 'http' ? ` (HTTP ${failure.httpStatus})` : ''}`;
}

/** References from the investigation snapshot, never later corrected case data. */
export function TopicCandidateAuditView({ audit }: { audit: TopicCandidateAudit | undefined }) {
  if (!audit) return <p className="fine-print">Candidate references were not captured with this report. The omitted source pool remains unknown; it cannot be reconstructed from retained evidence.</p>;
  return <details className="claim-report-limits" aria-label="Investigation candidate references">
    <summary>Inspect investigation candidate references ({audit.references.length} captured)</summary>
    <p className="fine-print">{audit.uniqueNormalizedCount} unique normalized candidates · {audit.safeReferenceCount} safe references · {audit.withheldReferenceCount} unsafe or oversized references withheld. {audit.retainedCount} selected for retained evidence; {audit.notRetainedCount} safe candidates not retained.</p>
    <p className="fine-print">Captured {audit.references.length} of {audit.safeReferenceCount} safe references; {audit.uncapturedSafeReferenceCount} safe references were not captured because of the 100-reference limit. These URLs describe investigation-time search leads, not verified sources, authority or answers. Missing references do not establish complete upstream coverage.</p>
    <p className="fine-print">Only URLs and retrieval metadata are retained here. Titles, snippets and raw provider responses are excluded, so this audit cannot replay lexical ranking. Search numbers identify the first owning search after deduplication, not every appearance. Separate candidate IDs can share a normalized URL; these counts do not establish distinct sources or independent corroboration. Opening this section performs no retrieval.</p>
    <ul className="fine-print">{audit.searches.map(search => <li key={search.searchIndex}>Search {search.searchIndex + 1}: {search.outcome === 'unavailable' ? `unavailable; ${failureDescription(search.failure)}; normalization and duplicate counts unknown` : `${search.normalizedCount} normalized results; ${search.droppedBeforeNormalizationCount} malformed or unsupported rows omitted before normalization; ${search.duplicateCount} canonical duplicates`}</li>)}</ul>
    <ol className="fine-print">{audit.references.map(row => <li key={row.candidateId}>
      <a className="text-link source-url" href={row.sourceUrl} target="_blank" rel="noopener noreferrer">{row.sourceUrl}</a>
      <p>Search {row.searchIndex + 1} · provider rank {row.providerRank ?? 'unknown'} · {row.disposition === 'retained' ? 'Selected for retained evidence' : 'Not retained as evidence'}</p>
    </li>)}</ol>
  </details>;
}
