'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import type { SavedVideoReport } from '@/lib/research/saved-video';
import type { MediaTranscript } from '@/lib/video/transcript';
import type { CaseEvidence, SourcedDate } from '@/lib/cases/model';
import { investigateAutomatically, type AutomaticResearchView, type AutomaticFrameSource } from '@/lib/research/automatic-client';
import { formatTimestamp } from '@/lib/video/matching/client';
import { CasebookShell, ChapterHeading } from './CasebookShell';
import { ClaimReportView } from './ClaimReportView';
import { ResearchAccount } from './ResearchAccount';
import { TopicCandidateAuditView } from './TopicCandidateAuditView';
import { CaptionFindings } from './CaptionFindings';
import { EvidenceCollection, EvidencePassage, SourceActions } from './EvidenceCollection';
import { useFilePreview } from './use-file-preview';
import SaveToCasebook from './SaveToCasebook';
import { VideoTrail } from './VideoTrail';
import type { AutomaticReadiness } from '@/lib/research/automatic-readiness';
import { researchLimitationCopy, researchProgressCopy } from '@/lib/research/display-copy';

type ResearchState = { kind: 'idle' | 'cancelled' } | { kind: 'running'; message: string } | { kind: 'error'; message: string } | { kind: 'complete'; result: AutomaticResearchView };

function ResearchLimitations({ values }: { values: string[] }) {
  if (!values.length) return null;
  return <section className="automatic-limitations" aria-label="Limits of this investigation">
    <h3>Limits of this investigation</h3>
    <ul>{[...new Set(values.map(researchLimitationCopy))].map(copy => <li key={copy}>{copy}</li>)}</ul>
    <details><summary>Inspect technical limitation details</summary><ul className="fine-print">{values.map((value, index) => <li key={index}>{value}</li>)}</ul></details>
  </section>;
}

