/** Bounded retrieval, never a generative answer substituted for source evidence. */
import { randomUUID } from 'node:crypto';
import { CASE_SCHEMA_VERSION, type CaseRecord, type CaseEvidence, type SourcedDate, type CaseSourceRead } from '../cases/model';
import { parseCaseRecord } from '../cases/parse';
import { caseFromImageInvestigation } from '../cases/from-image-investigation';
import { type InvestigationResult } from '../investigation/contracts/investigation';
import { resolveEvidenceDate, type EvidenceDateSources } from '../investigation/dates';
import { runInvestigation, type RunDeps } from '../investigation/run';
import { retainableSourceUrl } from '../pages/source-reference';
import { bindFetchedSource } from '../pages/source-binding';
import type { JevAskResult } from '../jev/client';
import { assessClaimSource, buildClaimReport, CLAIM_QUESTIONS, explicitTopicClaim, type ClaimSourceAssessment } from './claim-report';
import { extractPage, selectDisplayQuote } from '../pages/extract';
import { hasSearchResultSurface, normalizeSearchResponse } from '../serpapi/normalize';
import { serpapiResponseFailed } from '../serpapi/client';
import { prepareVideo, type PreparedVideo } from '../video/ingest';
import { AUTOMATIC_RESEARCH_LIMITS as LIMITS, type AutomaticResearchInput, type AutomaticResearchEvent, type AutomaticResearchResult } from './automatic-contract';
import { selectTopicSources, type TopicCandidate } from './topic-selection';
import { researchStageCopy } from './display-copy';
import { buildTopicCandidateAudit } from './topic-candidate-audit';
import type { TopicCandidateSearchAudit } from '../cases/topic-candidate-audit';
import { TopicSearchResponseError, topicSearchFailure } from './topic-search-failure';

type Progress = (event: AutomaticResearchEvent) => void;
export interface AutomaticResearchDeps extends RunDeps {
  prepareVideo?: typeof prepareVideo;
  traceFrame?: typeof runInvestigation;
}
function check(deps: RunDeps): void { deps.signal?.throwIfAborted(); }
function publicationDate(sources: EvidenceDateSources, url: string, now: Date): SourcedDate {
  const resolved = resolveEvidenceDate(sources, now);
  if (resolved.dateStatus === 'disputed') return { status: 'disputed', observations: [], reason: 'Retrieved publication dates disagree.' };
  if (resolved.dateStatus !== 'usable' || !resolved.publishedAt || resolved.datePrecision === 'unknown' || !resolved.publishedAtSource) return { status: 'unknown', reason: 'No usable source-backed publication date was retrieved.' };
  const observation = { value: resolved.publishedAt.slice(0, resolved.datePrecision === 'year' ? 4 : resolved.datePrecision === 'month' ? 7 : 10), precision: resolved.datePrecision,
    source: { kind: resolved.publishedAtSource === 'serpapi' ? 'search_metadata' : resolved.publishedAtSource, url, recordedValue: resolved.publishedAt } } satisfies import('../cases/model').DateObservation;
  return resolved.publishedAtSource === 'serpapi'
    ? { status: 'inferred', observation, rationale: 'Date resolved from search metadata; source publication not independently verified.' }
    : { status: 'observed', observation };
}
function emptyCase(now: string): CaseRecord {
  return { schemaVersion: CASE_SCHEMA_VERSION, id: `research-${randomUUID()}`, revision: 1, createdAt: now,
    claims: [], assets: [], evidence: [], occurrences: [], relations: [],
    coverage: { scope: 'retrieved_evidence', completeness: 'partial', omittedEvidenceCount: 0,
      originalPublication: { status: 'unknown', reason: 'A bounded retrieved sample cannot establish original publication.' },
      searches: [], limitations: [] } };
}

