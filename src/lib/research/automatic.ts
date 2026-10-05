/** Bounded retrieval, never a generative answer substituted for source evidence. */
import { createHash, randomUUID } from 'node:crypto';
import { CASE_SCHEMA_VERSION, type CaseRecord, type CaseEvidence, type SourcedDate, type CaseSourceRead } from '../cases/model';
import { parseCaseRecord } from '../cases/parse';
import { caseFromImageInvestigation } from '../cases/from-image-investigation';
import { type InvestigationResult } from '../investigation/contracts/investigation';
import { resolveEvidenceDate, type EvidenceDateSources } from '../investigation/dates';
import { runInvestigation, type RunDeps, type SearchProvider } from '../investigation/run';
import { retainableSourceUrl } from '../pages/source-reference';
import { bindFetchedSource } from '../pages/source-binding';
import type { JevAskResult } from '../jev/client';
import { assessClaimSource, buildClaimReport, CLAIM_QUESTIONS, explicitTopicClaim, type ClaimSourceAssessment } from './claim-report';
import { topicPassages } from './topic-passages';
import { extractPage } from '../pages/extract';
import { hasSearchResultSurface, normalizeSearchResponse } from '../serpapi/normalize';
import { serpapiResponseFailed } from '../serpapi/client';
import { transcribeMedia } from '../video/transcribe';
import { speechSearchQuestion, unavailableTranscript, type MediaTranscript } from '../video/transcript';
import { prepareVideo, type PreparedVideo } from '../video/ingest';
import { AUTOMATIC_RESEARCH_LIMITS as LIMITS, type AutomaticResearchInput, type AutomaticResearchEvent, type AutomaticResearchResult } from './automatic-contract';
import { selectTopicSources, type TopicCandidate } from './topic-selection';
import { researchStageCopy } from './display-copy';
import { buildTopicCandidateAudit } from './topic-candidate-audit';
import type { TopicCandidateSearchAudit } from '../cases/topic-candidate-audit';
import { TopicSearchResponseError, topicSearchFailure } from './topic-search-failure';
import { documentQuery, followupSearches, type ResearchSearch } from './search-plan';

