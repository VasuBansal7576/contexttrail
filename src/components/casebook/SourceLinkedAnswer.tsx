'use client';
import Link from 'next/link';
import { useState } from 'react';
import type { ResearchCaseView } from '@/lib/research/client';
import { sourceStatements } from '@/lib/research/dossier';
import { EvidencePassage, SourceActions } from './EvidenceCollection';
import { ChapterHeading } from './CasebookShell';
import {useChapterTour} from './ChapterTour';
export function SourceLinkedAnswer({ view }: { view: ResearchCaseView }) {
  const report = view.claimReport, record = view.claimReportCase;
  const all = report && record ? sourceStatements(report,record) : [];
  const statements = all.filter(statement => statement.quote.text.length <= 380).filter((statement,index,items) => items.findIndex(other => other.evidence.sourceUrl === statement.evidence.sourceUrl) === index).slice(0,3);
  const [selected,setSelected] = useState(0);
  useChapterTour(step=>setSelected(Math.max(0,Math.min(step,statements.length-1))));
  const statement = statements[Math.min(selected,statements.length-1)];
  return <div className="answer-workspace">
    <aside className="answer-copy"><p className="eyebrow">08 / Source-linked answer</p><ChapterHeading number="08" label="Inspect one assertion at a time" description="Read what a source says. Keep its exact words beside the evidence and the questions that remain.">An answer.<br /><em>A visible<br />trail.</em></ChapterHeading><div className="answer-key"><span>Exact retained quotation</span><span>Attributed to its source</span><span>Open to review</span></div><Link href={`/casebook?case=${encodeURIComponent(view.caseId)}&chapter=questions`} className="text-link">Return to the research question ↗</Link></aside>
    <div className="answer-reading"><article className="answer-paper"><p className="eyebrow">{view.question}</p><p className="answer-provenance">Quoted from retained sources. Select a sentence to inspect its evidence.</p>{statements.length ? <div className="answer-body">{statements.map((item,index) => <button aria-pressed={selected === index} key={`${item.evidence.id}-${item.quote.start}`} onClick={() => setSelected(index)}>“{item.quote.text}”<sup>{index+1}</sup></button>)}</div> : <><h2>The answer stays open.</h2><p>No suitable inspected source assertion is retained for this view. Open the case’s evidence to inspect its sources.</p><Link href={`/casebook?case=${encodeURIComponent(view.caseId)}&chapter=evidence`} className="text-link">Inspect the saved evidence ↗</Link></>}</article>
      {statement ? <section className="answer-evidence" aria-label="Selected assertion evidence"><p className="eyebrow">Assertion {selected+1} / exact source span</p><h2>{report?.mode === 'explicit_claim' ? statement.relation === 'support' ? 'The source supports this claim.' : statement.relation === 'challenge' ? 'The source challenges this claim.' : 'Its relationship stays open.' : 'The source says this.'}</h2><EvidencePassage text={statement.quote.text} /><p className="fine-print">{statement.evidence.title ?? 'Untitled source'} · retained characters {statement.quote.start}–{statement.quote.end}. {report?.mode === 'explicit_claim' ? 'Relationship is the saved excerpt assessment, not a truth verdict.' : 'An exact quotation establishes what the retained source says. It does not establish that the assertion is true.'}</p><SourceActions url={statement.evidence.sourceUrl} /></section> : null}
      {view.reportStatus === 'stale' ? <p className="error-note" role="status">Needs review. These assertions come from the original report’s retained evidence, before later changes.</p> : null}
    </div>
  </div>;
}
