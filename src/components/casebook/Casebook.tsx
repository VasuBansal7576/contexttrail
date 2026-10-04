"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CaseEvidence } from "@/lib/cases/model";
import type { ExactAnchor, Finding, Hypothesis, Subquestion } from "@/lib/inquiries/model";
import type { ResearchChange } from "@/lib/research/workflow";
import { getResearchCase, listResearchCases, startResearchCase, updateResearchCase, ResearchClientError, type ResearchCaseList, type ResearchCaseView, type ResearchFindingSupport } from "@/lib/research/client";
import { CasebookShell, ChapterHeading } from "./CasebookShell";
import PaperDialog from "./PaperDialog";
import EvidenceEditor, { newId, type SaveEvidence } from "./EvidenceEditor";
import { ClaimReportView } from "./ClaimReportView";
import { ResearchAccount } from './ResearchAccount';
import { SavedInvestigationCoverage } from './SavedInvestigationCoverage';
import { ComparisonResult } from "./VideoCompare";
import EvidenceDetail, { currentMaterial, MaterialView } from "./EvidenceDetail";
import { EvidenceCollection, EvidencePassage, SourceActions } from "./EvidenceCollection";
import { AutomaticResult } from './AutomaticResearch';
import {useChapterTour} from './ChapterTour';
import { savedVideoView } from '@/lib/research/saved-video';
import HistoricalEvidence, { originalEvidence, originalEvidenceStatus, type OriginalEvidence } from './HistoricalEvidence';
import FindingEditor from "./FindingEditor";
import Watchlists from "./Watchlists";
import { SourceMap } from "./SourceMap";
import { EvidenceWorkbench } from "./EvidenceWorkbench";
import { SourceLinkedAnswer } from "./SourceLinkedAnswer";

