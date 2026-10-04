"use client";
import { useState } from "react";
import type { CaseEvidence } from "@/lib/cases/model";
import type { ExactAnchor, Finding } from "@/lib/inquiries/model";
import type { RetainedMaterial } from "@/lib/inquiries/materials";
import PaperDialog from "./PaperDialog";
import { newId } from "./EvidenceEditor";

export default function FindingEditor({ evidence, material, questionId, existing, initialAnchor, onSave, onClose }: { evidence: CaseEvidence; material: RetainedMaterial | null; questionId: string; existing?: Finding; initialAnchor?: ExactAnchor; onSave: (finding: Finding) => Promise<void>; onClose: () => void }) {
  const [findingId] = useState(() => newId("finding"));
  const savedAnchor = existing?.support.find(support => support.evidenceId === evidence.id)?.anchor ?? initialAnchor;
  const multipleSupports = Boolean(existing && existing.support.length !== 1);
  const [text, setText] = useState(existing?.text ?? "");
  const [quote, setQuote] = useState(savedAnchor?.kind === "text" ? savedAnchor.quote : "");
  const [start, setStart] = useState(savedAnchor?.kind === "text" ? savedAnchor.start : 0);
  const [relationship, setRelationship] = useState<"supports" | "challenges" | "context">(existing?.support[0].relationship ?? "context");
  const [assessmentKind, setAssessmentKind] = useState<"source_statement" | "operator_inference">(existing?.assessment.kind ?? "operator_inference");
  const [reviewer, setReviewer] = useState(existing?.assessment.reviewer ?? "");
  const [rationale, setRationale] = useState("");
  const [region, setRegion] = useState(savedAnchor?.kind === "image_region" ? { x: savedAnchor.x, y: savedAnchor.y, width: savedAnchor.width, height: savedAnchor.height } : { x: 0, y: 0, width: material?.content.kind === "image" ? material.content.width : 1, height: material?.content.kind === "image" ? material.content.height : 1 });
  const [row, setRow] = useState(savedAnchor?.kind === "table_cell" ? savedAnchor.row : 0), [column, setColumn] = useState(savedAnchor?.kind === "table_cell" ? savedAnchor.column : 0);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const canAnchor = !multipleSupports && (evidence.content.kind === "text" || material !== null);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (busy || multipleSupports) return; setError(null);
    try {
      let anchor: ExactAnchor;
      if (evidence.content.kind === "text") {
        if (!quote || evidence.content.text.slice(start, start + quote.length) !== quote) throw new Error("The exact quote must match the retained passage at the selected character offset.");
        anchor = { kind: "text", start, quote };
      } else if (material?.content.kind === "image") anchor = { kind: "image_region", materialId: material.materialId, materialDigest: material.digest, ...region };
      else if (material?.content.kind === "table") {
        const value = material.content.rows[row]?.[column]; if (value === undefined) throw new Error("Choose a cell inside the retained table.");
        anchor = { kind: "table_cell", materialId: material.materialId, materialDigest: material.digest, row, column, value };
      } else throw new Error("This evidence has no retained material for an exact selection.");
      setBusy(true); await onSave({ kind: "finding", id: existing?.id ?? findingId, questionId, text, assessment: { kind: assessmentKind, reviewer, rationale }, support: [{ evidenceId: evidence.id, relationship, anchor }] }); onClose();
    } catch (error) { setError(error instanceof Error ? error.message : "Could not save this finding."); } finally { setBusy(false); }
  }
  return <PaperDialog title={existing ? "Review this finding again" : "Pin a finding to the evidence"} description="Your assessment stays separate from the source. An exact selection records what you reviewed; it does not establish truth or authenticity." onClose={onClose} busy={busy} editing>
    <form className="form-stack" onSubmit={submit}><label className="field">Finding<textarea disabled={busy} required maxLength={20000} value={text} onChange={event => setText(event.target.value)} /></label>
      {evidence.content.kind === "text" ? <><label className="field">Exact quote<textarea disabled={busy} required value={quote} onChange={event => { setQuote(event.target.value); if (evidence.content.kind === "text") setStart(Math.max(0, evidence.content.text.indexOf(event.target.value))); }} /><small>The passage is shown below. First matching location is selected; change the offset for a repeated quote.</small></label><label className="field">Character offset<input disabled={busy} type="number" required min={0} step={1} value={start} onChange={event => setStart(event.target.valueAsNumber)} /></label><p className="fine-print" style={{whiteSpace:"pre-wrap"}}>{evidence.content.text}</p></> : null}
      {material?.content.kind === "image" ? <><img className="retained-image" src={`data:image/png;base64,${material.content.base64}`} alt="Supplied image for the exact region selection" /><div className="form-grid">{(["x", "y", "width", "height"] as const).map(key => <label className="field" key={key}>{key} in pixels<input disabled={busy} type="number" required step={1} min={key === "width" || key === "height" ? 1 : 0} value={region[key]} onChange={event => setRegion(previous => ({ ...previous, [key]: event.target.valueAsNumber }))} /></label>)}</div><p className="fine-print">Coordinates use the retained image&apos;s {material.content.width} × {material.content.height} pixels. This is a selection, not an authenticity judgment.</p></> : null}
      {material?.content.kind === "table" ? <div className="form-grid"><label className="field">Data row<select disabled={busy} value={row} onChange={event => setRow(Number(event.target.value))}>{material.content.rows.map((_, index) => <option key={index} value={index}>Row {index + 1}</option>)}</select></label><label className="field">Column<select disabled={busy} value={column} onChange={event => setColumn(Number(event.target.value))}>{material.content.columns.map((title, index) => <option key={index} value={index}>{title || `Column ${index + 1}`}</option>)}</select></label><p className="fine-print">Exact cell: {material.content.rows[row]?.[column] || "(empty cell)"}</p></div> : null}
      {multipleSupports ? <p className="error-note">This finding has multiple supports. It must be reviewed through the full research workflow; this single-source editor will not overwrite it.</p> : null}
      {!canAnchor && !multipleSupports ? <p className="error-note">No retained material is available. A link alone cannot support an exact finding.</p> : null}
      <div className="form-grid"><label className="field">Relationship<select disabled={busy} value={relationship} onChange={event => { const value = event.target.value; if (value === "supports" || value === "challenges" || value === "context") setRelationship(value); }}><option value="context">Context</option><option value="supports">Supports</option><option value="challenges">Challenges</option></select></label><label className="field">Assessment<select disabled={busy} value={assessmentKind} onChange={event => { const value = event.target.value; if (value === "source_statement" || value === "operator_inference") setAssessmentKind(value); }}><option value="operator_inference">My inference</option><option value="source_statement">Source statement</option></select></label></div>
      <label className="field">Reviewer<input disabled={busy} required value={reviewer} onChange={event => setReviewer(event.target.value)} maxLength={200} /></label><label className="field">Review rationale<textarea disabled={busy} required value={rationale} onChange={event => setRationale(event.target.value)} maxLength={20000} /><small>{existing ? "Explain what you reviewed again. A changed source requires a new rationale." : "What does this selection show, and what remains uncertain?"}</small></label>
      {error ? <p role="alert" className="error-note">{error}</p> : null}<div className="dialog-actions"><button type="button" disabled={busy} className="paper-button" onClick={onClose}>Cancel</button><button className="paper-button primary" disabled={busy || !canAnchor}>{busy ? "Saving…" : "Save finding"}</button></div>
    </form>
  </PaperDialog>;
}
