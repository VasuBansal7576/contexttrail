'use client';

import type { CaseRecord } from '@/lib/cases/model';
import type { ClaimReport } from '@/lib/research/claim-report';
import { researchAccount } from '@/lib/research/account';
import { SourceRecoveryTrail } from './SourceRecoveryTrail';
import { ResearchDossier } from './ResearchDossier';
import { EvidencePassage, SourceActions } from './EvidenceCollection';

export function ResearchAccount({ report, caseRecord }: { report: ClaimReport; caseRecord: CaseRecord }) {
  const account = researchAccount(report, caseRecord);
  const preferred = report.mode === 'explicit_claim' && (account.supporting.length || account.challenging.length)
    ? [...account.supporting, ...account.challenging, ...account.sources.filter(source => source.assessment.relation !== 'support' && source.assessment.relation !== 'challenge')] : account.sources;
  const dated = caseRecord.evidence.filter(source => source.publicationDate.status === 'observed' || source.publicationDate.status === 'inferred')
    .sort((a, b) => {
      const left = a.publicationDate, right = b.publicationDate;
      return (left.status === 'observed' || left.status === 'inferred') && (right.status === 'observed' || right.status === 'inferred')
        ? left.observation.value.localeCompare(right.observation.value) || a.id.localeCompare(b.id) : 0;
    });
  const undated = caseRecord.evidence.filter(source => source.publicationDate.status === 'unknown' || source.publicationDate.status === 'disputed');
  return <section className={`research-account${report.mode === 'source_assertions' ? ' research-account-topic' : ''}`} aria-label="Research explanation">
    {report.mode === 'explicit_claim' ? <><div className="sheet-topline"><p className="eyebrow">Your evidence, brought together</p><span className="state-label">Open to revision</span></div>
    <h2>{account.headline}</h2>
    <p className="account-intro">This account compares the exact claim with the retained excerpts. Supporting or challenging a claim is an assessment of these passages.</p>
    <div className="account-reading"><span><strong>{account.readCount}</strong> retained page passages</span><span><strong>{account.leadCount}</strong> remaining leads</span><span>Publication dates kept separate from retrieval</span></div></> : null}
    {report.mode === 'source_assertions' ? <ResearchDossier report={report} caseRecord={caseRecord} /> : null}
    <details className="research-method" open={report.mode === 'explicit_claim'}><summary>{report.mode === 'explicit_claim' ? 'The claim beside its retained source passages' : 'Inspect the longest retained passages'}</summary>
{preferred.length ? <div className="account-passages">{preferred.slice(0, 4).map((source, index) => <article className="account-passage" key={source.evidence.id}>
      <p className="eyebrow">{String(index + 1).padStart(2, '0')} / {source.attribution === 'page_quote' ? 'Retained page passage' : 'Search lead, page not verified'}{report.mode === 'explicit_claim' ? ` / ${source.assessment.relation === 'support' ? 'Supports' : source.assessment.relation === 'challenge' ? 'Challenges' : 'Related context'}` : ''}</p>
      <h3>{source.evidence.title ?? 'Untitled source'}</h3>
      <EvidencePassage text={source.passage} />
      {report.mode === 'explicit_claim' && source.assessment.relation !== 'support' && source.assessment.relation !== 'challenge' ? <p className="fine-print">{source.assessment.scope.time === 'different' ? 'This excerpt addresses a different time period.' : source.assessment.scope.variant === 'different' ? 'This excerpt concerns a different version, location or population.' : source.assessment.scope.entityProperty === 'different' ? 'This excerpt addresses a different entity or property.' : 'The exact scope of this excerpt remains unresolved.'} Its relationship to the full claim is withheld.</p> : null}
      <details><summary className="text-link">Inspect source and dates</summary><SourceActions url={source.evidence.sourceUrl} /><p className="fine-print">Publication: {source.evidence.publicationDate.status === 'observed' || source.evidence.publicationDate.status === 'inferred' ? `${source.evidence.publicationDate.observation.value} (${source.evidence.publicationDate.status})` : source.evidence.publicationDate.status}. Retrieved: {source.evidence.provenance.retrievedAt ?? 'Unknown'}. These dates do not establish when an event happened.</p></details>
    </article>)}</div> : <p className="empty-state">No relevant, exactly bound passage was established. Inspect the retrieved leads below. An empty account does not establish that the claim is false.</p>}
    </details>
    <details className="research-method"><summary>Read the trail by publication date</summary>
      <p className="fine-print">Publication order in the retrieved sample. This is not an event, capture-time or spread timeline. Dates with year or month precision can overlap other entries; inferred dates remain labelled.</p>
      <ol className="publication-trail">{dated.map(source => <li key={source.id}>{source.publicationDate.status === 'observed' || source.publicationDate.status === 'inferred' ? <p className="eyebrow">{source.publicationDate.observation.value} / {source.publicationDate.status} / {source.publicationDate.observation.precision} precision</p> : null}<h3>{source.title ?? 'Untitled source'}</h3><p className="fine-print">{source.content.kind === 'text' && source.content.attribution === 'page_quote' ? 'Retained page passage' : 'Lead; page passage not retained'}</p><SourceActions url={source.sourceUrl} /></li>)}</ol>
      {undated.length ? <p className="fine-print">{undated.length} sources have unknown or disputed publication dates and cannot be placed in this order. They remain available in the source explorer.</p> : null}
    </details>
    {report.mode === 'explicit_claim' ? <ResearchDossier report={report} caseRecord={caseRecord} /> : null}
    <SourceRecoveryTrail record={caseRecord} />
    <div className="account-open"><p className="eyebrow">Still open</p><p>{report.unresolvedDisagreements.length ? 'The retained report contains opposing assessments. Their exact source bindings are available in the detailed report below.' : 'Independent corroboration and complete source coverage have not been established.'} {account.leadCount ? `${account.leadCount} retained leads lack an inspected page passage.` : 'Even an inspected passage can be mistaken or incomplete.'}</p></div>
  </section>;
}