type Editor = { kind: "historical_viewer"; support: ResearchFindingSupport; original: Extract<OriginalEvidence, { kind: "available" }> } | { kind: "subquestion"; existing?: Subquestion } | { kind: "hypothesis"; existing?: Hypothesis } | { kind: "evidence"; existing?: CaseEvidence } | { kind: "viewer"; evidence: CaseEvidence; support?: ResearchFindingSupport } | { kind: "finding"; evidence: CaseEvidence; existing?: Finding; initialAnchor?: ExactAnchor } | { kind: "citation" };
type LoadState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; listing: ResearchCaseList; view: ResearchCaseView | null };
const chapters = ["questions", "evidence", "sources", "changes", "watch", "answers", "video", "audio"];
function message(error: unknown) { return error instanceof Error ? error.message : "The local casebook could not be read. Try opening it again."; }
function displayDate(value: string) { return new Date(value).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function sourceName(evidence: CaseEvidence) { return evidence.title ?? new URL(evidence.sourceUrl).hostname; }

export default function Casebook() {
  const params = useSearchParams(), router = useRouter();
  const caseId = params.get("case"), requested = params.get("chapter") ?? "questions", chapter = chapters.includes(requested) ? requested : "questions";
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [version, setVersion] = useState(0), [newOpen, setNewOpen] = useState(false);
  const creation = useRef<{ operationId: string; question: string; createdAt: string } | null>(null);
  const openNew = () => { creation.current = null; setNewOpen(true); };
  useEffect(() => {
    const controller = new AbortController(); setState({ kind: "loading" });
    Promise.all([listResearchCases({ signal: controller.signal }), caseId ? getResearchCase(caseId, { signal: controller.signal }) : Promise.resolve(null)]).then(([listing, view]) => { if (!controller.signal.aborted) setState({ kind: "ready", listing, view }); }).catch(error => { if (!controller.signal.aborted) setState({ kind: "error", message: message(error) }); });
    return () => controller.abort();
  }, [caseId, version]);
  if (chapter === "watch") return <Watchlists caseId={caseId ?? undefined} />;
  return <CasebookShell chapter={chapter} caseId={caseId ?? undefined} mediaCase={state.kind === "ready" && Boolean(state.view?.videoReport)} dark={chapter === "sources" || chapter === "watch"}>
    <main id="main" tabIndex={-1} className="casebook-main">
      {state.kind === "ready" && state.listing.warnings.length > 0 && <section className="error-note" role="alert"><h2>Some saved cases need recovery</h2><p>Readable cases are still available. The original files have not been changed.</p><details><summary>Inspect recovery details</summary><ul>{state.listing.warnings.map(warning => <li key={warning.file}>{warning.file}: {warning.message}</li>)}</ul></details></section>}
      {state.kind === "loading" ? <p role="status" className="eyebrow">Opening your casebook…</p> : state.kind === "error" ? <><ChapterHeading number="00" label="Your casebook" description="Saved questions are held by the explicitly enabled local research service.">Keep a place<br /><em>for the question.</em></ChapterHeading><p className="error-note" role="alert">{state.message}</p><p className="fine-print">Local research storage must be enabled and accessed through the loopback server. This page does not substitute browser-only demo saves.</p><div className="button-row"><button className="paper-button" onClick={() => setVersion(value => value + 1)}>Try opening again</button><Link className="text-link" href="/casebook">Open saved cases</Link><Link className="text-link" href="/investigate">Go to image investigation</Link></div></> : state.view ? chapter === "video" || chapter === "audio" ? state.view.videoReport ? <><p className={state.view.videoReportStatus === 'stale' ? 'error-note' : 'fine-print'}>{state.view.videoReportStatus === 'stale' ? 'Historical media report. Current evidence has changed; inspect the retained report before using its assessments.' : 'Saved media investigation. Reopening makes no provider requests.'}</p><AutomaticResult result={savedVideoView(state.view.videoReport)} saved /></> : <><ChapterHeading number="02" label="Video" description="This investigation has no supplied recording. Start from a video to investigate its visual and spoken context.">A recording.<br /><em>A trail to follow.</em></ChapterHeading><Link href="/video" className="paper-button primary">Investigate a video</Link></> : chapter === "answers" ? <SourceLinkedAnswer key={state.view.caseId} view={state.view} /> : <CaseWorkspace key={state.view.caseId} initialView={state.view} chapter={chapter} onReload={() => setVersion(value => value + 1)} /> : <>
        <div className="casebook-titlebar"><ChapterHeading number="00" label="Your saved cases" description="A question can stay open. Keep its sources, alternatives, and the details worth returning to.">The<br /><em>casebook.</em></ChapterHeading><div className="button-row"><Link className="paper-button primary" href="/questions">Investigate a question</Link><button className="text-link" onClick={openNew}>Create a manual case</button></div></div>
        {state.listing.cases.length ? <div className="case-list">{[...state.listing.cases].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.caseId.localeCompare(b.caseId)).map((item, index) => <Link className="case-row" key={item.caseId} href={`/casebook?case=${encodeURIComponent(item.caseId)}&chapter=${chapter}`}><span className="large-number case-index">{String(index + 1).padStart(2, "0")}</span><div><h2>{item.question}</h2><p className="eyebrow">Saved research / open to revision</p></div><span className="row-meta">Revision {item.revision}<br />{displayDate(item.createdAt)}</span></Link>)}</div> : <div className="empty-state"><h2>What are you trying to understand?</h2><p>Bring a question and let ContextTrail find sources. Your retained evidence and later corrections will stay here.</p><div className="button-row"><Link className="text-link" href="/questions">Investigate your first question</Link><Link className="text-link" href="/investigate">Trace an image instead</Link></div></div>}
        <p className="fine-print">Your investigations are stored locally. Open a saved result to read its sources or record a correction.</p>
      </>}
    </main>
    {newOpen ? <TextEditor title="What question are you following?" label="Research question" description="Start with something you want to understand. This creates a saved case in your local research service." onClose={() => { setNewOpen(false); if (creation.current !== null) setVersion(value => value + 1); }} onSave={async question => { if (creation.current && creation.current.question !== question) throw new Error("The prior creation has an uncertain outcome. Keep the same question to retry safely, or close this form and inspect the casebook before starting another.");
        const request = creation.current ?? { operationId: newId("start"), question, createdAt: new Date().toISOString() }; creation.current = request;
        let view: ResearchCaseView;
        try { view = await startResearchCase(request); }
        catch (error) { if (error instanceof ResearchClientError && error.status >= 400 && error.status < 500) creation.current = null; throw error; }
        setNewOpen(false); router.push(`/casebook?case=${encodeURIComponent(view.caseId)}&chapter=questions`); }} /> : null}
  </CasebookShell>;
}