export async function investigateTopic(topic: string, emit: Progress, deps: AutomaticResearchDeps): Promise<AutomaticResearchResult> {
  if (!deps.serpapi) throw new Error('Search provider unavailable.');
  const now = new Date(deps.now?.() ?? Date.now());
  const record = emptyCase(now.toISOString());
  const limitations = ['Bounded web sample; coverage is incomplete.', 'Primary-source coverage has not been independently established. Original-account cues in titles or snippets guide selection; they do not verify source authority or completeness.', 'Search results are leads, not independent corroboration.', 'Relevance assessments do not verify claims.', 'Source snapshots are not retained; links may change.', 'Credential-bearing or unsafe source links are omitted rather than rewritten.'];
  const candidates = new Map<string, TopicCandidate>();
  const candidateSearches: TopicCandidateSearchAudit[] = [];
  const searches = [
    { engine: 'google', q: topic, kind: 'google_search' },
    { engine: 'google_news', q: topic, kind: 'google_news' },
    { engine: 'google', q: `${topic} statement clarification counterevidence correction`, kind: 'google_search' },
  ] satisfies Array<{ engine: string; q: string; kind: 'google_search' | 'google_news' }>;
  for (const [index, query] of searches.entries()) {
    check(deps);
    emit({ type: 'research.progress', message: `Searching ${index === 1 ? 'news' : index === 2 ? 'counterevidence and alternative explanations' : 'the web'}…` });
    const log = { engine: query.engine, attempted: 1, returned: 0, retained: 0, searchId: null as string | null };
    record.coverage.searches.push(log);
    candidateSearches.push({ searchIndex: index, outcome: 'unavailable', normalizedCount: null, droppedBeforeNormalizationCount: null, duplicateCount: null });
    try {
      const raw = await deps.serpapi.search({ engine: query.engine, q: query.q, num: '10' }, deps.signal);
      check(deps);
      if (serpapiResponseFailed(raw) || !hasSearchResultSurface(raw, query.kind)) throw new TopicSearchResponseError(raw);
      const batch = normalizeSearchResponse(raw, query.kind, { retrievedAt: now.toISOString() });
      log.returned = batch.reportedCount; log.searchId = batch.searchId;
      let duplicateCount = 0;
      for (const candidate of batch.candidates) {
        const existing = candidates.get(candidate.canonicalUrl);
        const date = batch.dateTexts.get(candidate.id);
        if (existing) {
          duplicateCount++;
          if (date) (existing.dates.serpapiAlternates ??= []).push(date);
        } else candidates.set(candidate.canonicalUrl, { candidate, dates: { serpapi: date }, search: index });
      }
      candidateSearches[index] = { searchIndex: index, outcome: 'succeeded', normalizedCount: batch.candidates.length,
        droppedBeforeNormalizationCount: batch.reportedCount - batch.candidates.length, duplicateCount };
    } catch (error) {
      check(deps);
      candidateSearches[index] = { searchIndex: index, outcome: 'unavailable', normalizedCount: null,
        droppedBeforeNormalizationCount: null, duplicateCount: null, failure: topicSearchFailure(error) };
      limitations.push(`Search ${index + 1} was unavailable; no replacement results were invented.`);
    }
  }
  // Safe document leads get bounded priority, then lexical tiers balance
  // search surfaces. Returned order also determines the five page reads.
  const selected = selectTopicSources(topic, [...candidates.values()]);
  record.coverage.omittedEvidenceCount = Math.max(0, candidates.size - selected.length);
  const assessments: AutomaticResearchResult['assessments'] = [];
  const sourceReads: CaseSourceRead[] = [];
  record.coverage.sourceReads = sourceReads;
  const claimSources: ClaimSourceAssessment[] = [];
  const claim = explicitTopicClaim(topic);
  for (const [index, entry] of selected.entries()) {
    check(deps);
    const { candidate, dates } = entry;
    const sourceUrl = retainableSourceUrl(candidate.sourceUrl);
    if (!sourceUrl) { record.coverage.omittedEvidenceCount++; limitations.push('A source with an unsafe or oversized URL was omitted.'); continue; }
    let finalUrl = sourceUrl;
    let quote = candidate.snippet?.slice(0, 8000) ?? null;
    let attribution: 'page_quote' | 'search_snippet' = 'search_snippet';
    let title = candidate.title;
    let retainedDates = dates;
    const read: CaseSourceRead = { evidenceId: candidate.id, requestedUrl: sourceUrl, finalUrl: null, sourceBinding: 'not_established', outcome: 'not_attempted' };
    sourceReads.push(read);
    if (index < LIMITS.topicPageReads) {
      emit({ type: 'research.progress', message: `Reading source ${index + 1} of ${Math.min(selected.length, LIMITS.topicPageReads)}…` });
      try {
        const page = await deps.fetchPage(candidate.sourceUrl, deps.signal);
        check(deps);
        const extractedUrl = retainableSourceUrl(page.url);
        read.finalUrl = extractedUrl;
        read.sourceBinding = bindFetchedSource(sourceUrl, page.url);
        if (!extractedUrl || (read.sourceBinding !== 'same_resource' && read.sourceBinding !== 'normalized_resource')) {
          read.outcome = 'binding_rejected';
          limitations.push(`Source ${index + 1} led to an unrelated, blocked or unsafe destination. Its original search lead remains; destination text and dates were not used.`);
        } else {
          const extracted = extractPage(page.html, page.url);
          const actualQuote = selectDisplayQuote({ title: extracted.title, claim: topic, paragraphs: extracted.paragraphs });
          if (actualQuote) {
            read.outcome = 'page_quote';
            finalUrl = extractedUrl;
            retainedDates = { ...dates, pageJsonLd: extracted.jsonLdDates[0], pageMeta: extracted.metaDates[0], pageTime: extracted.timeDates[0] };
            quote = actualQuote; attribution = 'page_quote'; title = extracted.title;
          } else {
            read.outcome = extracted.paragraphs.length ? 'no_matching_quote' : 'no_readable_text';
            const retainedLead = quote?.trim() ? 'its search snippet remains an unverified lead' : 'only its source reference remains';
            limitations.push(extracted.paragraphs.length
              ? `Source ${index + 1} had no page paragraph with lexical overlap to the question; ${retainedLead}. Relevant wording may have been missed.`
              : `Source ${index + 1} had no readable page text; ${retainedLead}.`);
          }
        }
      } catch { check(deps); read.outcome = 'fetch_failed'; limitations.push(`Source ${index + 1} could not be read; its original search lead remains.`); }
    }
    const evidence: CaseEvidence = { id: candidate.id, sourceUrl: finalUrl, title: title?.trim().slice(0, 2000) || null,
      content: quote?.trim() ? { kind: 'text', text: quote, attribution } : { kind: 'reference' },
      publicationDate: publicationDate(retainedDates, finalUrl, now),
      provenance: { method: attribution === 'page_quote' ? 'page_extraction' : 'retrieval', toolVersion: null,
        capturedAt: null, retrievedAt: now.toISOString(), rights: 'unknown', retention: 'reference_only', contentHash: null } };
    record.evidence.push(evidence); record.coverage.searches[entry.search].retained++;
    let answer: JevAskResult | null = null;
    if (deps.jev && quote) {
      emit({ type: 'research.progress', message: `Assessing the scope and excerpt relationship of source ${index + 1}…` });
      try {
        answer = await deps.jev.ask({ topic, claim, evidence: { title, excerpt: quote, attribution } }, CLAIM_QUESTIONS, deps.signal);
        check(deps);
      } catch { check(deps); }
    }
    const assessed = assessClaimSource(evidence, claim, answer);
    claimSources.push(assessed);
    assessments.push({ evidenceId: evidence.id, relevance: assessed.relevance, model: assessed.relevance === null ? null : assessed.model });
  }
  if (!record.evidence.length) limitations.push('No usable source evidence was retrieved. The topic remains unresolved.');
  if (assessments.some(item => item.relevance === null)) limitations.push('Some relevance assessments were unavailable; those sources remain unassessed leads.');
  record.coverage.limitations = [...new Set(limitations)];
  record.coverage.topicCandidateAudit = buildTopicCandidateAudit([...candidates.values()], selected, candidateSearches);
  return { kind: 'topic', question: topic, caseRecord: parseCaseRecord(record), frames: [], limitations: record.coverage.limitations, assessments, claimReport: buildClaimReport(topic, record, claimSources) };
}

