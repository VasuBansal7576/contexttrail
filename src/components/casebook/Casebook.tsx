"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CaseEvidence } from "@/lib/cases/model";
import type { Finding, Hypothesis, Subquestion } from "@/lib/inquiries/model";
import type { ResearchChange } from "@/lib/research/workflow";
import { getResearchCase, listResearchCases, startResearchCase, updateResearchCase, ResearchClientError, type ResearchCaseSummary, type ResearchCaseView, type ResearchFindingSupport } from "@/lib/research/client";
import { CasebookShell, ChapterHeading } from "./CasebookShell";
import PaperDialog from "./PaperDialog";
import EvidenceEditor, { newId, type SaveEvidence } from "./EvidenceEditor";
import EvidenceDetail, { currentMaterial } from "./EvidenceDetail";
import FindingEditor from "./FindingEditor";

type Editor = { kind: "subquestion"; existing?: Subquestion } | { kind: "hypothesis"; existing?: Hypothesis } | { kind: "evidence"; existing?: CaseEvidence } | { kind: "viewer"; evidence: CaseEvidence; support?: ResearchFindingSupport } | { kind: "finding"; evidence: CaseEvidence; existing?: Finding } | { kind: "citation" };
type LoadState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; cases: ResearchCaseSummary[]; view: ResearchCaseView | null };
const chapters = ["questions", "evidence", "sources", "changes", "watch", "answers"];
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
    Promise.all([listResearchCases({ signal: controller.signal }), caseId ? getResearchCase(caseId, { signal: controller.signal }) : Promise.resolve(null)]).then(([cases, view]) => { if (!controller.signal.aborted) setState({ kind: "ready", cases, view }); }).catch(error => { if (!controller.signal.aborted) setState({ kind: "error", message: message(error) }); });
    return () => controller.abort();
  }, [caseId, version]);
  const planned = chapter === "watch" || chapter === "answers";
  return <CasebookShell chapter={chapter} caseId={caseId ?? undefined} dark={chapter === "sources" || chapter === "watch"}>
    <main id="main" tabIndex={-1} className="casebook-main">
      {planned ? <PlannedChapter chapter={chapter} /> : state.kind === "loading" ? <p role="status" className="eyebrow">Opening your casebook…</p> : state.kind === "error" ? <><ChapterHeading number="00" label="Your casebook" description="Saved questions are held by the explicitly enabled local research service.">Keep a place<br /><em>for the question.</em></ChapterHeading><p className="error-note" role="alert">{state.message}</p><p className="fine-print">Local research storage must be enabled and accessed through the loopback server. This page does not substitute browser-only demo saves.</p><div className="button-row"><button className="paper-button" onClick={() => setVersion(value => value + 1)}>Try opening again</button><Link className="text-link" href="/investigate">Go to image investigation</Link></div></> : state.view ? <CaseWorkspace key={state.view.caseId} initialView={state.view} chapter={chapter} onReload={() => setVersion(value => value + 1)} /> : <>
        <div className="casebook-titlebar"><ChapterHeading number="00" label="Your saved cases" description="A question can stay open. Keep its sources, alternatives, and the details worth returning to.">The<br /><em>casebook.</em></ChapterHeading><button className="paper-button primary" onClick={openNew}>Start a question</button></div>
        {state.cases.length ? <div className="case-list">{[...state.cases].reverse().map((item, index) => <Link className="case-row" key={item.caseId} href={`/casebook?case=${encodeURIComponent(item.caseId)}&chapter=${chapter}`}><span className="large-number">{String(index + 1).padStart(2, "0")}</span><div><h2>{item.question}</h2><p className="eyebrow">Saved research / open to revision</p></div><span className="row-meta">Revision {item.revision}<br />{displayDate(item.createdAt)}</span></Link>)}</div> : <div className="empty-state"><h2>What are you trying to understand?</h2><p>Your first case starts with a question. Add the evidence you have, leave space for other explanations, and keep a record of what changes.</p><div className="button-row"><button className="text-link" onClick={openNew}>Start your first question</button><Link className="text-link" href="/investigate">Trace an image instead</Link></div></div>}
        <p className="fine-print">Stored by the local research service. No account sync, automatic retrieval, or model analysis is performed in this casebook.</p>
      </>}
    </main>
    {newOpen ? <TextEditor title="What question are you following?" label="Research question" description="Start with something you want to understand. This creates a saved case in your local research service." onClose={() => { setNewOpen(false); setVersion(value => value + 1); }} onSave={async question => { if (creation.current && creation.current.question !== question) throw new Error("The prior creation has an uncertain outcome. Keep the same question to retry safely, or close this form and inspect the casebook before starting another.");
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
    sources: { number: "05", label: "Source relationships", line: "Follow the", emphasis: "attribution.", description: "Inspect supplied citations before treating repeated coverage as corroboration." },
    changes: { number: "06", label: "Corrections & change", line: "The story changes.", emphasis: "Keep the record.", description: "Review retained revisions and the findings that need another look." },
  };
  const heading = titles[chapter] ?? titles.questions;
  function inspect(evidence: CaseEvidence, support?: ResearchFindingSupport) { setEditor({ kind: "viewer", evidence, support }); }
  return <>
    <div className="workspace-grid"><aside className="workspace-side"><ChapterHeading number={heading.number} label={heading.label} description={heading.description}>{heading.line}<br /><em>{heading.emphasis}</em></ChapterHeading><div className="case-title-note"><p className="eyebrow">The question we’re following</p><h2>{view.question}</h2><p className="eyebrow">Local case / revision {view.revision}</p></div><Link className="text-link" href="/casebook">Back to all cases</Link><button className="text-link" style={{marginLeft:20}} onClick={onReload}>Reopen case</button>
      {chapter === "questions" ? <div className="question-list"><p className="eyebrow">Questions in this case</p><button aria-pressed={questionId === view.questionId} onClick={() => { setQuestionId(view.questionId); setHypothesisId(null); }}>{view.question}</button>{view.subquestions.map(question => <button key={question.id} aria-pressed={questionId === question.id} onClick={() => { setQuestionId(question.id); setHypothesisId(null); }}>{question.question}</button>)}<button className="text-link" onClick={() => setEditor({ kind: "subquestion" })}>Add a subquestion</button></div> : null}
    </aside><div>
      {notice ? <p role="status" className="success-note">{notice}</p> : null}
      {chapter === "questions" ? <><div className="sheet-topline"><p className="eyebrow">Possible explanations / your working hypotheses</p><button className="text-link" onClick={() => setEditor({ kind: "hypothesis" })}>Add explanation</button></div>{hypotheses.length ? <div className="hypothesis-list">{hypotheses.map((hypothesis, index) => <button key={hypothesis.id} className="hypothesis-card" aria-pressed={hypothesis.id === hypothesisId} onClick={() => setHypothesisId(hypothesis.id)}><span className="letter">{String.fromCharCode(65 + index % 26)}</span><h3>{hypothesis.explanation}</h3><span className="eyebrow">Working hypothesis / unassessed</span></button>)}</div> : <div className="empty-state"><h2>What else could explain it?</h2><p>Record a possible explanation. The casebook does not automatically rank or verify hypotheses.</p></div>}
        <section className="paper-sheet"><div className="sheet-topline"><span className="eyebrow">{selectedHypothesis ? "Selected explanation / unassessed" : "Findings for this question"}</span>{selectedHypothesis ? <button className="text-link" onClick={() => setEditor({ kind: "hypothesis", existing: selectedHypothesis })}>Edit explanation</button> : questionId !== view.questionId ? <button className="text-link" onClick={() => setEditor({ kind: "subquestion", existing: view.subquestions.find(question => question.id === questionId) })}>Edit question</button> : null}</div><h2>{selectedHypothesis?.explanation ?? selectedQuestion}</h2>{selectedHypothesis ? <p className="fine-print">Findings below belong to the question. The current contract does not bind them to this individual hypothesis.</p> : null}
          {findings.length ? findings.map(item => <div className="finding-row" key={item.finding.id}><span className="state-label">{item.reviewStatus === "needs_review" ? "Needs review" : "Reviewed source binding"}</span><h3>{item.finding.text}</h3><p className="muted">{item.finding.assessment.kind === "operator_inference" ? "Reviewer inference" : "Source statement"} · {item.finding.assessment.reviewer}</p><p>{item.finding.assessment.rationale}</p>{item.support.map((support, index) => <div key={index}><p className="eyebrow" style={{marginTop:12}}>{support.relationship} / {support.status}</p>{support.evidence ? <button className="text-link" onClick={() => { if (support.evidence) inspect(support.evidence, support); }}>Read the exact evidence</button> : <p className="error-note">Source evidence is unavailable. The finding remains in history.</p>}</div>)}{item.reviewStatus === "needs_review" && item.support.length === 1 && item.support[0]?.evidence ? <button className="text-link" onClick={() => { const evidence = item.support[0]?.evidence; if (evidence) setEditor({ kind: "finding", evidence, existing: item.finding }); }}>Review this finding again</button> : null}{item.reviewStatus === "needs_review" && item.support.length > 1 ? <p className="fine-print">This finding has multiple supports. Review each through the local research workflow; the single-source editor cannot revise it.</p> : null}</div>) : <p className="fine-print">No findings yet. Add supplied evidence, then pin an exact selection and record what it supports, challenges, or adds as context.</p>}
          <div className="button-row"><Link className="paper-button primary" href={`/casebook?case=${encodeURIComponent(view.caseId)}&chapter=evidence`}>Work with the evidence</Link></div>
        </section></> : null}
      {chapter === "evidence" ? <section className="paper-sheet"><div className="sheet-topline"><span className="eyebrow">{view.caseRecord.evidence.length} source records / {view.findingViews.length} findings</span><button className="text-link" onClick={() => setEditor({ kind: "evidence" })}>Add evidence</button></div>{view.caseRecord.evidence.length ? view.caseRecord.evidence.map(evidence => <button className="evidence-row" key={evidence.id} onClick={() => inspect(evidence)}><span className="eyebrow">{evidence.content.kind === "text" ? evidence.content.attribution.replaceAll("_", " ") : currentMaterial(view, evidence.id)?.content.kind === "table" ? "Retained table" : evidence.content.kind === "media" ? "Media record" : "Source reference"}</span><h3>{sourceName(evidence)}</h3><p>{evidence.content.kind === "text" ? `${evidence.content.text.slice(0, 220)}${evidence.content.text.length > 220 ? "…" : ""}` : "Open the source record and retained material."}</p><p className="source-url muted" style={{marginTop:12}}>{evidence.sourceUrl}</p></button>) : <div className="empty-state"><h2>Bring the source with you.</h2><p>Save a passage, a supplied image snapshot, or a table. Nothing is retrieved or inferred until you explicitly run a supported investigation.</p><div className="button-row"><button className="paper-button primary" onClick={() => setEditor({ kind: "evidence" })}>Add your first evidence</button></div></div>}</section> : null}
      {chapter === "sources" ? <Sources view={view} onCitation={() => setEditor({ kind: "citation" })} onInspect={inspect} /> : null}
      {chapter === "changes" ? <Changes view={view} /> : null}
    </div></div>
    {editor?.kind === "subquestion" || editor?.kind === "hypothesis" ? <TextEditor title={editor.kind === "subquestion" ? "Follow a smaller question" : "Keep another explanation"} label={editor.kind === "subquestion" ? "Subquestion" : "Possible explanation"} initial={editor.kind === "subquestion" ? editor.existing?.question : editor.existing?.explanation} description="Your wording is saved as a working research note. No automatic assessment is made." onClose={() => setEditor(null)} onSave={async (text, draftId) => { if (editor.kind === "subquestion") await update({ kind: "subquestion", value: { kind: "subquestion", id: editor.existing?.id ?? draftId, question: text } }); else await update({ kind: "hypothesis", value: { kind: "hypothesis", id: editor.existing?.id ?? draftId, questionId, explanation: text } }); setEditor(null); }} /> : null}
    {editor?.kind === "evidence" ? <EvidenceEditor existing={editor.existing ? view.caseRecord.evidence.find(item => item.id === editor.existing?.id) ?? editor.existing : undefined} existingAsset={editor.existing?.content.kind === "media" ? view.caseRecord.assets.find(asset => editor.existing?.content.kind === "media" && asset.id === editor.existing.content.assetId) : undefined} retained={editor.existing ? [...view.materials.versions].reverse().find(material => material.evidenceId === editor.existing?.id) : undefined} onClose={() => setEditor(null)} onSave={saveEvidence} /> : null}
    {editor?.kind === "viewer" ? <EvidenceDetail view={view} evidence={editor.evidence} support={editor.support} onClose={() => setEditor(null)} onFinding={() => setEditor({ kind: "finding", evidence: editor.evidence })} onCorrect={() => setEditor({ kind: "evidence", existing: editor.evidence })} /> : null}
    {editor?.kind === "finding" ? <FindingEditor evidence={view.caseRecord.evidence.find(item => item.id === editor.evidence.id) ?? editor.evidence} material={currentMaterial(view, editor.evidence.id, findingMaterialId)} questionId={editor.existing?.questionId ?? questionId} existing={editor.existing} onClose={() => setEditor(null)} onSave={async finding => { await update({ kind: "finding", value: finding }); }} /> : null}
    {editor?.kind === "citation" ? <CitationEditor view={view} onClose={() => setEditor(null)} onSave={update} /> : null}
  </>;
}

function TextEditor({ title, label, description, initial = "", onClose, onSave }: { title: string; label: string; description: string; initial?: string; onClose: () => void; onSave: (text: string, draftId: string) => Promise<void> }) {
  const [draftId] = useState(() => newId("draft"));
  const [text, setText] = useState(initial), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  return <PaperDialog title={title} description={description} onClose={onClose} busy={busy} editing><form className="form-stack" onSubmit={async event => { event.preventDefault(); if (busy || !text.trim()) return; setBusy(true); setError(null); try { await onSave(text.trim(), draftId); } catch (error) { setError(message(error)); } finally { setBusy(false); } }}><label className="field">{label}<textarea disabled={busy} required autoFocus maxLength={20000} value={text} onChange={event => setText(event.target.value)} /></label>{error ? <p role="alert" className="error-note">{error}</p> : null}<div className="dialog-actions"><button type="button" className="paper-button" disabled={busy} onClick={onClose}>Cancel</button><button className="paper-button primary" disabled={busy || !text.trim()}>{busy ? "Saving…" : "Save"}</button></div></form></PaperDialog>;
}

function Sources({ view, onCitation, onInspect }: { view: ResearchCaseView; onCitation: () => void; onInspect: (evidence: CaseEvidence) => void }) {
  return <><div className="sheet-topline"><span className="eyebrow">{view.dependencies.sources.length} retained source URLs / independence unknown</span><button className="text-link" onClick={onCitation} disabled={!view.caseRecord.evidence.length}>Record a citation</button></div><div className="source-stack">{view.dependencies.sources.map((source, index) => <section className="source-card" key={source.id}><p className="eyebrow">Source {String(index + 1).padStart(2, "0")} / retained URL</p><h3>{new URL(source.url).hostname}</h3><p className="source-url">{source.url}</p>{source.evidenceIds.map(id => { const evidence = view.caseRecord.evidence.find(item => item.id === id); return evidence ? <button className="text-link" key={id} onClick={() => onInspect(evidence)}>Inspect {sourceName(evidence)}</button> : null; })}{view.dependencies.citationChecks.filter(check => source.evidenceIds.includes(check.citation.fromEvidenceId)).map(check => <div className="citation-row" key={check.id}><p className="eyebrow">Cites / supplied by reviewer</p><p className="source-url">{check.citation.targetUrl}</p><p>{check.targetEvidenceIds.length ? "Target URL matches retained evidence. The citation itself has not been independently verified in the source document." : "Unresolved target. No retained source matches this URL."}</p>{check.quoteChecks.map(quote => <p key={quote.evidenceId} className="fine-print">Retained quote check: {quote.result.replaceAll("_", " ")}</p>)}</div>)}</section>)}</div>{!view.dependencies.sources.length ? <div className="empty-state"><h2>The chain starts with a source.</h2><p>Add evidence first. Then record its citations to inspect retained targets, shared references, and unresolved links.</p></div> : null}{view.dependencies.sharedCitations.length ? <div className="paper-sheet" style={{marginTop:26}}><h2>Shared citation targets</h2>{view.dependencies.sharedCitations.map(item => <p className="fine-print" key={item.id}>{item.evidenceIds.length} retained evidence records cite {item.targetUrl}. They may share a source; this does not establish dependence for an assertion.</p>)}</div> : null}<p className="fine-print">{view.dependencies.independence.status === "unknown" ? view.dependencies.independence.reason : "Source independence has not been established."}</p><p className="fine-print">Only supplied citations and retained case evidence are inspected. No links are extracted and no network or model calls run here.</p></>;
}

function CitationEditor({ view, onClose, onSave }: { view: ResearchCaseView; onClose: () => void; onSave: (change: ResearchChange) => Promise<ResearchCaseView> }) {
  const [citationId] = useState(() => newId("citation"));
  const [from, setFrom] = useState(view.caseRecord.evidence[0]?.id ?? ""), [target, setTarget] = useState(""), [quote, setQuote] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  return <PaperDialog title="Record a supplied citation" description="Describe a link you observed. URL matches and exact quoted wording are checked only against retained evidence; source independence remains unknown." onClose={onClose} busy={busy} editing><form className="form-stack" onSubmit={async event => { event.preventDefault(); if (busy) return; setBusy(true); setError(null); try { await onSave({ kind: "citation", value: { id: citationId, fromEvidenceId: from, targetUrl: target, targetRole: "unspecified", claimId: null, quote: quote.trim() ? { text: quote, start: null } : null } }); onClose(); } catch (error) { setError(message(error)); } finally { setBusy(false); } }}><label className="field">Citing source<select disabled={busy} value={from} onChange={event => setFrom(event.target.value)}>{view.caseRecord.evidence.map(item => <option key={item.id} value={item.id}>{sourceName(item)}</option>)}</select></label><label className="field">Citation target URL<input disabled={busy} required type="url" value={target} onChange={event => setTarget(event.target.value)} /></label><label className="field">Quoted text to check in the target, optional<textarea disabled={busy} value={quote} onChange={event => setQuote(event.target.value)} /><small>An exact match is a text comparison, not a truth verdict.</small></label>{error ? <p role="alert" className="error-note">{error}</p> : null}<div className="dialog-actions"><button type="button" className="paper-button" disabled={busy} onClick={onClose}>Cancel</button><button className="paper-button primary" disabled={busy || !from}>{busy ? "Saving…" : "Save citation"}</button></div></form></PaperDialog>;
}

function Changes({ view }: { view: ResearchCaseView }) {
  const revisions = [...view.caseHistory.filter(record => record.id === view.caseId), view.caseRecord].sort((a,b) => a.revision - b.revision);
  const [selected, setSelected] = useState(revisions.length - 1);
  const after = revisions[Math.min(selected, revisions.length - 1)], before = selected > 0 ? revisions[selected - 1] : null;
  const ids = [...new Set([...(before?.evidence ?? []).map(item => item.id), ...(after?.evidence ?? []).map(item => item.id)])];
  const changed = ids.filter(id => JSON.stringify(before?.evidence.find(item => item.id === id)) !== JSON.stringify(after?.evidence.find(item => item.id === id)));
  const stale = view.findingViews.filter(item => item.reviewStatus === "needs_review");
  return <><div className="sheet-topline"><span className="eyebrow">{view.history.length} research revisions / {revisions.length} source snapshots</span><span className="state-label">{stale.length} findings need review</span></div>{changed.length ? changed.map(id => { const oldEvidence = before?.evidence.find(item => item.id === id), nextEvidence = after?.evidence.find(item => item.id === id); return <div className="revision-grid" key={id}>{[{ label: before ? `Source snapshot ${before.revision}` : "Before this source was added", evidence: oldEvidence }, { label: `Source snapshot ${after.revision}`, evidence: nextEvidence }].map((side,index) => <section className="paper-sheet" key={index}><p className="eyebrow">{side.label}</p><h3>{side.evidence ? sourceName(side.evidence) : "No retained record"}</h3><pre>{side.evidence?.content.kind === "text" ? side.evidence.content.text : side.evidence ? "Media or source reference. Inspect the Evidence chapter for the current snapshot." : "This evidence was not present in this source revision."}</pre>{side.evidence ? <><p className="fine-print">Captured: {side.evidence.provenance.capturedAt ?? "Not recorded"}</p><p className="fine-print">Publication date: {side.evidence.publicationDate.status === "observed" || side.evidence.publicationDate.status === "inferred" ? `${side.evidence.publicationDate.observation.value} · ${side.evidence.publicationDate.status}` : side.evidence.publicationDate.status}</p></> : null}</section>)}</div>; }) : <div className="paper-sheet"><h2>No source correction in this revision.</h2><p className="fine-print">Questions, hypotheses, and findings have their own research history. No automatic source checking has run.</p></div>}
    <div className="change-list" aria-label="Source revisions">{revisions.map((record,index) => <button key={record.revision} aria-pressed={selected === index} onClick={() => setSelected(index)}>Source snapshot {record.revision} · {record.evidence.length} retained records</button>)}</div><details style={{marginTop:26}}><summary className="text-link">Research revision history</summary>{[...view.history].reverse().map(item => <div className="finding-row" key={item.revision}><p className="eyebrow">Workspace revision {item.revision}</p><p>{item.subquestions.length} subquestions · {item.hypotheses.length} hypotheses · {item.findings.length} findings</p></div>)}</details><p className="fine-print">Capture time records when material was supplied. It is separate from publication time. Reverting content does not silently renew an earlier review.</p></>;
}
function PlannedChapter({ chapter }: { chapter: string }) {
  const watch = chapter === "watch";
  return <div className="workspace-grid"><ChapterHeading number={watch ? "07" : "08"} label={watch ? "Watchlists / planned" : "AI answers / planned"} description={watch ? "Return when the evidence moves. Scheduled checking and notifications are not connected in this application." : "Answers should lead back to the material that supports them. Model-generated research answers are not connected here."}>{watch ? "A question can" : "An answer needs"}<br /><em>{watch ? "stay open." : "somewhere to stand."}</em></ChapterHeading><section className="paper-sheet"><span className="state-label">Planned application connection</span><h2 style={{marginTop:24}}>{watch ? "For now, keep a case worth returning to." : "For now, record a reviewable finding."}</h2><p className="fine-print">{watch ? "Local watchlist and change-detection contracts exist, but this interface does not create schedules, check sources in the background, or send alerts." : "Saved findings are reviewer-supplied. Each can point to an exact quote, image region, or table cell with a retained source binding. No AI answer is being generated."}</p><div className="button-row"><Link className="paper-button primary" href="/casebook">Open the casebook</Link></div></section></div>;
}