function CaseWorkspace({ initialView, chapter, onReload }: { initialView: ResearchCaseView; chapter: string; onReload: () => void }) {
  const [view, setView] = useState(initialView), [editor, setEditor] = useState<Editor | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [questionId, setQuestionId] = useState(initialView.questionId), [hypothesisId, setHypothesisId] = useState<string | null>(null);
  const saving = useRef(false), mounted = useRef(true), latest = useRef(view);
  const pendingIntakeSource = useRef<string | null>(null);
  const pending = useRef<{ caseId: string; operationId: string; expectedRevision: number; change: ResearchChange; payload: string } | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { latest.current = view; }, [view]);
  useEffect(() => { setEditor(null); setNotice(null); }, [chapter]);
  const update = useCallback(async (change: ResearchChange) => {
    if (saving.current) throw new Error("A save is already in progress. Wait for its result before saving another edit.");
    const payload = canonical(change);
    if (pending.current && pending.current.payload !== payload) throw new Error("The prior save has an uncertain outcome. Keep its original draft to retry the same operation, or inspect the saved case before making a different edit.");
    const current = latest.current;
    const request = pending.current ?? { caseId: current.caseId, operationId: newId("edit"), expectedRevision: current.revision, change, payload };
    pending.current = request; saving.current = true;
    const accept = (next: ResearchCaseView) => { latest.current = next; if (mounted.current) setView(next); };
    try {
      const next = await updateResearchCase({ caseId: request.caseId, operationId: request.operationId, expectedRevision: request.expectedRevision, change: request.change });
      pending.current = null; accept(next); if (mounted.current) setNotice(`Saved locally · revision ${next.revision}`); return next;
    } catch (error) {
      let refreshed: ResearchCaseView | null = null;
      try { refreshed = await getResearchCase(request.caseId); accept(refreshed); } catch { /* Outcome stays uncertain; preserve the operation and draft. */ }
      if (refreshed?.changes.some(operation => operation.operationId === request.operationId)) {
        pending.current = null; if (mounted.current) setNotice(`Save confirmed after reopening · revision ${refreshed.revision}`); return refreshed;
      }
      const rejected = error instanceof ResearchClientError && error.status >= 400 && error.status < 500;
      if (rejected) pending.current = null;
      throw new Error(`${message(error)} ${rejected ? "Your draft is still here." + (refreshed ? " The latest saved revision is loaded; review the draft before saving again." : " The saved case could not be refreshed.") : "The save outcome is uncertain. Your draft and operation ID are kept; retry the same draft to avoid a duplicate save."}`);
    } finally { saving.current = false; }
  }, []);
  const saveEvidence: SaveEvidence = async (change, material) => {
    if (pending.current?.change.kind === "material" && pending.current.change.value.kind === "retain") {
      const waiting = pending.current.change.value.material;
      if (canonical(change) !== pendingIntakeSource.current || change.kind !== "evidence" || !material || waiting.evidenceId !== change.value.id || waiting.materialId !== material.materialId || JSON.stringify(waiting.content) !== JSON.stringify(material.content)) throw new Error("A snapshot save is still unconfirmed. Keep the same supplied snapshot to retry its operation before making a different edit.");
      await update(pending.current.change); pendingIntakeSource.current = null; return;
    }
    const saved = await update(change);
    if (!material || change.kind !== "evidence") return;
    const savedEvidence = saved.caseRecord.evidence.find(item => item.id === change.value.id);
    if (canonical(savedEvidence) !== canonical(change.value) || change.assets.some(asset => canonical(saved.caseRecord.assets.find(item => item.id === asset.id)) !== canonical(asset))) throw new Error("The source changed after your evidence save. The supplied snapshot was not attached to that newer source. Your draft is kept; review the current source before saving again.");
    const source = saved.anchorSources.find(source => source.evidenceId === change.value.id);
    if (!source) throw new Error("The source was saved, but its snapshot binding was not returned. Reopen the case before continuing.");
    pendingIntakeSource.current = canonical(change);
    try { await update({ kind: "material", value: { kind: "retain", material: { ...material, evidenceId: change.value.id, evidenceDigest: source.evidenceDigest, capturedAt: change.value.provenance.capturedAt ?? new Date().toISOString(), rights: "user_provided" } } }); pendingIntakeSource.current = null; }
    catch (error) { throw new Error(`The source reference was saved. Its supplied snapshot save could not be confirmed: ${message(error)}`); }
  };
  const findingAnchor = editor?.kind === "finding" ? editor.existing?.support[0]?.anchor : undefined;
  const findingMaterialId = findingAnchor?.kind === "image_region" || findingAnchor?.kind === "table_cell" ? findingAnchor.materialId : undefined;
  const selectedQuestion = view.subquestions.find(question => question.id === questionId)?.question ?? view.question;
  const hypotheses = view.hypotheses.filter(hypothesis => hypothesis.questionId === questionId);
  const selectedHypothesis = hypotheses.find(hypothesis => hypothesis.id === hypothesisId);
  const findings = view.findingViews.filter(item => item.finding.questionId === questionId);
  const titles: Record<string, { number: string; label: string; line: string; emphasis: string; description: string }> = {
    questions: { number: "03", label: "Open-ended research", line: "Leave room", emphasis: "for another explanation.", description: "Follow a question without forcing it into a verdict. Keep alternatives beside the evidence." },
    evidence: { number: "04", label: "The saved case", line: "Keep the", emphasis: "exact thing.", description: "A source is useful. The passage, region, or cell behind your reasoning makes it reviewable." },
    sources: { number: "05", label: "Source relationships", line: `${view.dependencies.sources.length} pages.`, emphasis: "How many origins?", description: "Trace who cites whom before counting repetition as corroboration." },
    changes: { number: "06", label: "Corrections & change", line: "The story changes.", emphasis: "Keep both versions.", description: "A correction belongs in the history. See what changed, when you observed it, and which conclusions need another look." },
  };
  const heading = titles[chapter] ?? titles.questions;
  function inspect(evidence: CaseEvidence, support?: ResearchFindingSupport) { setEditor({ kind: "viewer", evidence, support }); }
  const savedReports = <>
      {view.claimReport && view.claimReportCase ? <section aria-label="Saved grounded report"><details className="saved-research-account" open={chapter === "questions"}><summary>Read the source-linked research account</summary>
        {view.reportStatus === "stale" ? <><p className="error-note" role="status">Needs review: evidence, retained material, the claim, or report presentation rules have changed since this report was saved. The original report is preserved as a historical record; review it before using its assessments.</p><details className="saved-original-report"><summary>Inspect the original report and its original evidence</summary><ClaimReportView report={view.claimReport} caseRecord={view.claimReportCase} /></details></> : <><ResearchAccount report={view.claimReport} caseRecord={view.claimReportCase} /><details className="research-method"><summary>Compare every source and inspect the assessment method</summary><ClaimReportView report={view.claimReport} caseRecord={view.claimReportCase} /></details></>}
        <details className="research-method"><summary>Coverage and dates of the saved investigation</summary><SavedInvestigationCoverage snapshot={view.claimReportCaseOrigin === 'retained_snapshot' ? view.claimReportCase : null} historical={view.reportStatus === 'stale'} /></details>
      </details></section> : null}
      {view.videoReport ? <section aria-label={view.videoReport.result.kind === 'audio' ? 'Saved audio report' : 'Saved video report'}>
        <p className={view.videoReportStatus === "stale" ? "error-note" : "fine-print"} role="status">{view.videoReportStatus === "stale" ? "Needs review: sources or retained materials have changed. This original media report is preserved with its original evidence and has not been reassessed." : "Saved media report and exact evidence. Reopening makes no retrieval or model requests."}</p>
        <p className="fine-print">Original recordings and sampled image bytes were not retained. {view.videoReport.result.transcript ? 'The saved recognition and any speech-source trail are preserved below. Recognition remains unreviewed; visual searches concern only the displayed samples.' : 'This earlier report searched sampled frames only; audio was not investigated.'}</p>
        <details open={view.videoReportStatus === "current"}><summary>Inspect the original media report</summary><AutomaticResult result={savedVideoView(view.videoReport)} saved /></details>
        <details><summary>Inspect the complete retained report JSON</summary><pre style={{whiteSpace:"pre-wrap", overflowWrap:"anywhere"}}>{JSON.stringify(view.videoReport.result, null, 2)}</pre></details>
      </section> : null}
  </>;
  const sidebar = <>
