'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import type { CaseEvidence, SourcedDate } from '@/lib/cases/model';
import { investigateAutomatically, type AutomaticResearchView, type AutomaticFrameSource } from '@/lib/research/automatic-client';
import { formatTimestamp } from '@/lib/video/matching/client';
import { CasebookShell, ChapterHeading } from './CasebookShell';

type ResearchState = { kind: 'idle' | 'cancelled' } | { kind: 'running'; message: string } | { kind: 'error'; message: string } | { kind: 'complete'; result: AutomaticResearchView };

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
    <h3>{evidence.title ?? 'Untitled source'}</h3>
    <p className="fine-print">{publicationLabel(evidence.publicationDate)}</p>
    {assessment && assessment.relevance !== null ? <details className="automatic-relevance"><summary>Topic relevance · model assessment</summary><p className="fine-print">Relevance probability: {assessment.relevance}. Model: {assessment.model}. This assesses relevance to the question, not factual accuracy or whether the source supports the claim.</p></details> : <p className="fine-print">Topic relevance unassessed.</p>}
    {evidence.content.kind === 'text' ? <p className="evidence-passage">{evidence.content.text}</p> : <p className="fine-print">No source text was retained for this record.</p>}
    <a className="text-link source-url" href={evidence.sourceUrl} target="_blank" rel="noopener noreferrer">{evidence.sourceUrl}</a>
    <p className="fine-print">Retrieved: {evidence.provenance.retrievedAt ?? 'Unknown'} · {evidence.provenance.method.replaceAll('_', ' ')}</p>
  </article>;
}
function FrameSource({ source, label }: { source: AutomaticFrameSource; label: string }) {
  return <article className="source-card automatic-source">
    <p className="eyebrow">{label}</p><h3>{source.title ?? 'Untitled source'}</h3>
    <p className="fine-print">{source.dateStatus === 'usable' && source.observedAt ? `${source.observedAt} · reported publication date` : `Publication date ${source.dateStatus === 'disputed' ? 'disputed' : 'unknown'}`} · Identity basis: {source.identityBasis.replaceAll('_', ' ')}</p>
    {source.excerpt ? <><p className="fine-print">{source.displayAttribution ?? source.excerptSource.replaceAll('_', ' ')}</p><p className="evidence-passage">{source.excerpt}</p></> : <p className="fine-print">No source excerpt available.</p>}
    <a className="text-link source-url" href={source.sourceUrl} target="_blank" rel="noopener noreferrer">{source.sourceUrl}</a>
  </article>;
}
export function AutomaticResult({ result }: { result: AutomaticResearchView }) {
  const [view, setView] = useState<'sources' | 'frames'>('sources');
  const limitations = [...new Set([...result.limitations, ...result.caseRecord.coverage.limitations])];
  return <section className="automatic-results" aria-labelledby="research-result-title">
    <div className="sheet-topline"><p className="eyebrow">Retrieved evidence / {result.kind}</p><span className="state-label">{result.caseRecord.coverage.completeness} coverage</span></div>
    <h2 id="research-result-title">{result.question}</h2>
    <p className="fine-print">Original publication unknown. {result.caseRecord.coverage.originalPublication.reason}</p>
    {limitations.length ? <details className="automatic-limitations" open><summary>Limits of this investigation</summary><ul>{limitations.map((limit, index) => <li key={index}>{limit}</li>)}</ul></details> : null}
    <div className="button-row automatic-view-switch" aria-label="Evidence views"><button className="paper-button" aria-pressed={view === 'sources'} onClick={() => setView('sources')}>Source explorer ({result.caseRecord.evidence.length})</button>{result.kind === 'video' ? <button className="paper-button" aria-pressed={view === 'frames'} onClick={() => setView('frames')}>Sampled frames ({result.frames.length})</button> : null}</div>
    {view === 'sources' ? <div className="source-stack">{result.caseRecord.evidence.length ? result.caseRecord.evidence.map(evidence => <SourceEvidence key={evidence.id} evidence={evidence} assessment={result.assessments.find(item => item.evidenceId === evidence.id)} />) : <p className="empty-state">No source evidence was retained. This does not establish that the claim is true or that the video is original.</p>}</div> : <div className="source-stack">{result.frames.length ? result.frames.map((frame, index) => <details className="automatic-frame paper-sheet" key={`${frame.timestampMs}-${index}`} open={index === 0}><summary>Sample {index + 1} · {formatTimestamp(frame.timestampMs)}</summary><p className="fine-print">Sources below concern this sampled frame. They do not verify the entire video or its audio.</p>{frame.imageResult.limitations.length ? <ul className="fine-print">{frame.imageResult.limitations.map((limit, i) => <li key={i}>{limit}</li>)}</ul> : null}<div className="source-stack">{[
      ...frame.imageResult.timeline.map(source => ({ source, label: 'Dated occurrence' })),
      ...frame.imageResult.undatedEvidence.map(source => ({ source, label: 'Undated evidence' })),
      ...frame.imageResult.supportingEvidence.map(source => ({ source, label: 'Supporting visual lead' })),
      ...frame.imageResult.contextualEvidence.map(source => ({ source, label: 'Contextual source' })),
    ].map(({ source, label }, i) => <FrameSource key={`${source.evidenceId}-${i}`} source={source} label={label} />)}</div>{!frame.imageResult.timeline.length && !frame.imageResult.undatedEvidence.length && !frame.imageResult.supportingEvidence.length && !frame.imageResult.contextualEvidence.length ? <p className="empty-state">No source evidence found for this sampled frame.</p> : null}</details>) : <p className="empty-state">No sampled-frame results available.</p>}</div>}
  </section>;
}
export default function AutomaticResearch({ kind }: { kind: 'topic' | 'video' }) {
  const [topic, setTopic] = useState('');
  const [video, setVideo] = useState<File | null>(null);
  const [rights, setRights] = useState(false);
  const [state, setState] = useState<ResearchState>({ kind: 'idle' });
  const active = useRef<AbortController | null>(null);
  const resultHeading = useRef<HTMLDivElement | null>(null);
  useEffect(() => () => { active.current?.abort(); active.current = null; }, []);
  useEffect(() => {
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
    const controller = new AbortController(); active.current = controller;
    const body = new FormData(); body.set('kind', kind);
    if (kind === 'topic') body.set('topic', topic.trim());
    else if (video) { body.set('video', video); body.set('rights', 'user_provided'); }
    setState({ kind: 'running', message: kind === 'topic' ? 'Finding sources for your question…' : 'Preparing the video investigation…' });
    try {
      const result = await investigateAutomatically(body, controller.signal, message => { if (active.current === controller) setState({ kind: 'running', message }); });
      if (active.current === controller) setState({ kind: 'complete', result });
    } catch (error) {
      if (active.current === controller && !controller.signal.aborted) setState({ kind: 'error', message: error instanceof Error ? error.message : 'The investigation could not finish. Try again.' });
    } finally { if (active.current === controller) active.current = null; }
  }
  return <CasebookShell chapter={kind === 'topic' ? 'questions' : 'video'}><main id="main" className="casebook-main" tabIndex={-1}>
    <ChapterHeading number={kind === 'topic' ? '03' : '02'} label={kind === 'topic' ? 'Questions' : 'Video'} description={kind === 'topic' ? 'Start with a question. Follow the sources and read what they actually say.' : 'Start with one video. Search one representative frame across the web.'}>{kind === 'topic' ? <>A question.<br /><em>A trail to follow.</em></> : <>One video.<br /><em>More of the story.</em></>}</ChapterHeading>
    <div className="automatic-intake"><form className="paper-sheet form-stack" onSubmit={submit} aria-busy={running}>
      {kind === 'topic' ? <label className="field">What would you like to investigate?<textarea value={topic} onChange={event => setTopic(event.target.value)} minLength={5} maxLength={500} required disabled={running} placeholder="What is the evidence behind this claim?" /><small>{topic.length} / 500 characters. Sources will be retrieved automatically.</small></label> : <><label className="field">Choose one video<input type="file" accept=".mp4,.mov,.webm,.mkv,video/*" disabled={running} required onChange={event => { setVideo(event.target.files?.[0] ?? null); setRights(false); }} /><small>{video ? `${video.name}. ` : 'MP4, MOV, WebM or MKV. '}Maximum 32 MB and 120 seconds. Up to three frames are decoded locally; one representative frame is searched.</small></label><label className="checkbox-field"><input type="checkbox" checked={rights} onChange={event => setRights(event.target.checked)} required disabled={running} />I have permission to submit this video for investigation, including sending one sampled frame to SerpApi / Google Lens and retrieved source text to TypeSafe.</label></>}
      <div className="button-row"><button type="submit" className="paper-button primary" disabled={running}>{running ? 'Investigating…' : kind === 'topic' ? 'Investigate question' : 'Investigate video'}</button>{running ? <button type="button" className="paper-button" onClick={cancel}>Cancel investigation</button> : null}</div>
      <p className="fine-print">{kind === 'topic' ? 'Your question is sent to SerpApi / Google. Your question and retrieved source text are sent to TypeSafe for relevance assessment.' : 'The original video is decoded locally. One sampled frame is sent to SerpApi / Google Lens; source text is sent to TypeSafe. Audio and remaining frames are not searched.'}</p>
      <p className="fine-print automatic-budget">Maximum reservation for this run: {kind === 'topic' ? '3 searches · 0 uploads · 8 TypeSafe / Jev requests · 8 questions' : '4 searches · 1 image upload · 60 TypeSafe / Jev requests · 113 questions'}. These are worst-case caps, not actual consumption or a statement of your account balance.</p>
      <p className="fine-print">Results have partial coverage and may be inconclusive. A saved case is not required.</p>
    </form><aside className="automatic-aside"><p className="eyebrow">Other ways in</p><Link className="text-link" href="/investigate">Investigate an image</Link><Link className="text-link" href="/casebook?chapter=questions">Open the manual casebook</Link>{kind === 'video' ? <Link className="text-link" href="/compare">Compare two supplied files</Link> : <Link className="text-link" href="/video">Investigate a video</Link>}<p className="fine-print">Read source text, inspect dates, and keep unknowns visible.</p></aside></div>
    <div ref={resultHeading} tabIndex={-1} className="automatic-status">{state.kind === 'running' ? <p role="status" aria-live="polite">{state.message}</p> : state.kind === 'cancelled' ? <p role="status">Investigation cancelled. You can edit the input and start again.</p> : state.kind === 'error' ? <p role="alert" className="error-note">{state.message}</p> : state.kind === 'complete' ? <AutomaticResult result={state.result} /> : null}</div>
  </main></CasebookShell>;
}
