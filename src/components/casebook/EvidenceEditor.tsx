"use client";
import { useRef, useState } from "react";
import type { CaseEvidence, MediaAsset, Provenance } from "@/lib/cases/model";
import type { MaterialInput, RetainedMaterial } from "@/lib/inquiries/materials";
import type { ResearchChange } from "@/lib/research/workflow";
import PaperDialog from "./PaperDialog";

type EvidenceKind = "text" | "image" | "table";
export type SaveEvidence = (change: ResearchChange, material?: { materialId: string; revision: number; content: MaterialInput["content"] }) => Promise<void>;
export function newId(prefix: string) { return `${prefix}:${crypto.randomUUID()}`; }
export function manualProvenance(): Provenance { return { method: "manual", toolVersion: null, capturedAt: new Date().toISOString(), retrievedAt: null, rights: "user_provided", retention: "reference_only", contentHash: null }; }
function encode(bytes: Uint8Array) { let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary); }

export default function EvidenceEditor({ existing, existingAsset, retained, onClose, onSave }: { existing?: CaseEvidence; existingAsset?: MediaAsset; retained?: RetainedMaterial; onClose: () => void; onSave: SaveEvidence }) {
  const submitting = useRef(false);
  const canSupplyMaterial = !existing || Boolean(retained) || existing.content.kind === "reference" || existingAsset?.kind === "image";
  const [capturedAt] = useState(() => new Date().toISOString());
  const [evidenceId] = useState(() => newId("evidence"));
  const [assetId] = useState(() => newId("asset"));
  const [materialId] = useState(() => newId("material"));
  const [kind, setKind] = useState<EvidenceKind>(retained?.content.kind === "image" || existingAsset?.kind === "image" ? "image" : retained?.content.kind === "table" || existing?.content.kind === "reference" ? "table" : "text");
  const [title, setTitle] = useState(existing?.title ?? "");
  const [url, setUrl] = useState(existing?.sourceUrl ?? "");
  const [passage, setPassage] = useState(existing?.content.kind === "text" ? existing.content.text : "");
  const [attribution, setAttribution] = useState<"page_quote" | "search_snippet" | "classification_context">(existing?.content.kind === "text" ? existing.content.attribution : "page_quote");
  const [file, setFile] = useState<File | null>(null);
  const originalTable = useRef(retained?.content.kind === "table" ? retained.content : null);
  const initialTableText = useRef(retained?.content.kind === "table" ? [retained.content.columns, ...retained.content.rows].map(row => row.join("\t")).join("\n") : "");
  const openedSource = useRef(existing);
  const sourceChanged = Boolean(existing && openedSource.current && JSON.stringify(existing) !== JSON.stringify(openedSource.current));
  const [table, setTable] = useState(retained?.content.kind === "table" ? [retained.content.columns, ...retained.content.rows].map(row => row.join("\t")).join("\n") : "");
  const [rights, setRights] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (submitting.current) return; submitting.current = true; setBusy(true); setError(null);
    try {
      const source = new URL(url); if (!["https:", "http:"].includes(source.protocol) || source.username || source.password) throw new Error("Use an HTTP or HTTPS source URL without credentials.");
      if (!rights) throw new Error("Confirm that you may supply this material before saving it.");
      const id = existing?.id ?? evidenceId, provenance = { ...manualProvenance(), capturedAt };
      let content: CaseEvidence["content"], assets: MediaAsset[] = [];
      let material: { materialId: string; revision: number; content: MaterialInput["content"] } | undefined;
      if (existing && (existing.content.kind === "text" || !canSupplyMaterial)) content = existing.content.kind === "text" ? { kind: "text", text: passage, attribution } : existing.content;
      else if (kind === "text") content = { kind: "text", text: passage, attribution };
      else if (kind === "image") {
        if ((!file && retained?.content.kind !== "image") || (file && (file.type !== "image/png" || file.size > 256 * 1024))) throw new Error("Choose a non-interlaced RGB/RGBA PNG up to 256 KiB. Other formats remain supported in image investigation.");
        content = existing?.content ?? { kind: "media", assetId, span: { kind: "whole" } };
        if (existingAsset && file) assets = [{ ...existingAsset, provenance: { ...provenance, contentHash: null } }];
        if (!existing) assets = [{ id: assetId, kind: "image", location: { kind: "not_retained" }, provenance }];
        const base64 = file ? encode(new Uint8Array(await file.arrayBuffer())) : retained?.content.kind === "image" ? retained.content.base64 : "";
        material = { materialId: retained?.materialId ?? materialId, revision: retained ? retained.revision + 1 : 1, content: { kind: "image", mimeType: "image/png", base64 } };
      } else {
        let tableContent: Extract<MaterialInput["content"], { kind: "table" }>;
        if (originalTable.current && table === initialTableText.current) tableContent = originalTable.current;
        else {
          if (originalTable.current && [...originalTable.current.columns, ...originalTable.current.rows.flat()].some(value => /[\t\r\n]/.test(value))) throw new Error("This retained table contains tabs or line breaks inside cells. Keep its text unchanged for a metadata correction; edit these cells through the lossless local research workflow.");
          const rows = table.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n").map(row => row.split("\t"));
          const columns = rows.shift(); if (!columns?.length || !rows.length || rows.some(row => row.length !== columns.length)) throw new Error("Paste a header row and at least one data row, separated by tabs. Every row needs the same number of columns.");
          tableContent = { kind: "table", columns, rows };
        }
        content = { kind: "reference" }; material = { materialId: retained?.materialId ?? materialId, revision: retained ? retained.revision + 1 : 1, content: tableContent };
      }
      const value: CaseEvidence = { id, sourceUrl: url, title: title.trim() || null, content, publicationDate: existing?.publicationDate ?? { status: "unknown", reason: "No publication date supplied. Capture time is not publication time." }, provenance };
      setBusy(true); await onSave({ kind: "evidence", value, assets }, material); onClose();
    } catch (error) { setError(error instanceof Error ? error.message : "The evidence could not be saved."); }
    finally { submitting.current = false; setBusy(false); }
  }
  return <PaperDialog title={existing ? "Record a source correction" : "Keep the exact thing"} description={existing ? "This saves a new source revision. The previous version stays in history, and affected findings need review." : "Add material you supply. ContextTrail records the source and snapshot; it does not fetch, verify, or search this URL."} onClose={onClose} busy={busy} editing>
    <form className="form-stack" onSubmit={submit}>
      {sourceChanged ? <p role="alert" className="error-note">The saved source changed while this form was open. Your draft is kept. Current saved title: {existing?.title ?? "Untitled"}. {existing?.content.kind === "text" ? `Current passage: ${existing.content.text}` : "Review the current retained snapshot before saving another revision."}</p> : null}
      {!existing ? <label className="field">Evidence type<select disabled={busy} value={kind} onChange={event => { const value = event.target.value; if (value === "text" || value === "image" || value === "table") setKind(value); }}><option value="text">A passage</option><option value="image">An image region</option><option value="table">A table cell</option></select></label> : null}
      <label className="field">Source title<input disabled={busy} required maxLength={500} value={title} onChange={event => setTitle(event.target.value)} placeholder="The source, in your own words" /></label>
      <label className="field">Source URL<input disabled={busy} required type="url" maxLength={4096} value={url} onChange={event => setUrl(event.target.value)} placeholder="https://…" /><small>A reference to where this material came from. No automatic retrieval.</small></label>
      {(existing ? existing.content.kind === "text" : kind === "text") ? <><label className="field">Retained passage<textarea disabled={busy} required maxLength={20000} rows={6} value={passage} onChange={event => setPassage(event.target.value)} /><small>Keep the surrounding words. You will select the exact quote when adding a finding.</small></label><label className="field">Passage attribution<select disabled={busy} value={attribution} onChange={event => { const value = event.target.value; if (value === "page_quote" || value === "search_snippet" || value === "classification_context") setAttribution(value); }}><option value="page_quote">Quoted from the source page</option><option value="search_snippet">Search snippet</option><option value="classification_context">Classification context</option></select></label></> : null}
      {kind === "image" && canSupplyMaterial ? <label className="field">Supplied PNG<input disabled={busy} required={!retained} type="file" accept="image/png,.png" onChange={event => setFile(event.target.files?.[0] ?? null)} /><small>Up to 256 KiB, 2048 px per side, 1,048,576 pixels. The server validates the decoded image. This snapshot is stored with the case. {retained ? "Leave empty to carry the supplied image into a new retained revision." : ""}</small></label> : null}
      {kind === "table" && canSupplyMaterial ? <label className="field">Table with column headers<textarea disabled={busy} required rows={6} value={table} onChange={event => setTable(event.target.value)} placeholder={"Year\tReported count\n2024\t18"} /><small>Paste tab-separated values with headers. Up to 1,000 rows and 64 columns; no file or URL is fetched.</small></label> : null}
      {retained ? <p className="fine-print">Saving also retains the supplied snapshot as material revision {retained.revision + 1}, bound to the corrected source. Earlier selections remain flagged until you review them again.</p> : null}
      <label className="checkbox-field"><input disabled={busy} required type="checkbox" checked={rights} onChange={event => setRights(event.target.checked)} />I may supply and retain this material in my local casebook</label>
      {error ? <p role="alert" className="error-note">{error}</p> : null}
      <div className="dialog-actions"><button type="button" className="paper-button" disabled={busy} onClick={onClose}>Cancel</button><button className="paper-button primary" disabled={busy}>{busy ? "Saving…" : existing ? "Save source revision" : "Save evidence"}</button></div>
    </form>
  </PaperDialog>;
}