<ChapterHeading number={heading.number} label={heading.label} description={heading.description}>{heading.line}<br /><em>{heading.emphasis}</em></ChapterHeading><div className="case-title-note"><p className="eyebrow">The question we’re following</p><h2>{view.question}</h2><p className="eyebrow">Local case / revision {view.revision}</p></div><Link className="text-link" href="/casebook">Back to all cases</Link><button className="text-link" style={{marginLeft:20}} onClick={onReload}>Reopen case</button>
      {chapter === "questions" ? <div className="question-list"><p className="eyebrow">Questions in this case</p><button aria-pressed={questionId === view.questionId} onClick={() => { setQuestionId(view.questionId); setHypothesisId(null); }}>{view.question}</button>{view.subquestions.map(question => <button key={question.id} aria-pressed={questionId === question.id} onClick={() => { setQuestionId(question.id); setHypothesisId(null); }}>{question.question}</button>)}<button className="text-link" onClick={() => setEditor({ kind: "subquestion" })}>Add a subquestion</button></div> : null}

  </>;
  return <>
    <div className="workspace-grid">    {chapter === "evidence" ? <div className="evidence-workspace">{view.comparison ? <ComparisonResult result={view.comparison} saved /> : null}<EvidenceWorkbench sidebar={sidebar} view={view} onInspect={inspect} onFinding={(evidence, initialAnchor) => setEditor({ kind: "finding", evidence, initialAnchor })} onAdd={() => setEditor({ kind: "evidence" })} /><details className="research-method"><summary>Original investigation and assessment history</summary>{savedReports}</details></div> : <><aside className="workspace-side">{sidebar}</aside><div>
      {notice ? <p role="status" className="success-note">{notice}</p> : null}
      {chapter === "questions" ? savedReports : null}
      {chapter === "questions" ? <details className="research-method" open={!view.claimReport && !view.videoReport}><summary>Record your own explanations and findings</summary><div className="sheet-topline"><p className="eyebrow">Possible explanations / your working hypotheses</p><button className="text-link" onClick={() => setEditor({ kind: "hypothesis" })}>Add explanation</button></div>{hypotheses.length ? <div className="hypothesis-list">{hypotheses.map((hypothesis, index) => <button key={hypothesis.id} className="hypothesis-card" aria-pressed={hypothesis.id === hypothesisId} onClick={() => setHypothesisId(hypothesis.id)}><span className="letter">{String.fromCharCode(65 + index % 26)}</span><h3>{hypothesis.explanation}</h3><span className="eyebrow">Working hypothesis / unassessed</span></button>)}</div> : <div className="empty-state"><h2>What else could explain it?</h2><p>Record a possible explanation. The casebook does not automatically rank or verify hypotheses.</p></div>}
        <section className="paper-sheet"><div className="sheet-topline"><span className="eyebrow">{selectedHypothesis ? "Selected explanation / unassessed" : "Findings for this question"}</span>{selectedHypothesis ? <button className="text-link" onClick={() => setEditor({ kind: "hypothesis", existing: selectedHypothesis })}>Edit explanation</button> : questionId !== view.questionId ? <button className="text-link" onClick={() => setEditor({ kind: "subquestion", existing: view.subquestions.find(question => question.id === questionId) })}>Edit question</button> : null}</div><h2>{selectedHypothesis?.explanation ?? selectedQuestion}</h2>{selectedHypothesis ? <p className="fine-print">Findings below belong to the question. The current contract does not bind them to this individual hypothesis.</p> : null}
          {findings.length ? findings.map(item => <div className="finding-row" key={item.finding.id}><span className="state-label">{item.reviewStatus === "needs_review" ? "Needs review" : "Reviewed source binding"}</span><h3>{item.finding.text}</h3><p className="muted">{item.finding.assessment.kind === "operator_inference" ? "Reviewer inference" : "Source statement"} · {item.finding.assessment.reviewer}</p><p>{item.finding.assessment.rationale}</p>{item.support.map((support, index) => <div key={index}><p className="eyebrow" style={{marginTop:12}}>{support.relationship} / {support.status}</p>{support.evidence ? <button className="text-link" onClick={() => { if (support.evidence) inspect(support.evidence, support); }}>Read the exact evidence</button> : <p className="error-note">Current source is unavailable. The finding remains in history.</p>}{support.status !== "current" ? <><p className="fine-print">{originalEvidenceStatus(view, support)}</p>{(() => { const original = originalEvidence(view, support); return original.kind === "available" ? <button className="text-link" onClick={() => setEditor({ kind: "historical_viewer", support, original })}>Inspect original evidence</button> : <p className="fine-print">{original.reason}</p>; })()}</> : null}</div>)}{item.reviewStatus === "needs_review" && item.support.length === 1 && item.support[0]?.evidence ? <button className="text-link" onClick={() => { const evidence = item.support[0]?.evidence; if (evidence) setEditor({ kind: "finding", evidence, existing: item.finding }); }}>Review this finding again</button> : null}{item.reviewStatus === "needs_review" && item.support.length > 1 ? <p className="fine-print">This finding has multiple supports. Review each through the local research workflow; the single-source editor cannot revise it.</p> : null}</div>) : <p className="fine-print">No findings yet. Add supplied evidence, then pin an exact selection and record what it supports, challenges, or adds as context.</p>}
          <div className="button-row"><Link className="paper-button primary" href={`/casebook?case=${encodeURIComponent(view.caseId)}&chapter=evidence`}>Work with the evidence</Link></div>
        </section></details> : null}
      {chapter === "sources" ? <Sources view={view} onCitation={() => setEditor({ kind: "citation" })} onInspect={inspect} /> : null}
      {chapter === "changes" ? <Changes view={view} /> : null}
      {chapter === "changes" ? <details className="research-method"><summary>Original investigation and assessment history</summary>{savedReports}</details> : null}
    </div></>}</div>
    {editor?.kind === "subquestion" || editor?.kind === "hypothesis" ? <TextEditor title={editor.kind === "subquestion" ? "Follow a smaller question" : "Keep another explanation"} label={editor.kind === "subquestion" ? "Subquestion" : "Possible explanation"} initial={editor.kind === "subquestion" ? editor.existing?.question : editor.existing?.explanation} description="Your wording is saved as a working research note. No automatic assessment is made." onClose={() => setEditor(null)} onSave={async (text, draftId) => { if (editor.kind === "subquestion") await update({ kind: "subquestion", value: { kind: "subquestion", id: editor.existing?.id ?? draftId, question: text } }); else await update({ kind: "hypothesis", value: { kind: "hypothesis", id: editor.existing?.id ?? draftId, questionId, explanation: text } }); setEditor(null); }} /> : null}
    {editor?.kind === "evidence" ? <EvidenceEditor existing={editor.existing ? view.caseRecord.evidence.find(item => item.id === editor.existing?.id) ?? editor.existing : undefined} existingAsset={editor.existing?.content.kind === "media" ? view.caseRecord.assets.find(asset => editor.existing?.content.kind === "media" && asset.id === editor.existing.content.assetId) : undefined} retained={editor.existing ? [...view.materials.versions].reverse().find(material => material.evidenceId === editor.existing?.id) : undefined} onClose={() => setEditor(null)} onSave={saveEvidence} /> : null}
    {editor?.kind === "historical_viewer" ? <HistoricalEvidence view={view} support={editor.support} original={editor.original} onClose={() => setEditor(null)} /> : null}
    {editor?.kind === "viewer" ? <EvidenceDetail view={view} evidence={editor.evidence} support={editor.support} onClose={() => setEditor(null)} onFinding={() => setEditor({ kind: "finding", evidence: editor.evidence })} onCorrect={() => setEditor({ kind: "evidence", existing: editor.evidence })} /> : null}
    {editor?.kind === "finding" ? <FindingEditor evidence={view.caseRecord.evidence.find(item => item.id === editor.evidence.id) ?? editor.evidence} material={currentMaterial(view, editor.evidence.id, findingMaterialId)} questionId={editor.existing?.questionId ?? questionId} existing={editor.existing} initialAnchor={editor.initialAnchor} onClose={() => setEditor(null)} onSave={async finding => { await update({ kind: "finding", value: finding }); }} /> : null}
    {editor?.kind === "citation" ? <CitationEditor view={view} onClose={() => setEditor(null)} onSave={update} /> : null}
  </>;
}

