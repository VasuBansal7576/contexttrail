'use client';
import { EvidenceCollection, EvidencePassage, SourceActions, safeSourceUrl } from './EvidenceCollection';
import type { CaseRecord } from '@/lib/cases/model';
import type { ClaimReport, ClaimSourceAssessment } from '@/lib/research/claim-report';

const relationLabels = { support: 'Supporting excerpt', challenge: 'Challenging excerpt', context: 'Context only', insufficient: 'Insufficient evidence' } satisfies Record<ClaimSourceAssessment['relation'], string>;

/** Render validated report data against its retained case snapshot, including historical snapshots. */
export function ClaimReportView({ report, caseRecord }: { report: ClaimReport; caseRecord: CaseRecord }) {
  function sourceLink(id: string) {
    const evidence = caseRecord.evidence.find(item => item.id === id);
    return evidence && safeSourceUrl(evidence.sourceUrl) ? <a className="text-link source-url" href={evidence.sourceUrl} target="_blank" rel="noopener noreferrer">Open in new tab: {evidence.title ?? evidence.sourceUrl} ↗</a> : <span>Source unavailable</span>;
  }
  const signalledDependencies = report.dependencies.filter(pair => pair.signals.length);
  return <section className="claim-report" aria-label="Claim-scoped evidence report">
    <div className="sheet-topline"><h3>Claim-scoped evidence report</h3><span className="state-label">Partial evidence</span></div>
    {report.mode === 'explicit_claim' ? <div className="claim-report-input"><p className="eyebrow">User assertion to investigate</p><p>{report.claim}</p></div> : <p className="claim-report-input">This is a research question. Source-quoted candidate assertions below are excerpts to investigate, not claims supplied by you or established facts.</p>}
    <p className="fine-print">Excerpt relationships are model assessments. Independent corroboration is not established. No overall truth, credibility, authenticity or original-author verdict is produced.</p>
    <div className="claim-report-sources">{report.sources.length ? <EvidenceCollection items={report.sources} label="Source assessments">{source => {
      const evidence = caseRecord.evidence.find(item => item.id === source.evidenceId);
      return <article className="source-card claim-report-source" key={source.evidenceId}>
        <p className="eyebrow">{relationLabels[source.relation]}</p>
        <details className="source-inspection"><summary><h4>{evidence?.title ?? "Untitled source"}</h4><span className="text-link">Inspect assessment and retained quote</span></summary>
        {source.candidateAssertion ? <p className="fine-print">Source-quoted candidate assertion</p> : <p className="fine-print">Retained source excerpt</p>}
        {source.quote ? <><blockquote><EvidencePassage text={source.quote.text} /></blockquote><p className="fine-print">{source.quote.attribution.replaceAll('_', ' ')} · Exact retained text, characters {source.quote.start}–{source.quote.end}. Matching these words establishes the quotation, not its truth.</p></> : <p className="fine-print">No exact source quote is available.</p>}
        <dl className="claim-report-scope"><div><dt>Entity / property</dt><dd>{source.scope.entityProperty}</dd></div><div><dt>Time</dt><dd>{source.scope.time}</dd></div><div><dt>Variant / location / population</dt><dd>{source.scope.variant}</dd></div></dl>
        <p className="fine-print">Retrieved: {evidence?.provenance.retrievedAt ?? 'Unknown'} · Method: {evidence?.provenance.method.replaceAll('_', ' ') ?? 'Unknown'}</p>
        <ul className="fine-print">{source.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>
        <details className="claim-report-method"><summary>Model probabilities and method</summary><p className="fine-print">Model: {source.model ?? 'Unverified or unavailable'}. These probabilities describe excerpt classifications, not the probability that the user assertion is true. The displayed relationship may be withheld when scope is unresolved.</p><dl className="claim-report-probabilities">{Object.entries(source.probabilities).map(([name, value]) => <div key={name}><dt>{name.replaceAll('_', ' ')}</dt><dd>{value === null ? 'Unavailable' : typeof value === 'number' ? String(value) : Object.entries(value).map(([label, probability]) => `${label}: ${probability}`).join(' · ')}</dd></div>)}</dl></details>
      </details>{evidence ? <SourceActions url={evidence.sourceUrl} /> : null}</article>;
    }}</EvidenceCollection> : <p className="empty-state">No claim-scoped source assessment is available.</p>}</div>
    <section className="claim-report-dependencies" aria-label="Source dependence"><h4>Are these separate accounts?</h4><p>Independent corroboration is not established. Source dependence remains unknown, including across different domains.</p>{signalledDependencies.length ? <EvidenceCollection items={signalledDependencies} label="Source relationships">{(pair, index) => <div className="claim-report-pair" key={index}><p>{sourceLink(pair.evidenceIds[0])} · {sourceLink(pair.evidenceIds[1])}</p>{pair.signals.map((signal, i) => <div key={i}><p className="fine-print">{signal.kind === 'exact_duplicate_passage' ? 'Exact duplicate passage signal' : 'Citation URL signal'}</p><EvidencePassage text={signal.text} /></div>)}<p className="fine-print">This signal does not establish copying direction, a separate account or deception.</p></div>}</EvidenceCollection> : <p className="fine-print">No retained exact-duplicate passage or citation signal is listed. That does not prove independence.</p>}</section>
    <section className="claim-report-disagreements" aria-label="Unresolved source disagreements"><h4>Unresolved source disagreements</h4>{report.unresolvedDisagreements.length ? report.unresolvedDisagreements.map((pair, index) => <div key={index}><p>{sourceLink(pair.evidenceIds[0])} · {sourceLink(pair.evidenceIds[1])}</p><p>{pair.reason}</p></div>) : <p className="fine-print">No opposing scoped relationships were established in the retained sample. This does not establish consensus; different experiences or unresolved scope may coexist.</p>}</section>
    <details className="claim-report-limits" open><summary>Report limits</summary><ul>{report.limitations.map((limit, index) => <li key={index}>{limit}</li>)}</ul></details>
  </section>;
}