function publicationLabel(date: SourcedDate): string {
  switch (date.status) {
    case 'observed': return `${date.observation.value} · observed publication date`;
    case 'inferred': return `${date.observation.value} · inferred publication date. ${date.rationale}`;
    case 'disputed': return `Publication date disputed. ${date.reason}`;
    case 'unknown': return `Publication date unknown. ${date.reason}`;
  }
}
function SourceEvidence({ evidence, assessment }: { evidence: CaseEvidence; assessment?: AutomaticResearchView['assessments'][number] }) {
  return <article className="source-card automatic-source">
    <p className="eyebrow">{evidence.content.kind === 'text' ? evidence.content.attribution.replaceAll('_', ' ') : 'Source reference'}</p>
    {assessment && assessment.relevance !== null && assessment.relevance < 0.5 ? <p className="fine-print">Low topic relevance · model-assessed lead, not supporting evidence.</p> : null}
    <details className="source-inspection"><summary><h3>{evidence.title ?? 'Untitled source'}</h3><span className="text-link">Inspect retained evidence</span></summary>
    <p className="fine-print">{publicationLabel(evidence.publicationDate)}</p>
    {assessment && assessment.relevance !== null ? <details className="automatic-relevance"><summary>Topic relevance · model assessment</summary><p className="fine-print">Relevance probability: {assessment.relevance}. Model: {assessment.model}. This assesses relevance to the question, not factual accuracy or whether the source supports the claim.</p></details> : <p className="fine-print">Topic relevance unassessed.</p>}
    {evidence.content.kind === 'text' ? <EvidencePassage text={evidence.content.text} /> : <p className="fine-print">No source text was retained for this record.</p>}
    </details><SourceActions url={evidence.sourceUrl} />
    <p className="fine-print">Retrieved: {evidence.provenance.retrievedAt ?? 'Unknown'} · {evidence.provenance.method.replaceAll('_', ' ')}</p>
  </article>;
}
function FrameSource({ source, label }: { source: AutomaticFrameSource; label: string }) {
  return <article className="source-card automatic-source">
    <p className="eyebrow">{label}</p><details className="source-inspection"><summary><h3>{source.title ?? 'Untitled source'}</h3><span className="text-link">Inspect retained evidence</span></summary>
    <p className="fine-print">{source.dateStatus === 'usable' && source.observedAt ? `${source.observedAt} · reported publication date` : `Publication date ${source.dateStatus === 'disputed' ? 'disputed' : 'unknown'}`} · Identity basis: {source.identityBasis.replaceAll('_', ' ')}</p>
    {source.excerpt ? <><p className="fine-print">{source.displayAttribution ?? source.excerptSource.replaceAll('_', ' ')}</p><EvidencePassage text={source.excerpt} /></> : <p className="fine-print">No source excerpt available.</p>}
    </details><SourceActions url={source.sourceUrl} />
  </article>;
}
function CaptionComparison({ comparison }: { comparison: NonNullable<AutomaticResearchView['frames'][number]['imageResult']['captionComparison']> }) {
  const labels = { CONTEXT_CONFLICT: 'Context conflict found in sampled-frame evidence', POSSIBLE_CONTEXT_CONFLICT: 'Possible context conflict in sampled-frame evidence', NO_CONFLICT_FOUND: 'No conflict found in the retrieved sample', INSUFFICIENT_EVIDENCE: 'Insufficient evidence to compare this caption' };
  const takeaways = { temporal_conflict: 'Retrieved dates conflict with the caption timing.', location_conflict: 'Retrieved location context conflicts with the caption.', historical_reuse: 'Historical reuse is indicated in retrieved evidence.', no_current_media_corroboration: 'Current media corroboration was not established.' };
  return <section className="claim-report" aria-label="Sampled-frame caption comparison"><h3>Sampled-frame caption comparison</h3><p className="eyebrow">User assertion to investigate</p><p>{comparison.claim}</p><h4>{labels[comparison.status]}</h4>{comparison.evidenceWarning ? <p className="fine-print">{comparison.evidenceWarning}</p> : null}<p className="fine-print">This compares the labeled sampled frame with retrieved context. It does not verify the entire video or its audio. No conflict found does not prove the caption is true. Original author and capture time remain unestablished.</p>{comparison.takeaways.length ? <ul>{comparison.takeaways.map((takeaway, index) => <li key={index}>{takeaways[takeaway.code]} <span className="fine-print">Retained evidence: {takeaway.evidenceIds.join(', ')}</span></li>)}</ul> : null}</section>;
}
function TranscriptView({ transcript, saved }: { transcript: MediaTranscript; saved: boolean }) {
  return <section className="research-dossier" aria-label="Recognized speech"><p className="eyebrow">Audio / local recognition</p><h3>{transcript.status === 'transcribed' ? 'What the recognizer heard' : transcript.status === 'no_audio' ? 'No audio stream' : transcript.status === 'no_speech_detected' ? 'No speech detected' : 'Audio remains unassessed'}</h3><p className="fine-print">Unreviewed machine transcription. Compare it with the original before treating any wording as evidence. Offsets below are positions in the supplied recording.</p>{saved ? <p className="fine-print">The original upload is excluded from this saved case. Return to your original recording to inspect it.</p> : null}<details open={transcript.segments.length <= 6}><summary>Inspect {transcript.segments.length} recognized segments{transcript.language ? ` · ${transcript.language}` : ''}</summary>{transcript.segments.map((segment, index) => <blockquote key={index}><p className="eyebrow">{formatTimestamp(segment.startMs)}–{formatTimestamp(segment.endMs)} · {segment.recognition === 'low_confidence' ? 'Uncertain recognition · excluded from searches' : 'Unreviewed'}</p><p>{segment.text}</p></blockquote>)}</details><details className="research-method"><summary>Recognition provenance and limits</summary><p className="fine-print">{transcript.engine} · {transcript.model ?? 'model unavailable'} · {transcript.modelHash ?? 'No model result'}</p><ul className="fine-print">{transcript.limitations.map(value => <li key={value}>{value}</li>)}</ul></details></section>;
}
export function AutomaticResult({ result, saved = false, autoSave = false, preview }: { result: AutomaticResearchView; saved?: boolean; autoSave?: boolean; preview?: string | null }) {
  const [view, setView] = useState<'sources' | 'frames'>('sources');
  const videoReport = useMemo<SavedVideoReport | undefined>(() => result.retainedResult ? { schemaVersion: 'contexttrail-media-report-v2', result: result.retainedResult } : undefined, [result.retainedResult]);
  const limitations = [...new Set([...result.limitations, ...result.caseRecord.coverage.limitations])];
  return <section className={`automatic-results${result.kind === 'video' ? ' media-results' : ''}`} aria-labelledby="research-result-title">
    <div className="sheet-topline"><p className="eyebrow">Retrieved evidence / {result.kind}</p><span className="state-label">{result.caseRecord.coverage.completeness} coverage</span></div>
    <p className={result.kind === 'video' ? 'sr-only' : 'eyebrow'}>Research question or input</p>
    <h2 className={result.kind === 'video' ? 'sr-only' : undefined} id="research-result-title">{result.question}</h2>
    {result.kind === 'topic' ? <details className="research-method"><summary>How sources were selected</summary><TopicCandidateAuditView audit={result.caseRecord.coverage.topicCandidateAudit} /></details> : null}
    {result.claimReport ? <><ResearchAccount report={result.claimReport} caseRecord={result.caseRecord} /><details className="research-method"><summary>Compare every source and inspect the assessment method</summary><ClaimReportView report={result.claimReport} caseRecord={result.caseRecord} /></details>{!saved && result.kind === 'topic' ? <SaveToCasebook value={result.caseRecord} question={result.question} claimReport={result.claimReport} autoSave={autoSave} /> : null}</> : null}
    {!saved && result.kind !== 'topic' && videoReport ? <SaveToCasebook value={result.caseRecord} question={result.question} videoReport={videoReport} autoSave={autoSave} /> : null}
    {result.kind === 'video' ? <VideoTrail result={result} preview={preview} /> : null}
    {result.visualScan ? <section className="research-dossier" aria-label="Visual track scan"><p className="eyebrow">Video / full-track local scan</p><h3>Follow the changes across the recording.</h3><p>{result.visualScan.scannedTimestampsMs.length} local luminance samples across {formatTimestamp(result.visualScan.durationMs)}. {result.frames.length} distinct search frames completed.</p><svg className="visual-scan-chart" viewBox="0 0 1000 100" role="img" aria-label="Pixel changes across the video timeline; rust markers indicate selected search targets"><line x1="0" y1="80" x2="1000" y2="80" stroke="currentColor" opacity=".2" />{result.visualScan.changes.map(change => <line key={change.timestampMs} x1={change.timestampMs / result.visualScan!.durationMs * 1000} x2={change.timestampMs / result.visualScan!.durationMs * 1000} y1="80" y2={80 - change.meanLuminanceChange * 75} stroke="currentColor" opacity=".55"><title>{formatTimestamp(change.timestampMs)} · mean luminance change {change.meanLuminanceChange.toFixed(4)}</title></line>)}{result.visualScan.searchTargetsMs.map(time => <line key={time} x1={time / result.visualScan!.durationMs * 1000} x2={time / result.visualScan!.durationMs * 1000} y1="8" y2="87" stroke="var(--rust)" strokeWidth="3"><title>Selected search target at {formatTimestamp(time)}</title></line>)}</svg><p className="fine-print">Search targets: {result.visualScan.searchTargetsMs.map(formatTimestamp).join(', ')}. Actual decoded offsets remain beside each completed frame. Pixel changes are raw measurements, not confidence scores or proof of an edit.</p><details className="research-method"><summary>Scan coverage and method</summary><ul className="fine-print">{result.visualScan.limitations.map(text => <li key={text}>{text}</li>)}</ul><p className="fine-print">Method: {result.visualScan.method}. Tiny scan frames are not retained in the saved case.</p></details></section> : null}
    {result.transcript ? <TranscriptView transcript={result.transcript} saved={saved} /> : null}
    {result.spokenResearch ? <section className="research-dossier" aria-label="Spoken evidence trail"><p className="eyebrow">Recognized speech / source research</p><h3>A trail from the spoken leads</h3><p className="fine-print">The wording below came from unreviewed recognition. These sources provide context; they do not prove that the speaker said it or that the recording is authentic.</p><details open><summary>Inspect the spoken query and its evidence</summary><p>{result.spokenResearch.question}</p>{result.spokenResearch.claimReport ? <ResearchAccount report={result.spokenResearch.claimReport} caseRecord={result.spokenResearch.caseRecord} /> : null}<EvidenceCollection items={result.spokenResearch.caseRecord.evidence} label="Spoken lead sources">{evidence => <SourceEvidence key={evidence.id} evidence={evidence} assessment={result.spokenResearch?.assessments.find(item => item.evidenceId === evidence.id)} />}</EvidenceCollection></details></section> : null}
    {result.frames.map((frame, index) => frame.imageResult.captionComparison ? <details className="research-method" key={index} open={index === 0}><summary>Sample {index + 1} · {formatTimestamp(frame.timestampMs)} · caption and source leads</summary><CaptionComparison comparison={frame.imageResult.captionComparison} /><CaptionFindings view={frame.imageResult.captionFindings} /></details> : null)}
    <p className="fine-print">Original publication unknown. {result.caseRecord.coverage.originalPublication.reason}</p>
    <details className="research-method"><summary>Coverage, dates and remaining unknowns</summary><ResearchLimitations values={limitations} /></details>
    <div className="button-row automatic-view-switch" aria-label="Evidence views"><button className="paper-button" aria-pressed={view === 'sources'} onClick={() => setView('sources')}>Source explorer ({result.caseRecord.evidence.length})</button>{result.kind === 'video' ? <button className="paper-button" aria-pressed={view === 'frames'} onClick={() => setView('frames')}>Sampled frames ({result.frames.length})</button> : null}</div>
    {view === 'sources' ? <div className="source-stack">{result.caseRecord.evidence.length ? <EvidenceCollection items={result.caseRecord.evidence} label="Sources">{evidence => <SourceEvidence key={evidence.id} evidence={evidence} assessment={result.assessments.find(item => item.evidenceId === evidence.id)} />}</EvidenceCollection> : <p className="empty-state">No source evidence was retained. This does not establish that the claim is true or that the video is original.</p>}</div> : <div className="source-stack">{result.frames.length ? result.frames.map((frame, index) => <details className="automatic-frame paper-sheet" key={`${frame.timestampMs}-${index}`} open={index === 0}><summary>Sample {index + 1} · {formatTimestamp(frame.timestampMs)}</summary><p className="fine-print">Sources below concern this sampled frame. They do not verify the entire video or its audio.</p><ResearchLimitations values={frame.imageResult.limitations} /><div className="source-stack"><EvidenceCollection label="Frame sources" items={[
      ...frame.imageResult.timeline.map(source => ({ source, label: 'Dated occurrence' })),
      ...frame.imageResult.undatedEvidence.map(source => ({ source, label: 'Undated evidence' })),
      ...frame.imageResult.supportingEvidence.map(source => ({ source, label: 'Supporting visual lead' })),
      ...frame.imageResult.contextualEvidence.map(source => ({ source, label: 'Contextual source' })),
    ]}>{({ source, label }, i) => <FrameSource key={`${source.evidenceId}-${i}`} source={source} label={label} />}</EvidenceCollection></div>{!frame.imageResult.timeline.length && !frame.imageResult.undatedEvidence.length && !frame.imageResult.supportingEvidence.length && !frame.imageResult.contextualEvidence.length ? <p className="empty-state">No source evidence found for this sampled frame.</p> : null}</details>) : <p className="empty-state">No sampled-frame results available.</p>}</div>}
  </section>;
}
export default function AutomaticResearch({ kind, readiness, captionReadiness }: { kind: 'topic' | 'video' | 'audio'; readiness?: AutomaticReadiness; captionReadiness?: AutomaticReadiness }) {
  const [ready, setReady] = useState(false);
  useEffect(() => { setReady(true); }, []);
  const [intent, setIntent] = useState<'question' | 'claim'>('question');
  const topicLimit = intent === 'claim' ? 493 : 500;
  const [topic, setTopic] = useState('');
  const [claim, setClaim] = useState('');
  const liveReadiness = kind === 'video' && claim.trim() && captionReadiness ? captionReadiness : readiness;
  const [media, setMedia] = useState<File | null>(null);
  const mediaPreview = useFilePreview(media);
  const [rights, setRights] = useState(false);
  const [keep, setKeep] = useState(true);
  const [state, setState] = useState<ResearchState>({ kind: 'idle' });
  const active = useRef<AbortController | null>(null);
  const resultHeading = useRef<HTMLDivElement | null>(null);
  const actionArea = useRef<HTMLDivElement | null>(null);
  const submitButton = useRef<HTMLButtonElement | null>(null);
  const cancelButton = useRef<HTMLButtonElement | null>(null);
  useEffect(() => () => { active.current?.abort(); active.current = null; }, []);
  useEffect(() => {
    // Only state transitions reveal the controls. Streamed message changes do not
    // steal focus or scroll away from evidence the user is inspecting.
    if (state.kind === 'running' || state.kind === 'cancelled') {
      (state.kind === 'running' ? cancelButton.current : submitButton.current)?.focus({ preventScroll: true });
      actionArea.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      return;
    }
    if (state.kind !== 'complete' && state.kind !== 'error') return;
    const heading = resultHeading.current;
    if (!heading) return;
    // Native focus scrolling does not account for the fixed chapter navigation.
    // Reveal the result's start explicitly, rather than leaving an error behind it.
    heading.focus({ preventScroll: true });
    heading.scrollIntoView({ block: 'start', behavior: 'instant' });
  }, [state.kind]);
  const running = state.kind === 'running';
  function cancel() { active.current?.abort(); active.current = null; setState({ kind: 'cancelled' }); }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (active.current) return;
    if (liveReadiness && !liveReadiness.ready) { setState({kind:'error',message:liveReadiness.message}); return; }
    if (kind === 'topic' && (topic.trim().length < 5 || topic.trim().length > topicLimit)) { setState({ kind: 'error', message: `Enter ${intent === 'claim' ? 'a claim' : 'a question'} between 5 and ${topicLimit} characters.` }); return; }
    if (kind !== 'topic' && (!media || !rights)) { setState({ kind: 'error', message: 'Choose a media file and confirm permission to investigate it.' }); return; }
    if (kind !== 'topic' && claim.trim().length > 500) { setState({ kind: 'error', message: 'Keep the caption or claim to 500 characters.' }); return; }
    const controller = new AbortController(); active.current = controller;
    const body = new FormData(); body.set('kind', kind);
    if (kind === 'topic') body.set('topic', intent === 'claim' ? `Claim: ${topic.trim().replace(/^(?:claim|check this claim)\s*:\s*/i, '')}` : topic.trim());
    else if (media) { body.set(kind, media); body.set('rights', 'user_provided'); if (claim.trim()) body.set('claim', claim.trim()); }
    setState({ kind: 'running', message: kind === 'topic' ? 'Finding sources for your question…' : 'Preparing the media investigation…' });
    try {
      const result = await investigateAutomatically(body, controller.signal, message => { if (active.current === controller) setState({ kind: 'running', message: researchProgressCopy(message) }); });
      if (active.current === controller) setState({ kind: 'complete', result });
    } catch (error) {
      if (active.current === controller && !controller.signal.aborted) setState({ kind: 'error', message: error instanceof Error ? error.message : 'The investigation could not finish. Try again.' });
    } finally { if (active.current === controller) active.current = null; }
  }
  return <CasebookShell chapter={kind === 'topic' ? 'questions' : kind}><main id="main" className="casebook-main" tabIndex={-1}>
    <details className="inquiry-entry" open={state.kind !== 'complete'}><summary>{kind === 'topic' ? 'Your question / edit the input' : 'Your recording / edit the input'}</summary><div className="inquiry-entry-layout"><ChapterHeading number={kind === 'topic' ? '03' : kind === 'video' ? '02' : '03'} label={kind === 'topic' ? 'Questions' : kind === 'video' ? 'Video' : 'Audio'} description={kind === 'topic' ? 'Start with a question. Follow the sources and read what they actually say.' : kind === 'video' ? 'Follow the visual trail and investigate the spoken context.' : 'Hear the words. Follow their context back to the sources.'}>{kind === 'topic' ? <>A question.<br /><em>A trail to follow.</em></> : kind === 'video' ? <>One video.<br /><em>More of the story.</em></> : <>A recording.<br /><em>Something to understand.</em></>}</ChapterHeading>
    <div className="automatic-intake"><form className="paper-sheet form-stack" onSubmit={submit}>
      {kind === 'topic' ? <div className="button-row" role="group" aria-label="Investigation intent"><button type="button" className="paper-button" aria-pressed={intent === 'question'} disabled={!ready || running} onClick={() => setIntent('question')}>Ask a question</button><button type="button" className="paper-button" aria-pressed={intent === 'claim'} disabled={!ready || running} onClick={() => setIntent('claim')}>Check a claim</button></div> : null}
      {kind === 'topic' ? <label className="field">{intent === 'claim' ? 'What claim should we check?' : 'What would you like to investigate?'}<textarea value={topic} onChange={event => setTopic(event.target.value)} minLength={5} maxLength={topicLimit} required disabled={!ready || running} placeholder={intent === 'claim' ? 'Paste the exact claim, including its date or product version.' : 'What would you like to understand?'} /><small>{topic.length} / {topicLimit} characters. Sources will be retrieved automatically.</small></label> : <><label className="field">{kind === 'video' ? 'Choose one video' : 'Choose one audio recording'}<input type="file" accept={kind === 'video' ? ' .mp4,.mov,.webm,.mkv,video/*' : '.wav,.mp3,.m4a,.flac,.ogg,audio/*'} disabled={!ready || running} required onChange={event => { setMedia(event.target.files?.[0] ?? null); setRights(false); }} /><small>{media ? `${media.name}. ` : kind === 'video' ? 'MP4, MOV, WebM or MKV. ' : 'WAV, MP3, M4A, FLAC or Ogg. '}Maximum 32 MB and 120 seconds. The full audio track is transcribed locally. {kind === 'video' ? 'Up to three visual samples are also searched independently.' : 'Recognized wording provides leads for source research.'}</small></label><label className="field">Caption or claim to check (optional)<textarea value={claim} onChange={event => setClaim(event.target.value)} maxLength={500} disabled={!ready || running} placeholder={kind === 'video' ? 'For example: This video shows the event described in this caption.' : 'For example: This recording contains the statement described here.'} /><small>{claim.length} / 500 characters. Leave blank to investigate the media context. A supplied caption is your assertion to investigate.</small></label><label className="checkbox-field"><input type="checkbox" checked={rights} onChange={event => setRights(event.target.checked)} required disabled={!ready || running} />I have permission to submit this recording and send recognized speech, any supplied caption and retrieved source text to SerpApi / Google and TypeSafe.{kind === 'video' ? ' Up to three visual samples are also sent to SerpApi / Google Lens.' : ''}</label></>}
      <div className="automatic-action-area" ref={actionArea}>{liveReadiness ? <p className={`live-readiness${liveReadiness.ready ? '' : ' unavailable'}`} role="status"><span aria-hidden="true">{liveReadiness.ready ? '●' : '○'}</span>{liveReadiness.message}</p> : null}<div className="button-row"><button ref={submitButton} type="submit" className="paper-button primary" disabled={!ready || running || liveReadiness?.ready === false}>{running ? 'Investigating…' : kind === 'topic' ? intent === 'claim' ? 'Investigate claim' : 'Investigate question' : kind === 'video' ? 'Investigate video' : 'Investigate audio'}</button>{running ? <button ref={cancelButton} type="button" className="paper-button" onClick={cancel}>Cancel investigation</button> : null}</div><p className="automatic-action-status" role="status" aria-live="polite" aria-atomic="true">{state.kind === 'running' ? state.message : state.kind === 'cancelled' ? 'Investigation cancelled. You can edit the input and start again.' : ''}</p></div>
      <p className="fine-print">{kind === 'topic' ? 'Your question is sent to SerpApi / Google. Your question and retrieved source text are sent to TypeSafe for excerpt relationship and scope assessments.' : <>The original recording is decoded locally. Recognized speech and any supplied caption are sent as unreviewed search leads; retrieved text is assessed by TypeSafe. {kind === 'video' ? 'Up to three sampled frames are also sent to Google Lens. ' : ''}Original audio is never uploaded to a speech service.</>}</p>
      <details className="research-method"><summary>Provider usage and request limits</summary><p className="fine-print automatic-budget">Maximum reservation for this run: {kind !== 'video' ? '6 searches · 0 uploads · 12 TypeSafe / Jev requests · 60 questions' : claim.trim() ? '24 searches · 3 image uploads · 192 TypeSafe / Jev requests · 876 questions' : '18 searches · 3 image uploads · 192 TypeSafe / Jev requests · 399 questions'}. These are worst-case caps, not actual consumption or a statement of your account balance.</p></details>
      <label className="checkbox-field"><input type="checkbox" checked={keep} disabled={!ready || running} onChange={event => setKeep(event.target.checked)} />Keep this investigation in my casebook</label><p className="fine-print">Your question and retained evidence are saved locally. Original uploads are excluded. You can leave this unchecked for an unsaved investigation.</p>
      {mediaPreview ? <figure className="media-intake-preview"><figcaption className="eyebrow">Your original recording / local preview</figcaption>{kind === 'video' ? <video src={mediaPreview} controls preload="metadata" playsInline aria-label="Inspect original video" /> : <audio src={mediaPreview} controls preload="metadata" aria-label="Inspect original audio" />}</figure> : null}
    </form><aside className="automatic-aside"><p className="eyebrow">Other ways in</p><Link className="text-link" href="/investigate">Investigate an image</Link><Link className="text-link" href="/casebook?chapter=questions">Open saved investigations</Link>{kind !== 'audio' ? <Link className="text-link" href="/audio">Investigate audio</Link> : null}<Link className="text-link" href="/families">Connect related versions</Link>{kind === 'video' ? <Link className="text-link" href="/compare">Compare two supplied files</Link> : <Link className="text-link" href="/video">Investigate a video</Link>}<p className="fine-print">Read source text, inspect dates, and keep unknowns visible.</p></aside></div></div></details>
    <div ref={resultHeading} tabIndex={-1} className="automatic-status">{state.kind === 'error' ? <p role="alert" className="error-note">{state.message}</p> : state.kind === 'complete' ? <AutomaticResult result={state.result} autoSave={keep} preview={mediaPreview} /> : null}</div>
  </main></CasebookShell>;
}