function TextEditor({ title, label, description, initial = "", onClose, onSave }: { title: string; label: string; description: string; initial?: string; onClose: () => void; onSave: (text: string, draftId: string) => Promise<void> }) {
  const [draftId] = useState(() => newId("draft"));
  const [text, setText] = useState(initial), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  return <PaperDialog title={title} description={description} onClose={onClose} busy={busy} editing><form className="form-stack" onSubmit={async event => { event.preventDefault(); if (busy || !text.trim()) return; setBusy(true); setError(null); try { await onSave(text.trim(), draftId); } catch (error) { setError(message(error)); } finally { setBusy(false); } }}><label className="field">{label}<textarea disabled={busy} required autoFocus maxLength={20000} value={text} onChange={event => setText(event.target.value)} /></label>{error ? <p role="alert" className="error-note">{error}</p> : null}<div className="dialog-actions"><button type="button" className="paper-button" disabled={busy} onClick={onClose}>Cancel</button><button className="paper-button primary" disabled={busy || !text.trim()}>{busy ? "Saving…" : "Save"}</button></div></form></PaperDialog>;
}

function Sources({ view, onCitation, onInspect }: { view: ResearchCaseView; onCitation: () => void; onInspect: (evidence: CaseEvidence) => void }) {
  return <SourceMap view={view} onCitation={onCitation} onInspect={onInspect} />;
}

