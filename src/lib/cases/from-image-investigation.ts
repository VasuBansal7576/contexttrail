import type { InvestigationResult, TimelineItem } from '../investigation/contracts/investigation';
import { retainableSourceUrl } from '../pages/source-reference';
import { CASE_SCHEMA_VERSION, type CaseEvidence, type CaseRecord, type CaseRelation, type MediaOccurrence, type Provenance, type SourcedDate } from './model';
import { parseCaseRecord } from './parse';

function publicationDate(item: TimelineItem, sourceUrl: string): SourcedDate {
  if (item.dateStatus === 'disputed') {
    // Historical results retain rejected values, but not each candidate's source.
    // Do not assign the winning field's provenance to those rejected dates.
    return { status: 'disputed', observations: [], reason: 'Image investigation reported conflicting dates; see the original dateProvenance record.' };
  }
  const value = item.dateProvenance.value;
  const precision = item.dateProvenance.precision;
  const source = item.dateProvenance.source;
  if (item.dateStatus !== 'usable' || !value || precision === 'unknown' || source === null) {
    return { status: 'unknown', reason: 'No usable source-backed publication date was retained.' };
  }
  const observation = {
    value: precision === 'year' ? value.slice(0, 4) : precision === 'month' ? value.slice(0, 7) : value.slice(0, 10),
    precision,
    source: { kind: source === 'serpapi' ? 'search_metadata' : source, url: sourceUrl, recordedValue: value },
  } satisfies import('./model').DateObservation;
  return source === 'serpapi'
    ? { status: 'inferred', observation, rationale: 'Resolved from search metadata; the source publication date has not been independently verified.' }
    : { status: 'observed', observation };
}

/**
 * Add a case without changing image verdicts, source reports or policy gates.
 * No media bytes, provider upload URLs, new network calls or origin claims.
 */
export function caseFromImageInvestigation(input: {
  result: InvestigationResult;
  id: string;
  createdAt: string;
}): CaseRecord {
  const { result } = input;
  const submitted: Provenance = {
    method: 'user_submission', toolVersion: null, capturedAt: input.createdAt,
    retrievedAt: null, rights: 'user_provided', retention: 'not_retained', contentHash: null,
  };
  const evidence: CaseEvidence[] = [];
  const occurrences: MediaOccurrence[] = [];
  const relations: CaseRelation[] = [];
  const limitations: string[] = [...result.limitations];
  const seen = new Set<string>();
  let omittedEvidenceCount = 0;
  for (const item of [...result.timeline, ...result.undatedEvidence, ...result.supportingEvidence, ...result.contextualEvidence]) {
    if (seen.has(item.evidenceId)) continue;
    seen.add(item.evidenceId);
    const sourceUrl = retainableSourceUrl(item.sourceUrl);
    if (sourceUrl === null || sourceUrl.length > 4096) {
      limitations.push('case_reference_omitted_invalid_source');
      omittedEvidenceCount += 1;
      continue;
    }
    const excerpt = item.excerpt?.trim() ? item.excerpt : null;
    evidence.push({
      id: item.evidenceId, sourceUrl, title: item.title?.trim() ? item.title : null,
      content: excerpt !== null
        ? { kind: 'text', text: excerpt, attribution: item.excerptSource === 'page_text' ? 'page_quote' : item.excerptSource === 'serp_snippet' ? 'search_snippet' : 'classification_context' }
        : { kind: 'reference' },
      publicationDate: publicationDate(item, sourceUrl),
      provenance: {
        method: item.excerptSource === 'page_text' || item.excerptSource === 'page_composite' ? 'page_extraction' : 'retrieval',
        toolVersion: null,
        // The legacy pipeline retains retrieval time, not a page capture timestamp.
        capturedAt: null, retrievedAt: item.retrievedAt,
        rights: 'unknown', retention: 'reference_only', contentHash: null,
      },
    });
    if (item.mediaRelationship !== null) {
      const core = (item.mediaRelationship === 'EXACT_MATCH' && item.identityBasis === 'lens_exact_collection') ||
        (item.mediaRelationship === 'NEAR_MATCH' && item.identityBasis === 'local_spatial_verification');
      occurrences.push({
        id: item.occurrenceId, assetId: 'submitted-image', sourceEvidenceId: item.evidenceId, span: { kind: 'whole' },
        identity: core
          ? { status: 'inferred', evidenceIds: [item.evidenceId], method: item.identityBasis,
              rationale: 'Identity follows the existing provider/verifier assessment; no direct source-media inspection is added by this adapter.' }
          : { status: 'unknown', reason: 'Unverified visual lead; media identity is not established.' },
      });
    }
  }
  const evidenceIds = new Set(evidence.map(item => item.id));
  if (result.mode === 'claim_check') {
    for (const finding of result.sourceLinkedReport?.captionFindings ?? []) {
      if (!evidenceIds.has(finding.evidenceId)) continue;
      for (const signal of finding.signals) {
        relations.push({
          id: `${finding.evidenceId}:${signal.kind}`, kind: 'evidence_claim',
          evidenceId: finding.evidenceId, claimId: 'submitted-claim',
          relationship: signal.kind === 'caption_support' ? 'supports' : signal.kind === 'caption_contradiction' ? 'challenges' : 'context',
          assessment: { status: 'inferred', evidenceIds: [finding.evidenceId], method: finding.model,
            rationale: `Model-assessed ${signal.kind}. Displayed excerpt entailment was not separately verified; this is not a truth verdict.` },
        });
      }
    }
  }
  return parseCaseRecord({
    schemaVersion: CASE_SCHEMA_VERSION, id: input.id, revision: 1, createdAt: input.createdAt,
    claims: result.mode === 'claim_check'
      ? [{ id: 'submitted-claim', kind: 'text', text: result.claim, language: null, provenance: submitted }]
      : [],
    assets: [{ id: 'submitted-image', kind: 'image', location: { kind: 'not_retained' }, provenance: submitted }],
    evidence, occurrences, relations,
    coverage: {
      scope: 'retrieved_evidence', completeness: 'partial', omittedEvidenceCount,
      originalPublication: { status: 'unknown', reason: 'Earliest retrieved appearance does not establish original publication.' },
      limitations: [...new Set([...limitations, 'image_investigation_only', 'source_snapshots_not_retained', 'unsafe_source_urls_omitted', 'capture_times_unknown'])],
      searches: result.requestLog.map(({ engine, attempted, returned, retained, searchId }) => ({ engine, attempted, returned, retained, searchId })),
    },
  });
}
