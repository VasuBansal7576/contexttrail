'use client';
import { useState } from 'react';
import type { CaseRecord } from '@/lib/cases/model';
import type { ClaimReport } from '@/lib/research/claim-report';
import { researchDossier } from '@/lib/research/dossier';
import { EvidencePassage, SourceActions } from './EvidenceCollection';
import {useChapterTour} from './ChapterTour';
const labels = { general: 'Open-ended research', news: 'Claim investigation', brand: 'Brand investigation', reviews: 'Review-pattern investigation', attribution: 'Attribution investigation', shopping: 'Product mismatch investigation' };
export function ResearchDossier({ report, caseRecord }: { report: ClaimReport; caseRecord: CaseRecord }) {
  const dossier = researchDossier(report, caseRecord);
  const wanted = dossier.focus === 'news' && /\b(?:\d{4}|\d[\d,]*\s*(?:km|kilomet|million|billion|percent|crore))\b/i.test(report.question) ? 'scope'
    : dossier.focus === 'general' && /^(?:why|how)\b/i.test(report.question) ? 'mechanisms' : dossier.sections[0].id;
  const preferred = dossier.sections.find(section => section.id === wanted && section.statements.length)?.id
    ?? dossier.sections.find(section => section.statements.length)?.id ?? wanted;
  const [selected, setSelected] = useState(preferred), [passage, setPassage] = useState(0);
  const section = dossier.sections.find(section => section.id === selected) ?? dossier.sections[0];
  const statement = section.statements[Math.min(passage, section.statements.length - 1)];
  useChapterTour(step=>{setSelected(dossier.sections[Math.min(step,dossier.sections.length-1)].id);setPassage(0);});
  return <section className="research-dossier" aria-label="Evidence-linked research account">
    <div className="sheet-topline"><p className="eyebrow">{labels[dossier.focus]}</p><span className="state-label">Inspected source passages</span></div>
    <p className="dossier-intro">Select a part of the question to examine.</p>
    <div className="dossier-tabs" role="group" aria-label="Parts of the research question">{dossier.sections.map((item, index) => <button key={item.id} aria-pressed={item.id === section.id} onClick={() => { setSelected(item.id); setPassage(0); }}><span className="letter">{String.fromCharCode(65 + index)}</span><h3>{item.title}</h3><span className="eyebrow">{item.statements.length ? `${item.statements.length} retained passage${item.statements.length === 1 ? '' : 's'}` : 'Still open'}</span></button>)}</div>
    <article className="dossier-leaf" aria-label={section.title}>
      <div className="sheet-topline"><span className="eyebrow">{section.title}</span><span className="eyebrow">{statement ? `Passage ${Math.min(passage + 1, section.statements.length)} / ${section.statements.length}` : 'No retained passage'}</span></div>
      {statement ? <><h3>{statement.evidence.title ?? 'Untitled source'}</h3><EvidencePassage text={statement.quote.text} /><p className="fine-print">{report.mode === 'explicit_claim' ? `Relationship to the exact claim: ${statement.relation}.` : 'This is the source’s assertion.'} Publication: {statement.evidence.publicationDate.status === 'observed' || statement.evidence.publicationDate.status === 'inferred' ? `${statement.evidence.publicationDate.observation.value} (${statement.evidence.publicationDate.status})` : statement.evidence.publicationDate.status}.</p><SourceActions url={statement.evidence.sourceUrl} /><div className="dossier-leaf-bottom"><span className="eyebrow">Exact retained span · {statement.quote.start}–{statement.quote.end}</span><div className="button-row"><button className="text-link" disabled={passage === 0} onClick={() => setPassage(value => value - 1)}>← Previous passage</button><button className="text-link" disabled={passage >= section.statements.length - 1} onClick={() => setPassage(value => value + 1)}>Next passage →</button></div></div></> : <><h3>A question stays open.</h3><p>{section.wanted}</p><p className="fine-print">The inspected sample does not establish this part of the question. Open the sources below to inspect the remaining leads.</p></>}
    </article>
    <details className="research-method"><summary>Related versions and wording · {dossier.connections.length} connections</summary><p className="fine-print">Inspect the passages together. Shared wording does not establish who copied whom, authorship or source independence.</p>{dossier.connections.length ? dossier.connections.map((connection, index) => <article className="paper-sheet" key={index}><p className="eyebrow">{connection.status === 'same_retained_wording' ? 'Exact match of retained wording' : 'Plausible connection; unresolved lineage'}</p><p>{connection.reason}</p><EvidencePassage text={connection.left.quote.text} /><SourceActions url={connection.left.evidence.sourceUrl} /><EvidencePassage text={connection.right.quote.text} /><SourceActions url={connection.right.evidence.sourceUrl} /></article>) : <p>No sufficiently close inspected passage pair was found.</p>}</details>
    {dossier.focus === 'reviews' ? <p className="fine-print">A poor experience is not proof of a fake review. Multiple complaints need relevant dates, purchases and independence checks. Suppression, incentives and fabrication are different practices.</p> : null}
    {dossier.focus === 'attribution' ? <p className="fine-print">The earliest appearance found does not establish authorship. Credits, publication history and permission need their own evidence.</p> : null}
    {dossier.focus === 'shopping' ? <p className="fine-print">Compare the exact listing and received item, including the variant and batch. Photography can change a product’s appearance.</p> : null}
  </section>;
}