function CitationEditor({ view, onClose, onSave }: { view: ResearchCaseView; onClose: () => void; onSave: (change: ResearchChange) => Promise<ResearchCaseView> }) {
  const [citationId] = useState(() => newId("citation"));
  const [from, setFrom] = useState(view.caseRecord.evidence[0]?.id ?? ""), [target, setTarget] = useState(""), [quote, setQuote] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  return <PaperDialog title="Record a supplied citation" description="Describe a link you observed. URL matches and exact quoted wording are checked only against retained evidence; source independence remains unknown." onClose={onClose} busy={busy} editing><form className="form-stack" onSubmit={async event => { event.preventDefault(); if (busy) return; setBusy(true); setError(null); try { await onSave({ kind: "citation", value: { id: citationId, fromEvidenceId: from, targetUrl: target, targetRole: "unspecified", claimId: null, quote: quote.trim() ? { text: quote, start: null } : null } }); onClose(); } catch (error) { setError(message(error)); } finally { setBusy(false); } }}><label className="field">Citing source<select disabled={busy} value={from} onChange={event => setFrom(event.target.value)}>{view.caseRecord.evidence.map(item => <option key={item.id} value={item.id}>{sourceName(item)}</option>)}</select></label><label className="field">Citation target URL<input disabled={busy} required type="url" value={target} onChange={event => setTarget(event.target.value)} /></label><label className="field">Quoted text to check in the target, optional<textarea disabled={busy} value={quote} onChange={event => setQuote(event.target.value)} /><small>An exact match is a text comparison, not a truth verdict.</small></label>{error ? <p role="alert" className="error-note">{error}</p> : null}<div className="dialog-actions"><button type="button" className="paper-button" disabled={busy} onClick={onClose}>Cancel</button><button className="paper-button primary" disabled={busy || !from}>{busy ? "Saving…" : "Save citation"}</button></div></form></PaperDialog>;
}

