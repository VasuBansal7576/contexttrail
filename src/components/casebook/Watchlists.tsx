'use client';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { parseWatchStore, type WatchStore } from '@/lib/monitor/model';
import { object } from '@/lib/watchlists/parse';
import { CasebookShell, ChapterHeading } from './CasebookShell';
import { SourceActions } from './EvidenceCollection';

type Status = WatchStore & { workerConnected: boolean; running: boolean; checkedAt: string };
async function request(action?: unknown, signal?: AbortSignal): Promise<Status> {
  const response = await fetch('/api/watch', { method: action ? 'POST' : 'GET', headers: action ? { 'content-type': 'application/json' } : undefined, body: action ? JSON.stringify(action) : undefined, cache: 'no-store', signal });
  const input: unknown = await response.json(), value = object(input);
  if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : 'The watchlist could not be opened.');
  if (typeof value.workerConnected !== 'boolean' || typeof value.running !== 'boolean' || typeof value.checkedAt !== 'string') throw new Error('Invalid watch status');
  return { ...parseWatchStore(input), workerConnected: value.workerConnected, running: value.running, checkedAt: value.checkedAt };
}
function date(value: string) { return new Date(value).toLocaleString(); }
export default function Watchlists() {
  const [status, setStatus] = useState<Status | null>(null), [question, setQuestion] = useState(''), [intervalHours, setIntervalHours] = useState<1 | 24>(24);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const mutating = useRef(false);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try { const next = await request(undefined, signal); if (!signal?.aborted && !mutating.current) { setStatus(next); setError(''); } }
    catch (error) { if (!signal?.aborted) setError(error instanceof Error ? error.message : 'Watchlist unavailable'); }
  }, []);
  useEffect(() => {
    const controller = new AbortController(); void refresh(controller.signal);
    const poll = setInterval(() => { void refresh(controller.signal); }, 10_000);
    return () => { controller.abort(); clearInterval(poll); };
  }, [refresh]);
  async function change(action: unknown) {
    if (mutating.current) return;
    mutating.current = true; setBusy(true); setError('');
    try { setStatus(await request(action)); return true; }
    catch (error) { setError(error instanceof Error ? error.message : 'The watch action failed.'); return false; }
    finally { mutating.current = false; setBusy(false); }
  }
  async function create(event: FormEvent) { event.preventDefault(); if (await change({ kind: 'create', question, intervalHours })) setQuestion(''); }
  return <CasebookShell chapter="watch"><main id="main" tabIndex={-1} className="casebook-main">
    <ChapterHeading number="07" label="Watch" description="Follow a question, product, brand or public incident. New evidence has a place to arrive.">Keep the question.<br /><em>Follow what changes.</em></ChapterHeading>
    <div className="automatic-intake"><form className="paper-sheet form-stack" onSubmit={create}>
      <label className="field">What should ContextTrail follow?<textarea required minLength={5} maxLength={500} value={question} disabled={!status || busy} onChange={event => setQuestion(event.target.value)} placeholder="What new evidence is emerging about this product or incident?" /></label>
      <label className="field">Check again<select value={intervalHours} disabled={!status || busy} onChange={event => setIntervalHours(event.target.value === '1' ? 1 : 24)}><option value={24}>Every day</option><option value={1}>Every hour</option></select></label>
      <button className="paper-button primary" disabled={!status || busy}>Start watching</button>
      <p className="fine-print">The first check runs within 30 seconds. Each check uses up to 3 searches and 8 TypeSafe requests. Your question and retrieved source text go to those providers. Checks pause on failure or exhausted allowance.</p>
    </form><aside className="automatic-aside"><p className="eyebrow">While you follow</p><p>New sources are leads until inspected. A changed retained sample can reflect search wording, page selection or publication changes; it is not proof of a correction.</p><p className="fine-print">Scheduling runs while this local server is running. No background checks happen after it shuts down. No private-person or government targeting.</p><Link className="text-link" href="/questions">Investigate a question now</Link></aside></div>
    {error ? <p role="alert" className="error-note">{error}</p> : null}
    <p className="eyebrow" role="status">{busy ? 'Updating the watchlist…' : !status ? 'Opening your watchlist…' : status.workerConnected ? `Worker connected${status.running ? ' · a check is running' : ''}` : 'Worker unavailable · scheduled checks are not confirmed'}</p>
    {status?.watches.length === 0 ? <p className="empty-state">Your first watch starts with a question. Its sources and check history will stay here.</p> : null}
    <div className="watch-list">{status?.watches.map(watch => <article className="paper-sheet watch-item" key={watch.id}>
      <div className="sheet-topline"><p className="eyebrow">{watch.state} / {watch.intervalHours === 1 ? 'Hourly' : 'Daily'}</p><span className="state-label">{watch.checks.length} retained checks</span></div>
      <h2>{watch.question}</h2><p className="fine-print">{watch.state === 'active' ? `Next scheduled check: ${date(watch.nextCheckAt)}` : 'Paused. Evidence and history are retained.'}</p>
      <div className="button-row"><button disabled={!status || busy} className="paper-button" onClick={() => { void change({ kind: watch.state === 'active' ? 'pause' : 'resume', id: watch.id }); }}>{watch.state === 'active' ? 'Pause watch' : 'Resume watch'}</button><button disabled={busy || status.running} className="paper-button" onClick={() => { void change({ kind: 'check', id: watch.id }); }}>Check now</button>{watch.lastCaseId ? <Link className="text-link" href={`/casebook?case=${encodeURIComponent(watch.lastCaseId)}`}>Read latest investigation</Link> : null}</div>
      {watch.checks.map((check, index) => <details className="watch-check" key={check.id} open={index === 0 && !check.baseline}><summary>{date(check.at)} · {check.error ? 'Check failed · watch paused' : check.baseline ? `${check.changes.length} sources in the starting sample` : check.changes.length ? `${check.changes.length} new or changed retained sources` : 'No new evidence in the retrieved sample'}</summary>
        {check.error ? <p className="error-note">{check.error}</p> : <><p className="fine-print">{check.baseline ? 'This first successful check establishes the baseline. Later checks compare against it.' : 'Absence from this search does not mean a source was removed.'} Only the last 50 checks appear here; their saved investigations remain in the casebook.</p>
        {check.caseId ? <Link className="text-link" href={`/casebook?case=${encodeURIComponent(check.caseId)}`}>Inspect this check’s evidence</Link> : null}
        <div className="source-stack">{check.changes.map(change => <div className="watch-source" key={change.url}><p className="eyebrow">{check.baseline ? (change.kind === 'new_passage' ? 'Retained page passage in baseline' : 'Source lead in baseline') : change.kind === 'new_passage' ? 'New retained page passage' : change.kind === 'new_lead' ? 'New source lead' : 'Changed retained sample'}</p><SourceActions url={change.url} />{change.priorCaseId ? <Link className="text-link" href={`/casebook?case=${encodeURIComponent(change.priorCaseId)}`}>Inspect previous sample</Link> : null}</div>)}</div></>}
      </details>)}
    </article>)}</div>
  </main></CasebookShell>;
}
