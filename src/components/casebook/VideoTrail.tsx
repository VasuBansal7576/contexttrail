'use client';
import { useEffect, useRef, useState } from 'react';
import type { AutomaticResearchView } from '@/lib/research/automatic-client';
import { formatTimestamp } from '@/lib/video/matching/client';
import { EvidencePassage, SourceActions } from './EvidenceCollection';
import {useChapterTour} from './ChapterTour';

/** Selected-frame context stays separate from proof that two recordings are identical. */
export function VideoTrail({result, preview}: {result: AutomaticResearchView; preview?: string | null}) {
  const [selected,setSelected] = useState(0), [sourceIndex,setSourceIndex] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  useChapterTour(step=>{setSelected(Math.max(0,Math.min(step,result.frames.length-1)));setSourceIndex(0);});
  const frame = result.frames[Math.min(selected,result.frames.length-1)];
  const sources = frame ? [...frame.imageResult.timeline, ...frame.imageResult.undatedEvidence, ...frame.imageResult.supportingEvidence, ...frame.imageResult.contextualEvidence].sort((a,b) => Number(b.excerptSource === 'page_text')-Number(a.excerptSource === 'page_text') || Number(Boolean(b.excerpt))-Number(Boolean(a.excerpt))).filter((source,index,all) => all.findIndex(other => other.sourceUrl === source.sourceUrl) === index) : [];
  const source = sources[Math.min(sourceIndex,sources.length-1)];
  useEffect(() => { if (video.current && frame) video.current.currentTime = frame.timestampMs/1000; }, [frame?.timestampMs,preview]);
  return <section className="video-trail" aria-label="Selected frame and source context">
    <div className="video-trail-title"><div><p className="eyebrow">Visual trail / completed samples</p><h2>One frame.<br /><em>A different context?</em></h2></div><div className="video-trail-question"><p className="eyebrow">Caption to investigate</p><p>{result.question}</p><p className="fine-print">Select a searched moment. Read the source beside it. A search association stays a lead until the actual recording can be compared.</p></div></div>
    <div className="video-context-pair">
      <article className="video-original"><div className="sheet-topline"><span className="eyebrow">Supplied recording</span><span className="eyebrow">{frame ? formatTimestamp(frame.timestampMs) : 'No completed search sample'}</span></div>
        {preview ? <video ref={video} src={preview} controls preload="metadata" playsInline onLoadedMetadata={() => { if (video.current && frame) video.current.currentTime = frame.timestampMs/1000; }} aria-label="Play the original at the selected search offset" /> : <div className="unretained-frame"><span>{frame ? formatTimestamp(frame.timestampMs) : '?'}</span><p>Original frame bytes were not saved.</p><p className="fine-print">The selected offset and its source trail are retained. Return to the original recording to compare its pixels.</p></div>}
      </article>
      <article className="video-source-context"><div className="sheet-topline"><span className="eyebrow">{source?.excerptSource === 'page_text' ? 'Retained page passage' : source?.excerptSource === 'serp_snippet' ? 'Search snippet / unverified lead' : 'Source lead'}</span><span className="eyebrow">Identity unresolved</span></div>
        {source ? <><h3>{source.title ?? 'Untitled source'}</h3>{source.excerpt ? <EvidencePassage text={source.excerpt} /> : <p>No inspected passage is retained for this lead.</p>}<p className="fine-print">{source.observedAt && source.dateStatus === 'usable' ? `Reported publication: ${source.observedAt}` : 'Publication date unresolved'}. Search identity basis: {source.identityBasis.replaceAll('_',' ')}.</p><SourceActions url={source.sourceUrl} /><div className="button-row"><button className="text-link" disabled={sourceIndex===0} onClick={() => setSourceIndex(value=>value-1)}>← Earlier lead</button><span className="eyebrow">{Math.min(sourceIndex+1,sources.length)} / {sources.length}</span><button className="text-link" disabled={sourceIndex>=sources.length-1} onClick={() => setSourceIndex(value=>value+1)}>Next lead →</button></div></> : <><h3>The earlier context stays open.</h3><p>No retained source lead is available for this moment.</p></>}
      </article>
    </div>
    <div className="video-filmstrip" role="group" aria-label="Searched video moments">{result.frames.map((item,index) => <button key={`${item.timestampMs}-${index}`} aria-pressed={index===selected} onClick={() => {setSelected(index);setSourceIndex(0);}}><span className="film-offset">{formatTimestamp(item.timestampMs)}</span><span><b>Sample {index+1}</b><small>{item.imageResult.timeline.length+item.imageResult.undatedEvidence.length+item.imageResult.supportingEvidence.length+item.imageResult.contextualEvidence.length} source leads</small></span></button>)}<div className="video-unsearched"><span>?</span><p>Unsearched moments remain unresolved.<small>Up to three moments receive external visual searches.</small></p></div></div>
  </section>;
}
