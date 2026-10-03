import type { CaseRecord, CaseSourceRead } from '@/lib/cases/model';
import { researchLimitationCopy } from '@/lib/research/display-copy';
const readLabels = { page_quote: 'Page quotations retained', fetch_failed: 'Failed reads', binding_rejected: 'Rejected destinations', no_readable_text: 'Pages without readable text', no_matching_quote: 'Pages without a matching quote', not_attempted: 'Unattempted leads' } satisfies Record<CaseSourceRead['outcome'], string>;

export function SavedInvestigationCoverage({ snapshot, historical }: { snapshot: CaseRecord | null; historical: boolean }) {
  return <section className="automatic-limitations" aria-label="Saved investigation coverage">
    <h3>Limits of the saved investigation</h3>
    {!snapshot ? <p>The original investigation coverage snapshot was not retained with this older report. Coverage, omitted candidates and source-read failures at investigation time are unavailable. This does not establish complete or primary-source coverage. Current case coverage is not substituted for the original investigation.</p> : <>
      <p className="fine-print">Retained case snapshot · revision {snapshot.revision} · case record created {snapshot.createdAt}. {historical ? 'These limits belong to the original historical report, which needs review; they do not describe the current corrected case.' : 'These limits belong to the investigation saved with this report, rather than later edits to current case coverage.'} Reopening performs no source reads or model assessment.</p>
      <p className="fine-print">{snapshot.coverage.completeness} coverage · {snapshot.coverage.omittedEvidenceCount} omitted candidates. Original publication unknown: {snapshot.coverage.originalPublication.reason}</p>
      {snapshot.coverage.limitations.length ? <><ul>{[...new Set(snapshot.coverage.limitations.map(researchLimitationCopy))].map(limit => <li key={limit}>{limit}</li>)}</ul><details><summary>Inspect retained limitation details</summary><ul className="fine-print">{snapshot.coverage.limitations.map((limit, index) => <li key={index}>{limit}</li>)}</ul></details></> : <p>No investigation-wide limitation text was retained. This does not mean the investigation had no limitations or established primary-source coverage.</p>}
      {!snapshot.coverage.sourceReads?.length ? <p className="fine-print">A source-read audit was not retained. Missing audit metadata does not establish successful reads or an absence of failures.</p> : <><p className="fine-print">Retained source-read outcomes, including unattempted leads where recorded. These records do not establish complete coverage; no new reads were made on reopen.</p><ul className="fine-print" aria-label="Retained source-read outcomes">{Object.entries(readLabels).map(([outcome, label]) => {
        const count = snapshot.coverage.sourceReads?.filter(read => read.outcome === outcome).length ?? 0;
        return count ? <li key={outcome}>{label}: {count}</li> : null;
      })}</ul></>}
    </>}
  </section>;
}