function videoCase(video: PreparedVideo, timestampMs: number, result: InvestigationResult, now: string): CaseRecord {
  const record = caseFromImageInvestigation({ result, id: `research-${randomUUID()}`, createdAt: now });
  record.assets = [{ id: video.mediaId, kind: 'video', durationMs: Math.round(video.durationMs), location: { kind: 'not_retained' },
    provenance: { method: 'user_submission', toolVersion: null, capturedAt: null, retrievedAt: null, rights: 'user_provided', retention: 'not_retained', contentHash: `sha256:${video.contentHash}` } }];
  record.occurrences = record.occurrences.map(item => ({ ...item, assetId: video.mediaId, span: { kind: 'time', startMs: Math.floor(timestampMs), durationMs: 1 },
    identity: { status: 'unknown', reason: 'A sampled still-frame search is a lead for this video interval; it does not establish identity of the whole video.' } }));
  record.coverage.limitations = [...record.coverage.limitations.filter(value => value !== 'image_investigation_only'),
    'Only one representative decoded frame was searched. Other frames and audio were not searched.',
    'Frame matches do not establish the source, continuity or authenticity of the whole video.',
    'Decoded timestamps are offsets within the supplied video, not publication dates.'];
  return parseCaseRecord(record);
}
export async function runAutomaticResearch(input: AutomaticResearchInput, emit: Progress, deps: AutomaticResearchDeps): Promise<AutomaticResearchResult> {
  check(deps);
  if (input.kind === 'topic') return investigateTopic(input.topic, emit, deps);
  emit({ type: 'research.progress', message: 'Decoding timestamped frames locally…' });
  const video = await (deps.prepareVideo ?? prepareVideo)(input.bytes, { signal: deps.signal });
  check(deps);
  const frame = video.frames[Math.floor(video.frames.length / 2)];
  if (!frame) throw new Error('No representative frame could be decoded.');
  emit({ type: 'research.progress', message: `Searching one representative frame at ${(frame.timestampMs / 1000).toFixed(2)} seconds…` });
  let imageResult: InvestigationResult | undefined;
  let failure: string | undefined;
  await (deps.traceFrame ?? runInvestigation)({ media: frame.bytes, claim: input.claim ?? null, timezone: 'UTC', locale: 'en' }, event => {
    if (event.type === 'investigation.completed') imageResult = event.result;
    if (event.type === 'investigation.error') failure = event.message;
    if (event.type === 'stage.started') emit({ type: 'research.progress', message: researchStageCopy(event.stage) });
  }, deps);
  check(deps);
  if (!imageResult) throw new Error(failure ?? 'The sampled frame investigation did not complete.');
  const record = videoCase(video, frame.timestampMs, imageResult, new Date(deps.now?.() ?? Date.now()).toISOString());
  return { kind: 'video', question: input.claim?.trim() ? input.claim : 'Where has this sampled video frame appeared, and in what context?', caseRecord: record,
    frames: [{ timestampMs: frame.timestampMs, imageResult }], limitations: record.coverage.limitations, assessments: [] };
}
