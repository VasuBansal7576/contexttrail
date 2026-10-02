'use client';
import type { ResearchCaseView, ResearchFindingSupport } from '@/lib/research/client';
import type { CaseEvidence } from '@/lib/cases/model';
import type { RetainedMaterial } from '@/lib/inquiries/materials';
import PaperDialog from './PaperDialog';
import { evidenceOrigin, MaterialView } from './EvidenceDetail';
export type OriginalEvidence = { kind: 'available'; evidence: CaseEvidence; caseRevision: number; material: RetainedMaterial | null } | { kind: 'absent'; reason: string };
/** Only exact references resolved by the persisted finding binding can enter this viewer. */
export function originalEvidence(view: ResearchCaseView, support: ResearchFindingSupport): OriginalEvidence {
  const anchor = support.anchor;
  if (anchor.kind === 'text') {
    const historical = support.historicalText;
    if (!historical || historical.evidence.id !== support.evidenceId || historical.evidence.content.kind !== 'text' || historical.evidence.content.text.slice(anchor.start, anchor.start + anchor.quote.length) !== anchor.quote) return { kind: 'absent', reason: 'Matching historical text is absent. The saved quote remains in the finding.' };
    return { kind: 'available', ...historical, material: null };
  }
  if (anchor.kind === 'image_region' || anchor.kind === 'table_cell') {
    const historical = support.historicalEvidence;
    const material = view.materials.versions.find(m => m.materialId === anchor.materialId && m.digest === anchor.materialDigest && m.evidenceId === support.evidenceId && m.digest === support.retainedMaterial?.digest);
    if (!historical || !material || historical.evidence.id !== support.evidenceId) return { kind: 'absent', reason: 'Matching historical source or material is absent. The saved selection remains in the finding.' };
    const content = material.content;
    const exact = anchor.kind === 'image_region' ? content.kind === 'image' && anchor.x + anchor.width <= content.width && anchor.y + anchor.height <= content.height : content.kind === 'table' && content.rows[anchor.row]?.[anchor.column] === anchor.value;
    return exact ? { kind: 'available', ...historical, material } : { kind: 'absent', reason: 'The retained material does not contain this exact saved selection.' };
  }
  return { kind: 'absent', reason: 'Original audiovisual bytes were not retained. The saved time selection remains in the finding.' };
}
export function originalEvidenceStatus(view: ResearchCaseView, support: ResearchFindingSupport): string {
  const anchor = support.anchor;
  const materialHead = anchor.kind === 'image_region' || anchor.kind === 'table_cell' ? view.materials.heads.find(h => h.materialId === anchor.materialId) : null;
  const parts = [support.evidence ? support.status === 'changed' ? 'Current source or material changed.' : 'Current source is available.' : 'Current source is unavailable.'];
  if (materialHead?.status === 'unavailable') parts.push(`Retained material was withdrawn: ${materialHead.reason}`);
  else if (support.status === 'unavailable' && support.evidence) parts.push('Current selected material is unavailable.');
  return parts.join(' ');
}
export default function HistoricalEvidence({ view, support, original, onClose }: { view: ResearchCaseView; support: ResearchFindingSupport; original: Extract<OriginalEvidence, { kind: 'available' }>; onClose: () => void }) {
  const { evidence, material, caseRevision } = original, anchor = support.anchor;
  const passage = evidence.content.kind === 'text' ? evidence.content.text : null;
  return <PaperDialog wide title={evidence.title ?? 'Original evidence'} description="Read-only original evidence for this finding. Inspecting it does not rebind the finding or renew its review." onClose={onClose}>
    <p className="error-note" role="status">Finding needs review. {originalEvidenceStatus(view, support)} The original selection is preserved below.</p>
    <p className="eyebrow">Original reviewed selection / historical evidence</p><p className="fine-print">{evidenceOrigin(evidence)}. Retained content and exact selections do not establish relevance, authenticity or truth.</p>
    {passage !== null && anchor.kind === 'text' ? <p className="evidence-passage">{passage.slice(0, anchor.start)}<mark>{anchor.quote}</mark>{passage.slice(anchor.start + anchor.quote.length)}</p> : null}
    {material ? <MaterialView material={material} anchor={anchor} /> : null}
    <p className="fine-print">{anchor.kind === 'text' ? `Saved quote at UTF-16 characters ${anchor.start} to ${anchor.start + anchor.quote.length}` : anchor.kind === 'image_region' ? `Exact region: x ${anchor.x}, y ${anchor.y}, width ${anchor.width}, height ${anchor.height} pixels` : anchor.kind === 'table_cell' ? `Exact cell: data row ${anchor.row + 1}, column ${anchor.column + 1}` : `Saved time span: ${anchor.startMs} ms for ${anchor.durationMs} ms`}</p>
    <dl className="evidence-meta"><dt>Historical source URL</dt><dd>{evidence.sourceUrl}</dd><dt>Historical source revision</dt><dd>{caseRevision}</dd><dt>Historical source retrieved</dt><dd>{evidence.provenance.retrievedAt ?? 'Not recorded'}</dd><dt>Historical source captured</dt><dd>{evidence.provenance.capturedAt ?? 'Not recorded'}</dd><dt>Evidence ID</dt><dd>{evidence.id}</dd><dt>Method</dt><dd>{evidence.provenance.method.replaceAll('_', ' ')}</dd>{material ? <><dt>Material revision</dt><dd>{material.revision}</dd><dt>Material captured</dt><dd>{material.capturedAt}</dd><dt>Material digest</dt><dd>{material.digest}</dd></> : null}</dl>
    <p className="fine-print">Capture and retrieval times are preserved from this retained source revision. Source bindings exclude those timestamps; the match does not prove the time of the original review.</p>
    <a className="text-link source-url" href={evidence.sourceUrl} target="_blank" rel="noopener noreferrer">Open historical source URL</a>
  </PaperDialog>;
}
