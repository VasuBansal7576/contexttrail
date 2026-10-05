'use client';
import type { SavedVideoReport } from '@/lib/research/saved-video';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { parseCaseRecord } from '@/lib/cases/parse';
import type { ClaimReport } from '@/lib/research/claim-report';
import { importResearchCase } from '@/lib/research/client';
import { useSavedCaseNavigation } from './CasebookShell';

export async function stableImportId(value: unknown): Promise<string> {
  function canonical(v: unknown): string {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`;
    return JSON.stringify(v) ?? 'null';
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return `import-${Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')}`;
}
export default function SaveToCasebook({ value, question, claimReport, videoReport, autoSave = false }: { value: unknown; question: string; claimReport?: ClaimReport; videoReport?: SavedVideoReport; autoSave?: boolean }) {
  const rememberSavedCase = useSavedCaseNavigation();
  const record = useMemo(() => { try { return parseCaseRecord(value); } catch { return null; } }, [value]);
  const busy = useRef(false);
  const [state, setState] = useState<{ busy: boolean; error: string | null; caseId: string | null }>({ busy: false, error: null, caseId: null });
  const save = useCallback(async () => {
    if (!record || busy.current) return;
    busy.current = true; setState({ busy: true, error: null, caseId: null });
    try {
      const input = { question, createdAt: record.createdAt, caseRecord: record, ...(claimReport ? { claimReport } : {}), ...(videoReport ? { videoReport } : {}) };
      const result = await importResearchCase({ ...input, operationId: await stableImportId({ kind: 'import_case', ...input }) });
      setState({ busy: false, error: null, caseId: result.caseId });
      rememberSavedCase?.(result.caseId, Boolean(videoReport));
    } catch (error) { setState({ busy: false, caseId: null, error: error instanceof Error ? error.message : 'Save failed. Retry to check the saved case.' }); }
    finally { busy.current = false; }
  }, [record, question, claimReport, videoReport, rememberSavedCase]);
  useEffect(() => { if (autoSave) void save(); }, [autoSave, save]);
  if (!record) return null;
  return <section className="paper-sheet saved-research-action" aria-label="Save investigation">
    <p className="text-sm">{videoReport ? 'Keep the completed media report, recognized speech, source evidence and provenance locally. Original recording and sampled image bytes are excluded. Reopening runs no retrieval or model assessment.' : claimReport ? 'Save this exact grounded report and its evidence locally. Reopening does not run another investigation.' : 'Keep this evidence in your local casebook. Uploaded image bytes and the full provider report are not copied.'}</p>
    {state.caseId ? <><p className="eyebrow" role="status">Kept in your casebook</p><Link className="text-link" href={`/casebook?case=${encodeURIComponent(state.caseId)}&chapter=evidence`}>Open saved case</Link></> : <button type="button" className="paper-button primary" disabled={state.busy} onClick={save}>{state.busy ? 'Saving…' : videoReport ? videoReport.result.kind === 'audio' ? 'Save audio report' : 'Save video report' : claimReport ? 'Save report' : 'Save to casebook'}</button>}
    {state.error && <p role="alert">{state.error}</p>}
  </section>;
}
