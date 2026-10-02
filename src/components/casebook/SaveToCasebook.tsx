'use client';
import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { parseCaseRecord } from '@/lib/cases/parse';
import type { ClaimReport } from '@/lib/research/claim-report';
import { importResearchCase } from '@/lib/research/client';

export async function stableImportId(value: unknown): Promise<string> {
  function canonical(v: unknown): string {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`;
    return JSON.stringify(v) ?? 'null';
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return `import-${Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')}`;
}
export default function SaveToCasebook({ value, question, claimReport }: { value: unknown; question: string; claimReport?: ClaimReport }) {
  const record = useMemo(() => { try { return parseCaseRecord(value); } catch { return null; } }, [value]);
  const busy = useRef(false);
  const [state, setState] = useState<{ busy: boolean; error: string | null; caseId: string | null }>({ busy: false, error: null, caseId: null });
  if (!record) return null;
  async function save() {
    if (!record || busy.current) return;
    busy.current = true; setState({ busy: true, error: null, caseId: null });
    try {
      const input = { question, createdAt: record.createdAt, caseRecord: record, ...(claimReport ? { claimReport } : {}) };
      const result = await importResearchCase({ ...input, operationId: await stableImportId({ kind: 'import_case', ...input }) });
      setState({ busy: false, error: null, caseId: result.caseId });
    } catch (error) { setState({ busy: false, caseId: null, error: error instanceof Error ? error.message : 'Save failed. Retry to check the saved case.' }); }
    finally { busy.current = false; }
  }
  return <section className="mb-6 rounded-xl border border-ink/15 p-4" aria-label="Save investigation">
    <p className="text-sm">{claimReport ? 'Save this exact grounded report and its evidence locally. Reopening does not run another investigation.' : 'Keep this evidence in your local casebook. Uploaded image bytes and the full provider report are not copied.'}</p>
    {state.caseId ? <Link href={`/casebook?case=${encodeURIComponent(state.caseId)}&chapter=evidence`}>Open saved case</Link> : <button type="button" className="mt-3 min-h-[44px] rounded-full bg-ink px-5 text-white" disabled={state.busy} onClick={save}>{state.busy ? 'Saving…' : claimReport ? 'Save report' : 'Save to casebook'}</button>}
    {state.error && <p role="alert">{state.error}</p>}
  </section>;
}
