'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import type { CaseEvidence, SourcedDate } from '@/lib/cases/model';
import { investigateAutomatically, type AutomaticResearchView, type AutomaticFrameSource } from '@/lib/research/automatic-client';
import { formatTimestamp } from '@/lib/video/matching/client';
import { CasebookShell, ChapterHeading } from './CasebookShell';
import { ClaimReportView } from './ClaimReportView';
import { EvidenceCollection, EvidencePassage, SourceActions } from './EvidenceCollection';
import SaveToCasebook from './SaveToCasebook';
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
  return <section className="claim-report" aria-label="Sampled-frame caption comparison"><h3>Sampled-frame caption comparison</h3><p className="eyebrow">User assertion to investigate</p><p>{comparison.claim}</p><h4>{labels[comparison.status]}</h4>{comparison.evidenceWarning ? <p className="fine-print">{comparison.evidenceWarning}</p> : null}<p className="fine-print">This compares one sampled frame with retrieved context. It does not verify the entire video or its audio. No conflict found does not prove the caption is true. Original author and capture time remain unestablished.</p>{comparison.takeaways.length ? <ul>{comparison.takeaways.map((takeaway, index) => <li key={index}>{takeaways[takeaway.code]} <span className="fine-print">Retained evidence: {takeaway.evidenceIds.join(', ')}</span></li>)}</ul> : null}</section>;
}
export function AutomaticResult({ result }: { result: AutomaticResearchView }) {
  const [view, setView] = useState<'sources' | 'frames'>('sources');
  const limitations = [...new Set([...result.limitations, ...result.caseRecord.coverage.limitations])];
  return <section className="automatic-results" aria-labelledby="research-result-title">
    <div className="sheet-topline"><p className="eyebrow">Retrieved evidence / {result.kind}</p><span className="state-label">{result.caseRecord.coverage.completeness} coverage</span></div>
    <p className="eyebrow">Research question or input</p>
    <h2 id="research-result-title">{result.question}</h2>
    {result.claimReport ? <><ClaimReportView report={result.claimReport} caseRecord={result.caseRecord} /><SaveToCasebook value={result.caseRecord} question={result.question} claimReport={result.claimReport} /></> : null}
    {result.frames.map((frame, index) => frame.imageResult.captionComparison ? <CaptionComparison key={index} comparison={frame.imageResult.captionComparison} /> : null)}
    <p className="fine-print">Original publication unknown. {result.caseRecord.coverage.originalPublication.reason}</p>
    <ResearchLimitations values={limitations} />
    <div className="button-row automatic-view-switch" aria-label="Evidence views"><button className="paper-button" aria-pressed={view === 'sources'} onClick={() => setView('sources')}>Source explorer ({result.caseRecord.evidence.length})</button>{result.kind === 'video' ? <button className="paper-button" aria-pressed={view === 'frames'} onClick={() => setView('frames')}>Sampled frames ({result.frames.length})</button> : null}</div>
    {view === 'sources' ? <div className="source-stack">{result.caseRecord.evidence.length ? <EvidenceCollection items={result.caseRecord.evidence} label="Sources">{evidence => <SourceEvidence key={evidence.id} evidence={evidence} assessment={result.assessments.find(item => item.evidenceId === evidence.id)} />}</EvidenceCollection> : <p className="empty-state">No source evidence was retained. This does not establish that the claim is true or that the video is original.</p>}</div> : <div className="source-stack">{result.frames.length ? result.frames.map((frame, index) => <details className="automatic-frame paper-sheet" key={`${frame.timestampMs}-${index}`} open={index === 0}><summary>Sample {index + 1} · {formatTimestamp(frame.timestampMs)}</summary><p className="fine-print">Sources below concern this sampled frame. They do not verify the entire video or its audio.</p><ResearchLimitations values={frame.imageResult.limitations} /><div className="source-stack"><EvidenceCollection label="Frame sources" items={[
      ...frame.imageResult.timeline.map(source => ({ source, label: 'Dated occurrence' })),
      ...frame.imageResult.undatedEvidence.map(source => ({ source, label: 'Undated evidence' })),
      ...frame.imageResult.supportingEvidence.map(source => ({ source, label: 'Supporting visual lead' })),
      ...frame.imageResult.contextualEvidence.map(source => ({ source, label: 'Contextual source' })),
    ]}>{({ source, label }, i) => <FrameSource key={`${source.evidenceId}-${i}`} source={source} label={label} />}</EvidenceCollection></div>{!frame.imageResult.timeline.length && !frame.imageResult.undatedEvidence.length && !frame.imageResult.supportingEvidence.length && !frame.imageResult.contextualEvidence.length ? <p className="empty-state">No source evidence found for this sampled frame.</p> : null}</details>) : <p className="empty-state">No sampled-frame results available.</p>}</div>}
  </section>;
}
export default function AutomaticResearch({ kind }: { kind: 'topic' | 'video' }) {
  const [topic, setTopic] = useState('');
  const [claim, setClaim] = useState('');
  const [video, setVideo] = useState<File | null>(null);
  const [rights, setRights] = useState(false);
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
    if (kind === 'topic' && (topic.trim().length < 5 || topic.trim().length > 500)) { setState({ kind: 'error', message: 'Enter a question between 5 and 500 characters.' }); return; }
    if (kind === 'video' && (!video || !rights)) { setState({ kind: 'error', message: 'Choose a video and confirm permission to investigate it.' }); return; }
    if (kind === 'video' && claim.trim().length > 500) { setState({ kind: 'error', message: 'Keep the caption or claim to 500 characters.' }); return; }
    const controller = new AbortController(); active.current = controller;
    const body = new FormData(); body.set('kind', kind);
    if (kind === 'topic') body.set('topic', topic.trim());
    else if (video) { body.set('video', video); body.set('rights', 'user_provided'); if (claim.trim()) body.set('claim', claim.trim()); }
    setState({ kind: 'running', message: kind === 'topic' ? 'Finding sources for your question…' : 'Preparing the video investigation…' });
    try {
      const result = await investigateAutomatically(body, controller.signal, message => { if (active.current === controller) setState({ kind: 'running', message: researchProgressCopy(message) }); });
      if (active.current === controller) setState({ kind: 'complete', result });
    } catch (error) {
      if (active.current === controller && !controller.signal.aborted) setState({ kind: 'error', message: error instanceof Error ? error.message : 'The investigation could not finish. Try again.' });
    } finally { if (active.current === controller) active.current = null; }
  }
  return <CasebookShell chapter={kind === 'topic' ? 'questions' : 'video'}><main id="main" className="casebook-main" tabIndex={-1}>
    <ChapterHeading number={kind === 'topic' ? '03' : '02'} label={kind === 'topic' ? 'Questions' : 'Video'} description={kind === 'topic' ? 'Start with a question. Follow the sources and read what they actually say.' : 'Start with one video. Search one representative frame across the web.'}>{kind === 'topic' ? <>A question.<br /><em>A trail to follow.</em></> : <>One video.<br /><em>More of the story.</em></>}</ChapterHeading>
    <div className="automatic-intake"><form className="paper-sheet form-stack" onSubmit={submit}>
      {kind === 'topic' ? <label className="field">What would you like to investigate?<textarea value={topic} onChange={event => setTopic(event.target.value)} minLength={5} maxLength={500} required disabled={running} placeholder="What is the evidence behind this claim?" /><small>{topic.length} / 500 characters. Sources will be retrieved automatically.</small></label> : <><label className="field">Choose one video<input type="file" accept=".mp4,.mov,.webm,.mkv,video/*" disabled={running} required onChange={event => { setVideo(event.target.files?.[0] ?? null); setRights(false); }} /><small>{video ? `${video.name}. ` : 'MP4, MOV, WebM or MKV. '}Maximum 32 MB and 120 seconds. Up to three frames are decoded locally; one representative frame is searched.</small></label><label className="field">Caption or claim to check (optional)<textarea value={claim} onChange={event => setClaim(event.target.value)} maxLength={500} disabled={running} placeholder="For example: This video shows the event described in this caption." /><small>{claim.length} / 500 characters. Leave blank to trace the sampled frame. A supplied caption is your assertion to investigate.</small></label><label className="checkbox-field"><input type="checkbox" checked={rights} onChange={event => setRights(event.target.checked)} required disabled={running} />I have permission to submit this video for investigation, including sending one sampled frame to SerpApi / Google Lens and retrieved source text and any supplied caption to TypeSafe. A supplied caption also goes to SerpApi / Google for source searches.</label></>}
      <div className="automatic-action-area" ref={actionArea}><div className="button-row"><button ref={submitButton} type="submit" className="paper-button primary" disabled={running}>{running ? 'Investigating…' : kind === 'topic' ? 'Investigate question' : 'Investigate video'}</button>{running ? <button ref={cancelButton} type="button" className="paper-button" onClick={cancel}>Cancel investigation</button> : null}</div><p className="automatic-action-status" role="status" aria-live="polite" aria-atomic="true">{state.kind === 'running' ? state.message : state.kind === 'cancelled' ? 'Investigation cancelled. You can edit the input and start again.' : ''}</p></div>
      <p className="fine-print">{kind === 'topic' ? 'Your question is sent to SerpApi / Google. Your question and retrieved source text are sent to TypeSafe for excerpt relationship and scope assessments.' : 'The original video is decoded locally. One sampled frame is sent to SerpApi / Google Lens; source text and any supplied caption are sent to TypeSafe. A supplied caption also goes to SerpApi / Google for source searches. Audio and remaining frames are not searched.'}</p>
      <p className="fine-print automatic-budget">Maximum reservation for this run: {kind === 'topic' ? '3 searches · 0 uploads · 8 TypeSafe / Jev requests · 40 questions' : claim.trim() ? '6 searches · 1 image upload · 60 TypeSafe / Jev requests · 272 questions' : '4 searches · 1 image upload · 60 TypeSafe / Jev requests · 113 questions'}. These are worst-case caps, not actual consumption or a statement of your account balance.</p>
      <p className="fine-print">Results have partial coverage and may be inconclusive. A saved case is not required.</p>
    </form><aside className="automatic-aside"><p className="eyebrow">Other ways in</p><Link className="text-link" href="/investigate">Investigate an image</Link><Link className="text-link" href="/casebook?chapter=questions">Open the manual casebook</Link>{kind === 'video' ? <Link className="text-link" href="/compare">Compare two supplied files</Link> : <Link className="text-link" href="/video">Investigate a video</Link>}<p className="fine-print">Read source text, inspect dates, and keep unknowns visible.</p></aside></div>
    <div ref={resultHeading} tabIndex={-1} className="automatic-status">{state.kind === 'error' ? <p role="alert" className="error-note">{state.message}</p> : state.kind === 'complete' ? <AutomaticResult result={state.result} /> : null}</div>
  </main></CasebookShell>;
}
