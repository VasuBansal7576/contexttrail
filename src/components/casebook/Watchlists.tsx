'use client';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { parseWatchStore, type WatchStore } from '@/lib/monitor/model';
import { getResearchCase } from '@/lib/research/client';
import { object } from '@/lib/watchlists/parse';
import { CasebookShell, ChapterHeading } from './CasebookShell';
import { SourceActions } from './EvidenceCollection';
import PaperDialog from './PaperDialog';

type Status = WatchStore & { workerConnected: boolean; running: boolean; checkedAt: string };
async function request(action?: unknown, signal?: AbortSignal): Promise<Status> {
  const response = await fetch('/api/watch', { method: action ? 'POST' : 'GET', headers: action ? { 'content-type': 'application/json' } : undefined, body: action ? JSON.stringify(action) : undefined, cache: 'no-store', signal });
  const input: unknown = await response.json(), value = object(input);
  if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : 'The watchlist could not be opened.');
  if (typeof value.workerConnected !== 'boolean' || typeof value.running !== 'boolean' || typeof value.checkedAt !== 'string') throw new Error('Invalid watch status');
  return { ...parseWatchStore(input), workerConnected: value.workerConnected, running: value.running, checkedAt: value.checkedAt };
}
function date(value: string) { return new Date(value).toLocaleString(); }
export default function Watchlists({caseId}: {caseId?: string} = {}) {
  const [status, setStatus] = useState<Status | null>(null), [question, setQuestion] = useState(''), [intervalHours, setIntervalHours] = useState<1 | 24>(24);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [selectedWatchId, setSelectedWatchId] = useState<string | null>(null);
  const selectedWatch = status?.watches.find(watch => watch.id === selectedWatchId);
  const mutating = useRef(false);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try { const next = await request(undefined, signal); if (!signal?.aborted && !mutating.current) { setStatus(next); setLoadError(''); } }
    catch (error) { if (!signal?.aborted) setLoadError(error instanceof Error ? error.message : 'Watchlist unavailable'); }
  }, []);
  useEffect(() => {
    const controller = new AbortController(); void refresh(controller.signal);
    const poll = setInterval(() => { void refresh(controller.signal); }, 10_000);
    return () => { controller.abort(); clearInterval(poll); };
  }, [refresh]);
  useEffect(() => {
    if (!caseId) return;
    const controller = new AbortController();
    void getResearchCase(caseId, {signal:controller.signal}).then(view => {
      if (!controller.signal.aborted) setQuestion(current => current || view.question);
    }).catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'The saved question could not be opened.'); });
    return () => controller.abort();
  }, [caseId]);
  async function change(action: unknown) {
    if (mutating.current) return;
    mutating.current = true; setBusy(true); setError('');
    try { setStatus(await request(action)); return true; }
    catch (error) { setError(error instanceof Error ? error.message : 'The watch action failed.'); return false; }
    finally { mutating.current = false; setBusy(false); }
  }
  async function create(event: FormEvent) { event.preventDefault(); if (question.trim().length < 5) return; if (await change({ kind: 'create', question: question.trim(), intervalHours })) setQuestion(''); }
  return <CasebookShell chapter="watch" caseId={caseId}><main id="main" tabIndex={-1} className="casebook-main">
    <div className="watch-workspace"><div className="watch-copy">
    <ChapterHeading number="07" label="Watch" description="A case can rest without being forgotten. Return when new evidence or a changed source gives you a reason.">Keep the<br /><em>question<br />open.</em></ChapterHeading>
    <div className="watch-controls"><form className="paper-sheet form-stack" onSubmit={create}>
      <label className="field">What should ContextTrail follow?<textarea required minLength={5} maxLength={500} value={question} disabled={!status || busy} onChange={event => setQuestion(event.target.value)} placeholder="What new evidence is emerging about this product or incident?" /></label>
      <label className="field">Check again<select value={intervalHours} disabled={!status || busy} onChange={event => setIntervalHours(event.target.value === '1' ? 1 : 24)}><option value={24}>Every day</option><option value={1}>Every hour</option></select></label>
      <button className="paper-button primary" disabled={!status || busy || question.trim().length < 5}>Start watching</button>
      <p className="fine-print">The first check runs within 30 seconds. Each check uses up to 6 searches and 12 TypeSafe requests. Your question and retrieved source text go to those providers. Checks pause on failure or exhausted allowance.</p>
    </form><aside className="automatic-aside"><p className="eyebrow">While you follow</p><p>New sources are leads until inspected. A changed retained sample can reflect search wording, page selection or publication changes; it is not proof of a correction.</p><p className="fine-print">Scheduling runs while this local server is running. No background checks happen after it shuts down. No private-person or government targeting.</p><Link className="text-link" href="/questions">Investigate a question now</Link><Link className="text-link" href="/families">Compare related source versions</Link></aside></div>
    </div><section className="watch-inbox"><p className="eyebrow">A quieter kind of inbox</p><h2>What deserves your attention?</h2>
    {error || loadError ? <p role="alert" className="error-note">{error || loadError}</p> : null}

    {status?.watches.length === 0 ? <p className="empty-state">Your first watch starts with a question. Its sources and check history will stay here.</p> : null}
    <div className="watch-list">{status?.watches.map((watch, index) => {
      const check = watch.checks[0];
      const title = check?.error ? 'Check needs attention.' : !check ? 'Waiting for the first check.' : check.baseline ? 'A starting sample.' : check.changes.length ? 'New or changed sources.' : 'The question stays open.';
      return <button className="watch-event" key={watch.id} aria-label={`Inspect watch: ${watch.question}`} onClick={() => { setError(''); setSelectedWatchId(watch.id); }}><span className="watch-event-number">{String(index + 1).padStart(2, '0')}</span><span><strong>{title}</strong><span className="watch-event-question">{watch.question}</span><small>{watch.state} / {watch.intervalHours === 1 ? 'Hourly' : 'Daily'} · {watch.checks.length} retained check{watch.checks.length === 1 ? '' : 's'}</small></span><span aria-hidden="true">↗</span></button>;
    })}</div>
    <p className="eyebrow" role="status">{busy ? 'Updating the watchlist…' : !status ? 'Opening your watchlist…' : status.workerConnected ? `Worker connected${status.running ? ' · a check is running' : ''}` : 'Worker unavailable · scheduled checks are not confirmed'}</p><p className="watch-inbox-note">No change should mean no interruption. Open a retained check to inspect its sources and manage the watch.</p></section></div>
    {status && selectedWatch ? <PaperDialog wide title={selectedWatch.question} description="Inspect retained checks and their sources. Scheduling and manual checks use your existing provider allowance." busy={busy} onClose={() => setSelectedWatchId(null)}>{error ? <p className="error-note" role="alert">{error}</p> : null}<article className="watch-detail">
      <div className="sheet-topline"><p className="eyebrow">{selectedWatch.state} / {selectedWatch.intervalHours === 1 ? 'Hourly' : 'Daily'}</p><span className="state-label">{selectedWatch.checks.length} retained check{selectedWatch.checks.length === 1 ? '' : 's'}</span></div>
      <p className="fine-print">{selectedWatch.state === 'active' ? `Next scheduled check: ${date(selectedWatch.nextCheckAt)}` : 'Paused. Evidence and history are retained.'}</p>
      <div className="button-row"><button disabled={!status || busy} className="paper-button" onClick={() => { void change({ kind: selectedWatch.state === 'active' ? 'pause' : 'resume', id: selectedWatch.id }); }}>{selectedWatch.state === 'active' ? 'Pause watch' : 'Resume watch'}</button><button disabled={busy || status.running} className="paper-button" onClick={() => { void change({ kind: 'check', id: selectedWatch.id }); }}>Check now</button>{selectedWatch.lastCaseId ? <Link className="text-link" href={`/casebook?case=${encodeURIComponent(selectedWatch.lastCaseId)}`}>Read latest investigation</Link> : null}</div>
      {selectedWatch.checks.map((check, index) => <details className="watch-check" key={check.id} open={index === 0 && !check.baseline}><summary>{date(check.at)} · {check.error ? 'Check failed · watch paused' : check.baseline ? `${check.changes.length} sources in the starting sample` : check.changes.length ? `${check.changes.length} new or changed retained sources` : 'No new evidence in the retrieved sample'}</summary>
        {check.error ? <p className="error-note">{check.error}</p> : <><p className="fine-print">{check.baseline ? 'This first successful check establishes the baseline. Later checks compare against it.' : 'Absence from this search does not mean a source was removed.'} Only the last 50 checks appear here; their saved investigations remain in the casebook.</p>
        {check.caseId ? <Link className="text-link" href={`/casebook?case=${encodeURIComponent(check.caseId)}`}>Inspect this check’s evidence</Link> : null}
        <div className="source-stack">{check.changes.map(change => <div className="watch-source" key={change.url}><p className="eyebrow">{check.baseline ? (change.kind === 'new_passage' ? 'Retained page passage in baseline' : 'Source lead in baseline') : change.kind === 'new_passage' ? 'New retained page passage' : change.kind === 'new_lead' ? 'New source lead' : 'Changed retained sample'}</p><SourceActions url={change.url} />{change.priorCaseId ? <Link className="text-link" href={`/casebook?case=${encodeURIComponent(change.priorCaseId)}`}>Inspect previous sample</Link> : null}</div>)}</div></>}
      </details>)}
    </article></PaperDialog> : null}
  </main></CasebookShell>;
}