export function Changes({ view }: { view: ResearchCaseView }) {
  const revisions = [...view.caseHistory.filter(record => record.id === view.caseId), view.caseRecord].sort((a,b) => a.revision-b.revision);
  const [selected,setSelected] = useState(revisions.length-1), [sourceId,setSourceId] = useState('');
  useChapterTour(step=>{setSelected(Math.min(step,revisions.length-1));setSourceId('');});
  const after = revisions[Math.min(selected,revisions.length-1)], before = selected > 0 ? revisions[selected-1] : null;
  const ids = [...new Set([...(before?.evidence ?? []).map(item => item.id), ...after.evidence.map(item => item.id)])];
  const changed = ids.filter(id => JSON.stringify(before?.evidence.find(item => item.id === id)) !== JSON.stringify(after.evidence.find(item => item.id === id)));
  const chosen = changed.includes(sourceId) ? sourceId : changed[0];
  const oldEvidence = before?.evidence.find(item => item.id === chosen), nextEvidence = after.evidence.find(item => item.id === chosen);
  const [materialMode,setMaterialMode] = useState(view.materials.versions.length > 1);
  const stale = view.findingViews.filter(item => item.reviewStatus === 'needs_review');
  if (materialMode) return <><div className="button-row revision-modes"><button className="paper-button" onClick={()=>setMaterialMode(false)}>Source records</button><button className="paper-button primary" aria-pressed>Retained material versions</button></div><MaterialChanges view={view} /></>;
  return <section className="revision-workspace" aria-label="Retained source comparison">
    {view.materials.versions.length ? <div className="button-row revision-modes"><button className="paper-button primary" aria-pressed>Source records</button><button className="paper-button" onClick={()=>setMaterialMode(true)}>Retained material versions</button></div> : null}
    <div className="sheet-topline"><span className="eyebrow">{before ? `${changed.length} changed record${changed.length===1?'':'s'}` : `${after.evidence.length} records in the starting snapshot`}</span><span className="state-label">{stale.length} {stale.length===1?'finding needs':'findings need'} review</span></div>
    {!before ? <p className="fine-print">This is the first retained snapshot. No later source correction is recorded.</p> : null}
    <div className={`revision-pair${before ? '' : ' single-snapshot'}`}>{(before ? [{label:`Snapshot ${before.revision} / before`,evidence:oldEvidence,record:before},{label:`Snapshot ${after.revision} / after`,evidence:nextEvidence,record:after}] : [{label:`Snapshot ${after.revision} / first retained version`,evidence:nextEvidence,record:after}]).map((side,index) => <article className="revision-paper" key={index}><p className="eyebrow">{side.label}</p><h3>{side.evidence ? sourceName(side.evidence) : 'No earlier retained record.'}</h3><div className="revision-passage">{side.evidence?.content.kind === 'text' ? <EvidencePassage text={side.evidence.content.text} /> : <p>{side.evidence ? 'A source reference. Choose Retained material versions to compare the saved images or table cells; source and material revision numbers are separate.' : 'The history begins with the first snapshot. An absent earlier record is not a contradiction.'}</p>}</div>{side.evidence ? <p className="fine-print">Publication: {side.evidence.publicationDate.status === 'observed' || side.evidence.publicationDate.status === 'inferred' ? `${side.evidence.publicationDate.observation.value} (${side.evidence.publicationDate.status})` : side.evidence.publicationDate.status}. Captured: {side.evidence.provenance.capturedAt ?? 'Not recorded'}. Retrieved: {side.evidence.provenance.retrievedAt ?? 'Not recorded'}.</p> : null}</article>)}</div>
    <div className="change-list" aria-label="Source revisions">{revisions.map((record,index) => <button key={record.revision} aria-pressed={selected === index} onClick={() => {setSelected(index);setSourceId('');}}><b>Snapshot {record.revision}</b>{record.evidence.length} retained records</button>)}</div>
    {changed.length > 1 ? <label className="field revision-source-choice">{before ? 'Inspect another changed record' : 'Inspect another retained record'}<select value={chosen} onChange={event => setSourceId(event.target.value)}>{changed.map(id => <option key={id} value={id}>{after.evidence.find(item => item.id === id)?.title ?? before?.evidence.find(item => item.id === id)?.title ?? id}</option>)}</select></label> : null}
    <details className="research-method"><summary>Research revision history</summary>{[...view.history].reverse().map(item => <div className="finding-row" key={item.revision}><p className="eyebrow">Workspace revision {item.revision}</p><p>{item.subquestions.length} subquestions · {item.hypotheses.length} hypotheses · {item.findings.length} findings</p></div>)}</details><p className="fine-print">Publication, retrieval and capture times stay separate. Retaining a correction keeps the earlier wording in the history.</p>
  </section>;
}