type Progress = (event: AutomaticResearchEvent) => void;
export interface AutomaticResearchDeps extends RunDeps {
  /** Shares the run lease, with topic timing independent of image searches. */
  topicSerpapi?: Pick<SearchProvider, 'search'>;
  prepareVideo?: typeof prepareVideo;
  transcribeMedia?: typeof transcribeMedia;
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
  const searchProvider = deps.topicSerpapi ?? deps.serpapi;
  if (!searchProvider) throw new Error('Search provider unavailable.');
  const now = new Date(deps.now?.() ?? Date.now());
  const record = emptyCase(now.toISOString());
  const limitations = ['Bounded web sample; coverage is incomplete.', 'PDF reading is text-only, limited to the first twelve pages and 64,000 extracted characters. Scanned pages, audio, figures and later pages are not inspected.', 'Primary-source coverage has not been independently established. Original-account cues in titles or snippets guide selection; they do not verify source authority or completeness.', 'Search results are leads, not independent corroboration.', 'Relevance assessments do not verify claims.', 'Source snapshots are not retained; links may change.', 'Credential-bearing or unsafe source links are omitted rather than rewritten.'];
  const candidates = new Map<string, TopicCandidate>();
  const candidateSearches: TopicCandidateSearchAudit[] = [];
  const searchQuestion = explicitTopicClaim(topic) ?? topic;
  const searches: ResearchSearch[] = [
    { engine: 'google', q: searchQuestion, kind: 'google_search', purpose: 'the web' },
    { engine: 'google_news', q: searchQuestion, kind: 'google_news', purpose: 'news' },
    { engine: 'google', q: documentQuery(searchQuestion), kind: 'google_search', purpose: 'source documents and clarifications' },
  ];
  const searchBatch = async (queries: ResearchSearch[], firstIndex: number): Promise<void> => {
    // Settle all dispatched requests before propagating cancellation. Otherwise
    // a fast failure could release the shared lease while a provider is active.
    const outcomes = await Promise.allSettled(queries.map(async query => {
      check(deps);
      emit({ type: 'research.progress', message: `Searching ${query.purpose}…` });
      const raw = await searchProvider.search({ engine: query.engine, q: query.q, num: '10' }, deps.signal);
      return { raw, retrievedAt: new Date(deps.now?.() ?? Date.now()).toISOString() };
    }));
    check(deps);
    // Merge in plan order, not completion order, so duplicates retain stable
    // source ownership, date observations and audit indices.
    for (const [offset, query] of queries.entries()) {
      const index = firstIndex + offset;
      const log = { engine: query.engine, attempted: 1, returned: 0, retained: 0, searchId: null as string | null };
      record.coverage.searches.push(log);
      candidateSearches.push({ searchIndex: index, outcome: 'unavailable', normalizedCount: null, droppedBeforeNormalizationCount: null, duplicateCount: null });
      try {
        const outcome = outcomes[offset];
        if (outcome.status === 'rejected') throw outcome.reason;
        const { raw, retrievedAt } = outcome.value;
        if (serpapiResponseFailed(raw) || !hasSearchResultSurface(raw, query.kind)) throw new TopicSearchResponseError(raw);
        const batch = normalizeSearchResponse(raw, query.kind, { retrievedAt });
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
  };
  await searchBatch(searches, 0);
  // Continue independently into the missing facets of a nonempty trail.
  // An empty/unavailable initial pass does not authorize speculative retries.
  if (candidates.size > 0) await searchBatch(followupSearches(topic), searches.length);
  // Safe document leads get bounded priority, then lexical tiers balance
  // search surfaces. Returned order also determines the bounded page reads.
  const selected = selectTopicSources(topic, [...candidates.values()]);
  const originalSelectionLength = selected.length;
  const referenceLeads: TopicCandidate[] = [];
  const knownUrls = new Set([...candidates.keys()]);
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
    let retrievedAt = entry.reference ? null : candidate.retrievals[0]?.retrievedAt ?? now.toISOString();
    const read: CaseSourceRead = { ...(entry.reference ? { reference: entry.reference } : {}), evidenceId: candidate.id, requestedUrl: sourceUrl, finalUrl: null, sourceBinding: 'not_established', outcome: 'not_attempted' };
    sourceReads.push(read);
    if (index < LIMITS.topicPageReads) {
      emit({ type: 'research.progress', message: `Reading source ${index + 1} of ${Math.min(selected.length, LIMITS.topicPageReads)}…` });
      try {
        const page = await deps.fetchPage(candidate.sourceUrl, deps.signal);
        check(deps);
        const extractedUrl = retainableSourceUrl(page.url);
        read.finalUrl = extractedUrl;
        read.sourceBinding = entry.reference && extractedUrl ? 'reference_destination' : bindFetchedSource(sourceUrl, page.url);
        if (!extractedUrl || (read.sourceBinding !== 'same_resource' && read.sourceBinding !== 'normalized_resource' && read.sourceBinding !== 'reference_destination')) {
          read.outcome = 'binding_rejected';
          limitations.push(`Source ${index + 1} led to an unrelated, blocked or unsafe destination. Its original search lead remains; destination text and dates were not used.`);
        } else {
          const extracted = extractPage(page.html, page.url);
          let actualQuote = topicPassages(topic, extracted.paragraphs);
          // Follow only explicit references within inspected article paragraphs.
          // Reserve two of the existing read/source slots; no recursive crawl,
          // provider call, guessed URL or authority whitelist is introduced.
          if (actualQuote && !entry.reference && index < Math.min(8, originalSelectionLength)) {
            const topicTerms = new Set((searchQuestion.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(word => !/^(?:the|and|for|from|with|this|that|how|why|what|when|where|which|who|was|were|has|have|does|did|can|could|should|would|will|evidence|research|investigate|read|article|report|source|study|more)$/.test(word)));
            const acronyms = new Set((searchQuestion.match(/\b[A-Z][A-Z0-9]{1,8}\b/g) ?? []).map(word => word.toLowerCase()));
            for (const link of extracted.sourceLinks) {
              if (referenceLeads.length >= 2 || !link.text.trim() || knownUrls.has(link.url) || !retainableSourceUrl(link.url)) continue;
              // Surrounding citation wording also contains author and hashtag
              // links. Require an actual document cue on the anchor, or an
              // explicitly displayed URL; never spend a read on sign-up/profile
              // navigation just because its paragraph discusses research.
              if (/^#|^(?:sign[ -]?in|sign[ -]?up|log[ -]?in|join|subscribe)\b/i.test(link.text) || /\/(?:signup|login|signin|auth|subscribe)(?:\/|$)/i.test(new URL(link.url).pathname)) continue;
              if (!/^https?:\/\//i.test(link.text) && !/\b(?:study|research|report|article|source|paper|publication|read|original|full|download)\b/i.test(link.text)) continue;
              if (referenceLeads.some(lead => lead.reference?.text === link.text)) continue;
              const words = (link.supportingText + ' ' + link.text).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
              if ((!words.some(word => acronyms.has(word)) && new Set(words.filter(word => topicTerms.has(word))).size < 2) || !/\b(?:study|research|report|article|source|data|paper|according|publication|read|original)\b/i.test(link.supportingText + ' ' + link.text)) continue;
              if (!actualQuote.includes(link.supportingText)) {
                if (actualQuote.length + link.supportingText.length + 2 > 8000) continue;
                actualQuote += '\n\n' + link.supportingText;
              }
              knownUrls.add(link.url);
              referenceLeads.push({ candidate: { ...candidate, id: `reference-${randomUUID()}`, sourceUrl: link.url, canonicalUrl: link.url, title: link.text, snippet: null, serpPosition: null }, dates: {}, search: -1, reference: { fromEvidenceId: candidate.id, text: link.text, supportingText: link.supportingText } });
            }
          }
          if (actualQuote) {
            read.outcome = 'page_quote';
            retrievedAt = new Date(deps.now?.() ?? Date.now()).toISOString();
            finalUrl = extractedUrl;
            retainedDates = { ...dates, pageJsonLd: extracted.jsonLdDates[0], pageMeta: extracted.metaDates[0], pageTime: extracted.timeDates[0] };
            quote = actualQuote; attribution = 'page_quote'; title = extracted.title ?? title;
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
        capturedAt: null, retrievedAt, rights: 'unknown', retention: 'reference_only', contentHash: null } };
    record.evidence.push(evidence); if (!entry.reference) record.coverage.searches[entry.search].retained++;
    if (index === Math.min(8, originalSelectionLength) - 1 && referenceLeads.length) {
      selected.splice(index + 1, 0, ...referenceLeads); selected.splice(LIMITS.topicSources);
      emit({ type: 'research.progress', message: `Following ${referenceLeads.length} explicit source references…` });
    }
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
  if (referenceLeads.length) limitations.push('Up to two one-hop references from inspected passages were followed within the existing read/source limits. A citation does not establish authority, independence or truth. Destination passages and dates belong to the destination, not the referring page.');
  record.coverage.omittedEvidenceCount = Math.max(0, candidates.size - selected.filter(entry => !entry.reference).length);
  record.coverage.limitations = [...new Set(limitations)];
  record.coverage.topicCandidateAudit = buildTopicCandidateAudit([...candidates.values()], selected.filter(entry => !entry.reference), candidateSearches);
  return { kind: 'topic', question: topic, caseRecord: parseCaseRecord(record), frames: [], limitations: record.coverage.limitations, assessments, claimReport: buildClaimReport(topic, record, claimSources) };
}

function videoCase(video: PreparedVideo, timestampMs: number, result: InvestigationResult, now: string): CaseRecord {
  const record = caseFromImageInvestigation({ result, id: `research-${randomUUID()}`, createdAt: now });
  record.assets = [{ id: video.mediaId, kind: 'video', durationMs: Math.round(video.durationMs), location: { kind: 'not_retained' },
    provenance: { method: 'user_submission', toolVersion: null, capturedAt: null, retrievedAt: null, rights: 'user_provided', retention: 'not_retained', contentHash: `sha256:${video.contentHash}` } }];
  record.occurrences = record.occurrences.map(item => ({ ...item, assetId: video.mediaId, span: { kind: 'time', startMs: Math.floor(timestampMs), durationMs: 1 },
    identity: { status: 'unknown', reason: 'A sampled still-frame search is a lead for this video interval; it does not establish identity of the whole video.' } }));
  record.coverage.limitations = [...record.coverage.limitations.filter(value => value !== 'image_investigation_only'),
    'Decoded still-frame samples are searched independently. Unsampled visual intervals are not searched. Speech recognition and its text research are reported separately.',
    'Frame matches do not establish the source, continuity or authenticity of the whole video.',
    'Decoded timestamps are offsets within the supplied video, not publication dates.'];
  return parseCaseRecord(record);
}
async function recognizedSpeech(input: Exclude<AutomaticResearchInput, { kind: 'topic' }>, emit: Progress, deps: AutomaticResearchDeps): Promise<MediaTranscript> {
  emit({ type: 'research.progress', message: 'Transcribing the full audio track locally…' });
  try { return await (deps.transcribeMedia ?? transcribeMedia)(input.bytes, deps.signal); }
  catch { check(deps); return unavailableTranscript('Local speech recognition failed. No replacement transcription was invented.'); }
}
async function audioResearch(input: Exclude<AutomaticResearchInput, { kind: 'topic' }>, transcript: MediaTranscript, emit: Progress, deps: AutomaticResearchDeps): Promise<AutomaticResearchResult | undefined> {
  const question = speechSearchQuestion(transcript, input.claim ?? null) ?? (input.kind === 'audio' && input.claim?.trim() ? `Claim: ${input.claim.trim()}` : null);
  if (!question) return undefined;
  emit({ type: 'research.progress', message: 'Investigating unreviewed spoken leads against web sources…' });
  const result = await investigateTopic(question, emit, deps);
  const contentHash = createHash('sha256').update(input.bytes).digest('hex');
  result.caseRecord.assets = [{ id: `${input.kind}:sha256:${contentHash}`, kind: input.kind, durationMs: transcript.durationMs === null ? null : Math.round(transcript.durationMs), location: { kind: 'not_retained' },
    provenance: { method: 'user_submission', toolVersion: null, capturedAt: null, retrievedAt: null, rights: input.rights, retention: 'not_retained', contentHash: `sha256:${contentHash}` } }];
  result.caseRecord.coverage.limitations.push('The transcript is an unreviewed machine recognition. Source relevance does not verify its wording or establish that a speaker said it.');
  result.caseRecord = parseCaseRecord(result.caseRecord);
  if (result.claimReport) result.claimReport = buildClaimReport(question, result.caseRecord, result.claimReport.sources);
  return { ...result, caseRecord: parseCaseRecord(result.caseRecord), limitations: result.caseRecord.coverage.limitations };
}
function partialVideoResult(input: Exclude<AutomaticResearchInput, { kind: 'topic' }>, transcript: MediaTranscript, spokenResearch: AutomaticResearchResult | undefined, reasons: string[], now: string, video?: PreparedVideo): AutomaticResearchResult {
  const record = emptyCase(now), hash = video?.contentHash ?? createHash('sha256').update(input.bytes).digest('hex');
  record.assets = [{ id: video?.mediaId ?? `video:sha256:${hash}`, kind: 'video', durationMs: video ? Math.round(video.durationMs) : transcript.durationMs === null ? null : Math.round(transcript.durationMs), location: { kind: 'not_retained' }, provenance: { method: 'user_submission', toolVersion: null, capturedAt: null, retrievedAt: null, rights: input.rights, retention: 'not_retained', contentHash: `sha256:${hash}` } }];
  record.coverage.limitations = [...reasons, 'No completed visual search was retained. The speech trail is separate; it cannot verify visual identity, continuity or the caption.'];
  return { kind: 'video', question: input.claim?.trim() || 'What context can be recovered from this supplied video?', caseRecord: parseCaseRecord(record), frames: [], assessments: [], limitations: record.coverage.limitations, transcript, submittedClaim: input.claim ?? null, ...(video?.visualScan ? { visualScan: video.visualScan } : {}), ...(spokenResearch ? { spokenResearch } : {}) };
}
export async function runAutomaticResearch(input: AutomaticResearchInput, emit: Progress, deps: AutomaticResearchDeps): Promise<AutomaticResearchResult> {
  check(deps);
  if (input.kind === 'topic') return investigateTopic(input.topic, emit, deps);
  const transcript = await recognizedSpeech(input, emit, deps);
  check(deps);
  const spokenResearch = await audioResearch(input, transcript, emit, deps);
  check(deps);
  if (input.kind === 'audio') {
    const result = spokenResearch ?? { kind: 'topic' as const, question: input.claim?.trim() || 'What context can be recovered from this supplied audio?', caseRecord: emptyCase(new Date(deps.now?.() ?? Date.now()).toISOString()), frames: [], assessments: [], limitations: [] };
    if (!spokenResearch) {
      const hash = createHash('sha256').update(input.bytes).digest('hex');
      result.caseRecord.assets = [{ id: `audio:sha256:${hash}`, kind: 'audio', durationMs: transcript.durationMs === null ? null : Math.round(transcript.durationMs), location: { kind: 'not_retained' }, provenance: { method: 'user_submission', toolVersion: null, capturedAt: null, retrievedAt: null, rights: 'user_provided', retention: 'not_retained', contentHash: `sha256:${hash}` } }];
      result.caseRecord.coverage.limitations = ['No usable recognized speech was available for automatic searching. Audio authenticity and speaker identity remain unknown.'];
    }
    return { ...result, kind: 'audio', transcript, submittedClaim: input.claim ?? null, limitations: [...result.caseRecord.coverage.limitations, ...transcript.limitations] };
  }
  emit({ type: 'research.progress', message: 'Decoding timestamped frames locally…' });
  let video: PreparedVideo;
  try { video = await (deps.prepareVideo ?? prepareVideo)(input.bytes, { signal: deps.signal, scanTrack: true }); }
  catch { check(deps); return partialVideoResult(input, transcript, spokenResearch, ['The visual track could not be decoded within its format, size, duration or process limits.'], new Date(deps.now?.() ?? Date.now()).toISOString()); }
  check(deps);
  if (!video.frames.length || video.frames.length > 3) throw new Error('The decoder must supply between one and three bounded frames.');
  const frames: AutomaticResearchResult['frames'] = [], cases: CaseRecord[] = [], failures: string[] = [];
  // Do not spend multiple uploads on byte-identical decoded frames.
  const samples = video.frames.filter((frame, index, all) => all.findIndex(other => other.contentHash === frame.contentHash) === index);
  for (const [index, frame] of samples.entries()) {
    check(deps);
    emit({ type: 'research.progress', message: `Searching frame ${index + 1} of ${samples.length} at ${(frame.timestampMs / 1000).toFixed(2)} seconds…` });
    let imageResult: InvestigationResult | undefined, failure: string | undefined;
    await (deps.traceFrame ?? runInvestigation)({ media: frame.bytes, claim: input.claim ?? null, timezone: 'UTC', locale: 'en' }, event => {
      if (event.type === 'investigation.completed') imageResult = event.result;
      if (event.type === 'investigation.error') failure = event.message;
      if (event.type === 'stage.started') emit({ type: 'research.progress', message: `Frame ${index + 1} of ${samples.length}: ${researchStageCopy(event.stage)}` });
    }, deps);
    check(deps);
    if (!imageResult) { failures.push(`Frame at ${(frame.timestampMs / 1000).toFixed(2)} seconds did not complete: ${failure ?? 'No complete result was returned.'}`); continue; }
    frames.push({ timestampMs: frame.timestampMs, imageResult });
    cases.push(videoCase(video, frame.timestampMs, imageResult, new Date(deps.now?.() ?? Date.now()).toISOString()));
  }
  const first = cases[0]; if (!first) return partialVideoResult(input, transcript, spokenResearch, failures, new Date(deps.now?.() ?? Date.now()).toISOString(), video);
  const record = parseCaseRecord({ ...first, evidence: cases.flatMap(item => item.evidence), occurrences: cases.flatMap(item => item.occurrences), relations: cases.flatMap(item => item.relations), coverage: {
    ...first.coverage, searches: cases.flatMap(item => item.coverage.searches), omittedEvidenceCount: cases.reduce((sum, item) => sum + item.coverage.omittedEvidenceCount, 0),
    limitations: [...new Set([...cases.flatMap(item => item.coverage.limitations), ...failures, `${frames.length} distinct sampled frames completed; ${samples.length - frames.length} failed. ${video.frames.length - samples.length} byte-identical samples were skipped.`])],
  } });
  return { kind: 'video', ...(video.visualScan ? { visualScan: video.visualScan } : {}), transcript, submittedClaim: input.claim ?? null, ...(spokenResearch ? { spokenResearch } : {}), question: input.claim?.trim() ? input.claim : 'Where have these sampled video frames appeared, and in what context?', caseRecord: record, frames, limitations: record.coverage.limitations, assessments: [] };
}
