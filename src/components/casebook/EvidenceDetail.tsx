"use client";
import type { CaseEvidence } from "@/lib/cases/model";
import type { ExactAnchor } from "@/lib/inquiries/model";
import type { RetainedMaterial } from "@/lib/inquiries/materials";
import type { ResearchCaseView, ResearchFindingSupport } from "@/lib/research/client";
import PaperDialog from "./PaperDialog";

/** Origin describes acquisition, independently of whether a finding uses the record. */
export function evidenceOrigin(evidence: CaseEvidence): string {
  const method = evidence.provenance.method;
  switch (method) {
    case "manual":
    case "user_submission": return "User-supplied evidence";
    case "page_extraction":
    case "retrieval":
      if (evidence.content.kind === "text") {
        if (evidence.content.attribution === "search_snippet") return "Retrieved search snippet";
        if (evidence.content.attribution === "page_quote") return "Retrieved page text";
      }
      return "Retrieved source record";
    case "model_assessment": return "Source origin unknown";
    default: { const exhaustive: never = method; return exhaustive; }
  }
}

export function currentMaterial(view: ResearchCaseView, evidenceId: string, materialId?: string): RetainedMaterial | null {
  const head = view.materials.heads.find(head => head.status === "available" && head.sourceStatus === "bound" && (!materialId || head.materialId === materialId) && view.materials.versions.some(version => version.digest === head.digest && version.evidenceId === evidenceId));
  return head?.status === "available" && head.sourceStatus === "bound" ? view.materials.versions.find(version => version.digest === head.digest) ?? null : null;
}
export function MaterialView({ material, anchor }: { material: RetainedMaterial; anchor?: ExactAnchor }) {
  const content = material.content;
  if (content.kind === "image") return <div className="region-frame"><img className="retained-image" src={`data:${content.mimeType};base64,${content.base64}`} alt="Retained source image" />{anchor?.kind === "image_region" ? <div className="region-selection" role="img" aria-label={`Selected region: x ${anchor.x}, y ${anchor.y}, width ${anchor.width}, height ${anchor.height} pixels`} style={{ left: `${anchor.x / content.width * 100}%`, top: `${anchor.y / content.height * 100}%`, width: `${anchor.width / content.width * 100}%`, height: `${anchor.height / content.height * 100}%` }} /> : null}</div>;
  return <div className="material-scroll"><table className="material-table"><caption className="fine-print" style={{textAlign:"left",margin:"0 0 14px"}}>Retained table · revision {material.revision} · supplied data</caption><thead><tr><th scope="col">Row</th>{content.columns.map((title, column) => <th scope="col" key={column}>{title || `Column ${column + 1}`}</th>)}</tr></thead><tbody>{content.rows.map((row, rowIndex) => <tr key={rowIndex}><th scope="row">{rowIndex + 1}</th>{row.map((value, columnIndex) => <td key={columnIndex} className={anchor?.kind === "table_cell" && anchor.row === rowIndex && anchor.column === columnIndex ? "selected-cell" : ""}>{value || <span className="muted">Empty</span>}</td>)}</tr>)}</tbody></table></div>;
}
export default function EvidenceDetail({ view, evidence, support, onClose, onFinding, onCorrect }: { view: ResearchCaseView; evidence: CaseEvidence; support?: ResearchFindingSupport; onClose: () => void; onFinding: () => void; onCorrect: () => void }) {
  const anchor = support?.anchor;
  const retained = anchor?.kind === "image_region" || anchor?.kind === "table_cell" ? view.materials.versions.find(material => material.materialId === anchor.materialId && material.digest === anchor.materialDigest) ?? null : currentMaterial(view, evidence.id);
  const historical = support?.historicalText;
  const oldPassage = historical?.evidence.content.kind === "text" ? historical.evidence.content.text : null;
  const displayed = evidence;
  const linkedSupport = view.findingViews.flatMap(finding => finding.support).filter(item => item.evidenceId === evidence.id);
  const hasFinding = Boolean(support) || linkedSupport.length > 0;
  const needsReview = support ? support.status !== "current" : linkedSupport.some(item => item.status !== "current");
  const findingLabel = !hasFinding ? "Not linked to a finding" : needsReview ? "Finding needs review" : "Finding link current";
  const passage = displayed.content.kind === "text" ? displayed.content.text : null;
  const matched = support?.status !== "changed" && passage !== null && anchor?.kind === "text" && passage.slice(anchor.start, anchor.start + anchor.quote.length) === anchor.quote;
  return <PaperDialog wide title={displayed.title ?? "Untitled source"} description="Read the retained evidence beside its publication and retrieval dates. Open the original page to inspect the source." onClose={onClose}>
    {support && support.status !== "current" ? <p role="status" className="error-note">This finding needs review. {support.reason ?? "The source record changed after it was reviewed."} {"The saved selection is shown separately from the current source; it is not silently rebound to the new source."}</p> : null}
    <div className="evidence-detail-grid"><div><div className="sheet-topline"><span className="eyebrow">{displayed.content.kind === "text" ? displayed.content.attribution.replaceAll("_", " ") : retained?.content.kind === "image" ? "Retained image" : retained?.content.kind === "table" ? "Retained table" : "Source reference"}</span><span className="state-label">{findingLabel}</span></div>
      <p className="fine-print">{evidenceOrigin(displayed)}</p>
      {support && support.status !== "current" && anchor?.kind === "text" ? <section><p className="eyebrow">Saved quote / original review</p><p className="evidence-passage">{oldPassage !== null ? <>{oldPassage.slice(0, anchor.start)}<mark>{anchor.quote}</mark>{oldPassage.slice(anchor.start + anchor.quote.length)}</> : <mark>{anchor.quote}</mark>}</p>{historical ? <><p className="fine-print">Matching retained source revision {historical.caseRevision}. Capture timestamps are excluded from the match; this is not proof of the original capture time.</p><a className="text-link source-url" href={historical.evidence.sourceUrl} target="_blank" rel="noopener noreferrer">Open historical source URL</a><p className="fine-print">Historical source retrieved: {historical.evidence.provenance.retrievedAt ?? "Not recorded"}</p><p className="fine-print">Retained snapshot captured: {historical.evidence.provenance.capturedAt ?? "Not recorded"}</p></> : <p className="fine-print">No matching retained source revision is available. Only the saved quote can be shown.</p>}<p className="eyebrow" style={{marginTop:24}}>Current source snapshot</p></section> : null}
      {passage !== null ? <p className="evidence-passage">{matched && anchor?.kind === "text" ? <>{passage.slice(0, anchor.start)}<mark>{anchor.quote}</mark>{passage.slice(anchor.start + anchor.quote.length)}</> : passage}</p> : null}
      {retained ? <MaterialView material={retained} anchor={anchor} /> : displayed.content.kind !== "text" ? <p className="empty-state">This record has no retained image or table snapshot. The source link is available below.</p> : null}
      {anchor ? <p className="fine-print">{anchor.kind === "text" ? `Exact quote at UTF-16 characters ${anchor.start}–${anchor.start + anchor.quote.length}` : anchor.kind === "image_region" ? `Exact region: ${anchor.x}, ${anchor.y}; ${anchor.width} × ${anchor.height} pixels` : anchor.kind === "table_cell" ? `Exact cell: data row ${anchor.row + 1}, column ${anchor.column + 1}` : `Time span: ${anchor.startMs} ms for ${anchor.durationMs} ms`}</p> : null}
      <a className="text-link source-url" href={displayed.sourceUrl} target="_blank" rel="noopener noreferrer">Open original source</a>
      <details className="research-method"><summary>Interpretation and evidence status</summary>{!hasFinding ? <p className="fine-print">No finding links to this record. Review the material and its source before using it as evidence. Use Record a correction to fix the saved record, or Add a finding to record your interpretation.</p> : null}<p className="fine-print">Retained text and exact quote matches do not establish relevance or truth. A source title may describe different material from the retained passage.</p></details>
    </div><dl className="evidence-meta"><dt>Publication date</dt><dd>{displayed.publicationDate.status === "observed" || displayed.publicationDate.status === "inferred" ? `${displayed.publicationDate.observation.value} · ${displayed.publicationDate.status}` : displayed.publicationDate.status === "disputed" ? "Disputed" : "Unknown"}</dd><dt>Current source retrieved</dt><dd>{displayed.provenance.retrievedAt ?? "Not recorded"}</dd><dt>Current source captured</dt><dd>{displayed.provenance.capturedAt ?? "Not recorded"}</dd><dt>Current source URL</dt><dd>{displayed.sourceUrl}</dd><dt>Evidence ID</dt><dd>{displayed.id}</dd>{retained ? <><dt>Retained snapshot captured</dt><dd>{retained.capturedAt}</dd><dt>Snapshot revision</dt><dd>{retained.revision}</dd><dt>Material digest</dt><dd>{retained.digest}</dd></> : null}<dt>Method</dt><dd>{displayed.provenance.method.replaceAll("_", " ")}</dd></dl></div>
    <div className="dialog-actions"><button className="paper-button" onClick={onCorrect}>Record a correction</button><button className="paper-button primary" onClick={onFinding}>Add a finding</button></div>
  </PaperDialog>;
}
