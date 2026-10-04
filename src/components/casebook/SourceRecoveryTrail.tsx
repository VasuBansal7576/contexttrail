import type { CaseRecord } from '@/lib/cases/model';
import { EvidencePassage, SourceActions } from './EvidenceCollection';
export function SourceRecoveryTrail({ record }: { record: CaseRecord }) {
  const reads = record.coverage.sourceReads?.filter(read => read.reference) ?? [];
  if (!reads.length) return null;
  return <details className="research-method"><summary>Followed references from inspected pages · {reads.length}</summary><p className="fine-print">These references were explicitly present in retained parent passages. Following a reference does not establish that the destination is authoritative or independent. Destination text and dates stay under their own source.</p>{reads.map(read => {
    const source = record.evidence.find(e => e.id === read.evidenceId), parent = record.evidence.find(e => e.id === read.reference?.fromEvidenceId);
    return <article className="account-passage" key={read.evidenceId}><p className="eyebrow">From {parent?.title ?? 'An originally inspected parent source'}</p><EvidencePassage text={read.reference!.supportingText} />{parent ? <SourceActions url={parent.sourceUrl} /> : <p className="fine-print">The original parent evidence is absent from this revision. Inspect the retained report and correction history.</p>}<h3>{source?.title ?? read.reference!.text}</h3><SourceActions url={source?.sourceUrl ?? read.requestedUrl} /><p className="fine-print">{read.outcome === 'page_quote' ? 'Destination passage retained.' : 'Destination remains a lead; no inspected quote was retained.'} {read.finalUrl && read.finalUrl !== read.requestedUrl ? 'The requested reference redirected. The final source is recorded separately.' : ''}</p></article>;
  })}</details>;
}
