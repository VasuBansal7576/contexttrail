'use client';
import { useState } from 'react';
import type { CaseEvidence } from '@/lib/cases/model';
import type { ResearchCaseView } from '@/lib/research/client';
import { EvidencePassage, SourceActions } from './EvidenceCollection';
import {useChapterTour} from './ChapterTour';
const MAP_PAGE_SIZE = 4;
const nodePositions = [{x:30,y:88}, {x:427,y:87}, {x:675,y:243}, {x:32,y:273}];
function sourceMarker(index: number) {
  let marker = '';
  for (let position = index + 1; position > 0; position = Math.floor((position - 1) / 26)) marker = String.fromCharCode(65 + (position - 1) % 26) + marker;
  return marker;
}
export function SourceMap({ view, onInspect, onCitation }: { view: ResearchCaseView; onInspect: (evidence: CaseEvidence) => void; onCitation: () => void }) {
  const record = view.caseRecord;
  const relevance = (ids: string[]) => view.reportStatus === 'current' ? Math.max(-1, ...ids.map(id => view.claimReport?.sources.find(source => source.evidenceId === id)?.relevance ?? -1)) : -1;
  const sources = [...view.dependencies.sources].sort((a,b) => relevance(b.evidenceIds) - relevance(a.evidenceIds));
  const [selected, setSelected] = useState(sources[0]?.id ?? ''), [page, setPage] = useState(0);
  const visible = sources.slice(page * MAP_PAGE_SIZE, page * MAP_PAGE_SIZE + MAP_PAGE_SIZE);
  useChapterTour(step=>{const index=Math.max(0,Math.min(step,sources.length-1));setPage(Math.floor(index/MAP_PAGE_SIZE));setSelected(sources[index]?.id ?? '');});
  const source = sources.find(item => item.id === selected) ?? visible[0];
  const evidence = source && record.evidence.find(item => source.evidenceIds.includes(item.id));
  const references = record.coverage?.sourceReads?.flatMap(read => read.reference ? [{ from: read.reference.fromEvidenceId, to: read.evidenceId, text: read.reference.supportingText, kind: 'retained_reference' as const }] : []) ?? [];
  const supplied = view.dependencies.citationChecks.flatMap(check => check.targetEvidenceIds.map(id => ({ from: check.citation.fromEvidenceId, to: id, text: check.citation.quote?.text ?? check.citation.targetUrl, kind: 'supplied_reference' as const })));
  const edges = [...references, ...supplied];
  const incoming = evidence ? edges.filter(edge => edge.to === evidence.id || edge.from === evidence.id) : [];
  const point = (index: number) => ({ x: nodePositions[index].x + 109, y: nodePositions[index].y + 70 });
  return <section className="source-map-workspace" aria-label="Source relationships map">
    <div className="source-map-board">
      <div className="sheet-topline"><p className="eyebrow">{sources.length} retained URLs / {references.length} inspected references</p><span className="eyebrow">Origins remain open</span></div>
      <div className="source-map-canvas">
        <svg viewBox="0 0 899 410" aria-label="References between the displayed retained sources"><defs><marker id="source-arrow" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0 0L10 5L0 10" fill="none" stroke="#e2b956" strokeWidth="1.5" /></marker></defs>{edges.map((edge, index) => {
          const from = visible.findIndex(item => item.evidenceIds.includes(edge.from)), to = visible.findIndex(item => item.evidenceIds.includes(edge.to));
          if (from < 0 || to < 0 || from === to) return null;
          const a = point(from), b = point(to);
          return <path key={index} d={`M${a.x} ${a.y} Q${(a.x+b.x)/2} ${Math.min(a.y,b.y)-80} ${b.x} ${b.y}`} fill="none" stroke="#e2b956" strokeWidth="2" strokeDasharray={edge.kind === 'supplied_reference' ? '4 8' : undefined} markerEnd="url(#source-arrow)" />;
        })}</svg>
        {visible.map((item, index) => { const entry = record.evidence.find(evidence => item.evidenceIds.includes(evidence.id)); return <button className="source-map-node" aria-pressed={source?.id === item.id} onClick={() => setSelected(item.id)} key={item.id} style={{ left: `${nodePositions[index].x}px`, top: `${nodePositions[index].y}px` }}><span className="eyebrow">{sourceMarker(page*MAP_PAGE_SIZE + index)} / {entry?.content.kind === 'text' && entry.content.attribution === 'page_quote' ? relevance(item.evidenceIds) >= 0 && relevance(item.evidenceIds) < .5 ? 'Off-topic retained passage' : 'Retained passage' : 'Unverified lead'}</span><h3>{entry?.title ?? 'Untitled source'}</h3><span className="source-map-domain">{new URL(item.url).hostname}</span></button>; })}
      </div>
      <div className="source-map-paging"><button className="text-link" disabled={!page} onClick={() => { setPage(value => value-1); setSelected(sources[(page-1)*MAP_PAGE_SIZE]?.id ?? ''); }}>← Previous sources</button><span className="eyebrow">{sources.length ? page*MAP_PAGE_SIZE+1 : 0}–{Math.min(page*MAP_PAGE_SIZE+MAP_PAGE_SIZE,sources.length)} / {sources.length}</span><button className="text-link" disabled={(page+1)*MAP_PAGE_SIZE >= sources.length} onClick={() => { setPage(value => value+1); setSelected(sources[(page+1)*MAP_PAGE_SIZE]?.id ?? ''); }}>Next sources →</button></div>
    </div>
    <aside className="source-map-detail">{evidence ? <>{relevance(source.evidenceIds) >= 0 && relevance(source.evidenceIds) < .5 ? <p className="fine-print">Low topic relevance · retained for inspection, not supporting evidence.</p> : null}<span className="pill">{incoming.length ? 'A reference to inspect' : 'Lineage unresolved'}</span><h2>{evidence.title ?? 'An open thread.'}</h2><EvidencePassage text={evidence.content.kind === 'text' ? evidence.content.text : 'This record retains a media reference. Inspect its exact evidence.'} />{incoming.map((edge,index) => <div className="source-map-reference" key={index}><p className="eyebrow">{edge.kind === 'retained_reference' ? 'Observed in retained source text' : 'Citation supplied by reviewer'}</p><p>{edge.text}</p></div>)}<button className="text-link" onClick={() => onInspect(evidence)}>Inspect the complete supporting record ↗</button><SourceActions url={evidence.sourceUrl} /></> : <><h2>The trail starts with a source.</h2><p>Open a saved investigation to follow its retained evidence.</p></>}<p className="fine-print">A URL is not a reporting origin. Unlinked sources remain unresolved; they are not counted as independent corroboration.</p><button className="text-link" onClick={onCitation} disabled={!record.evidence.length}>Record a citation</button></aside>
  </section>;
}
