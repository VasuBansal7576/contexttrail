'use client';

import { useRef, useState, type ReactNode } from 'react';

/** Keep every record reachable while bounding the amount of evidence on screen. */
export function EvidenceCollection<T>({ items, label, children, pageSize = 8 }: { items: readonly T[]; label: string; children: (item: T, index: number) => ReactNode; pageSize?: number }) {
  const [requestedPage, setPage] = useState(0);
  const heading = useRef<HTMLDivElement>(null);
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(requestedPage, pages - 1);
  const start = page * pageSize;
  function navigate(next: number) {
    setPage(next);
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
  }
  return <div className="evidence-collection" ref={heading} tabIndex={-1}>
    {items.length > pageSize ? <p className="fine-print" role="status">{label}: {start + 1}–{Math.min(start + pageSize, items.length)} of {items.length}</p> : null}
    {items.slice(start, start + pageSize).map((item, index) => children(item, start + index))}
    {pages > 1 ? <nav className="evidence-pagination" aria-label={`${label} pages`}><button type="button" className="paper-button" disabled={page === 0} onClick={() => navigate(page - 1)}>Previous</button><span>Page {page + 1} of {pages}</span><button type="button" className="paper-button" disabled={page === pages - 1} onClick={() => navigate(page + 1)}>Next</button></nav> : null}
  </div>;
}

export function EvidencePassage({ text }: { text: string }) {
  if (text.length <= 500) return <p className="evidence-passage">{text}</p>;
  return <details className="evidence-full-text"><summary><span className="evidence-passage">{text.slice(0, 500)}…</span><span className="text-link">Read complete retained text ({text.length.toLocaleString()} characters)</span></summary><p className="evidence-passage">{text}</p></details>;
}

/** URLs are displayed exactly as retained; only ordinary web URLs can be opened. */
export function safeSourceUrl(value: string): string | null {
  try { const url = new URL(value); return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? value : null; } catch { return null; }
}
export function SourceActions({ url }: { url: string }) {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const safe = safeSourceUrl(url);
  const domain = safe ? new URL(safe).hostname : 'Unavailable web address';
  return <div className="source-address"><p className="eyebrow">{domain}</p><p className="source-url">{url}</p>{safe ? <div className="source-actions"><a className="text-link" href={safe} target="_blank" rel="noopener noreferrer">Open in new tab ↗</a><button className="text-link" type="button" onClick={async () => { try { await navigator.clipboard.writeText(safe); setCopy('copied'); } catch { setCopy('failed'); } }}>Copy URL</button><span className="fine-print" role="status">{copy === 'copied' ? 'URL copied' : copy === 'failed' ? 'Copy unavailable. Select the URL above to copy it.' : ''}</span></div> : <p className="fine-print">This address cannot be opened as a web source.</p>}</div>;
}
