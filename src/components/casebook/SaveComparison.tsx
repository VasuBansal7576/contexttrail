'use client';
import { useRef, useState } from 'react';
import Link from 'next/link';
import type { LocalComparisonResponse } from '@/lib/video/matching/application-contract';
import { importResearchComparison } from '@/lib/research/client';
import { stableImportId } from './SaveToCasebook';
export default function SaveComparison({ result }: { result: LocalComparisonResponse }) {
  const busy = useRef(false);
  const [state, setState] = useState<{ busy: boolean; error: string | null; caseId: string | null }>({ busy: false, error: null, caseId: null });
  async function save() {
    if (busy.current) return;
    busy.current = true; setState({ busy: true, error: null, caseId: null });
    try {
      const question = 'What can these supplied media samples establish?';
      if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 4 * 1024 * 1024) throw new Error('This comparison exceeds the 4 MiB saved snapshot limit. The result remains in this tab.');
      const operationId = await stableImportId({ kind: 'import_comparison', question, comparison: result });
      const key = `contexttrail-save-time:${operationId}`;
      let createdAt = sessionStorage.getItem(key);
      if (!createdAt) { createdAt = new Date().toISOString(); sessionStorage.setItem(key, createdAt); }
      const saved = await importResearchComparison({ operationId, question, createdAt, comparison: result });
      setState({ busy: false, error: null, caseId: saved.caseId });
    } catch (error) { setState({ busy: false, caseId: null, error: error instanceof Error ? error.message : 'Save failed. Retry to check the saved case.' }); }
    finally { busy.current = false; }
  }
  return <div className="video-persistence-note"><p>Save the sampled frames and this exact comparison. Original video files are not retained.</p>{state.caseId ? <Link href={`/casebook?case=${encodeURIComponent(state.caseId)}&chapter=evidence`}>Open saved comparison</Link> : <button className="paper-button primary" disabled={state.busy} onClick={save}>{state.busy ? 'Saving…' : 'Save comparison to casebook'}</button>}{state.error && <p role="alert">{state.error}</p>}</div>;
}