function MaterialChanges({view}: {view:ResearchCaseView}) {
  const ids=[...new Set(view.materials.versions.map(item=>item.materialId))];
  const [chosen,setChosen]=useState(ids.find(id=>view.materials.versions.filter(item=>item.materialId===id).length>1) ?? ids[0] ?? ''), [selected,setSelected]=useState<number|null>(null);
  const versions=view.materials.versions.filter(item=>item.materialId===chosen).sort((a,b)=>a.revision-b.revision);
  useChapterTour(step=>setSelected(Math.min(step,versions.length-1)));
  const index=Math.min(selected ?? versions.length-1,versions.length-1), after=versions[index], before=index>0?versions[index-1]:null;
  const staleCount=view.findingViews.filter(item=>item.reviewStatus==='needs_review').length;
  return <section className="revision-workspace" aria-label="Retained material comparison"><div className="sheet-topline"><p className="eyebrow">Exact retained material versions</p><span className="state-label">{staleCount} {staleCount===1?'finding needs':'findings need'} review</span></div><p className="fine-print">These are the retained image or table snapshots. Their revision numbers are separate from source records. Changes do not silently renew a finding’s review.</p>
    {ids.length>1 ? <label className="field">Retained material<select value={chosen} onChange={event=>{setChosen(event.target.value);setSelected(null);}}>{ids.map(id=><option key={id}>{id}</option>)}</select></label> : null}
    <div className="revision-pair">{[{label:'Before',material:before},{label:'After',material:after}].map((side,index)=><article className="revision-paper" key={index}><p className="eyebrow">{side.label} / material revision {side.material?.revision ?? 'unavailable'}</p><div className="revision-passage">{side.material ? <MaterialView material={side.material} /> : <p>No earlier retained material. This is the start of this snapshot history.</p>}</div>{side.material ? <p className="fine-print">Retained snapshot captured: {side.material.capturedAt}.<br />Material digest: {side.material.digest}</p> : null}</article>)}</div>
    <div className="change-list" aria-label="Material revisions">{versions.map((material,index)=><button key={material.digest} aria-pressed={index===(selected ?? versions.length-1)} onClick={()=>setSelected(index)}><b>Material {material.revision}</b>{material.content.kind==='table'?'Retained table':'Retained image'}</button>)}</div>
  </section>;
}
