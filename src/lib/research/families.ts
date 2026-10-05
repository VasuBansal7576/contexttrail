import { parseCaseRecord } from '../cases/parse';
import type { CaseRecord, CaseEvidence, SourcedDate } from '../cases/model';
import { assessClaimSource, buildClaimReport, parseClaimReport, type ClaimReport } from './claim-report';
import { sourceStatements } from './dossier';
export interface FamilyCase { caseId: string; question: string; record: CaseRecord; recordState: 'current' | 'historical' | 'unassessed'; report?: ClaimReport }
export function parseFamilyCases(value: unknown): FamilyCase[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error('Invalid family case sample');
  const cases = value.map((item): FamilyCase => {
    if (!item || typeof item !== 'object' || !('caseId' in item) || typeof item.caseId !== 'string' || !('question' in item) || typeof item.question !== 'string' || !item.question.trim() || item.question.length > 1000 || !('record' in item) || !('recordState' in item) || (item.recordState !== 'current' && item.recordState !== 'historical' && item.recordState !== 'unassessed')) throw new Error('Invalid family case');
    const record = parseCaseRecord(item.record); if (record.id !== item.caseId) throw new Error('Family record identity mismatch');
    const report = 'report' in item && item.report !== undefined ? parseClaimReport(item.report, record, item.question) : null;
    if ('report' in item && item.report !== undefined && !report) throw new Error('Invalid family source bindings');
    return { caseId: item.caseId, question: item.question, record, recordState: item.recordState, ...(report ? { report } : {}) };
  });
  if (new Set(cases.map(c => c.caseId)).size !== cases.length) throw new Error('Duplicate family case');
  return cases;
}
export interface StatementAppearance {
  id: number; text: string; source: CaseEvidence;
  references: Array<{ caseId: string; evidenceId: string; start: number; end: number; recordState: FamilyCase['recordState']; publicationDate: SourcedDate; retrievedAt: string | null }>;
}
export interface StatementConnection { from: number; to: number; status: 'same_retained_wording' | 'plausible_connection' | 'same_source_variant' }
function words(text: string) { return new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(word => word.length > 3 && !/^(?:that|this|with|from|have|were|been|their|they|more|than|which|when|also|according)$/.test(word))); }
function relationship(a: string, b: string): StatementConnection['status'] | null {
  if (a === b) return 'same_retained_wording';
  const left = words(a), right = words(b), common = [...left].filter(word => right.has(word)).length;
  return common >= 6 && common / new Set([...left, ...right]).size >= .4 ? 'plausible_connection' : null;
}
/** Automatic grouping over exactly retained, inspected passages. No provider call or assumed direction of spread. */
export function researchFamilies(cases: readonly FamilyCase[]) {
  const appearances: StatementAppearance[] = [], known = new Map<string, StatementAppearance>();
  let omittedStatements = 0;
  for (const c of cases) {
    const report = c.report ?? buildClaimReport(c.question, c.record, c.record.evidence.map(e => assessClaimSource(e, null, null)));
    for (const statement of sourceStatements(report, c.record)) {
      const key = JSON.stringify([statement.evidence.sourceUrl, statement.quote.text]);
      const reference = { caseId: c.caseId, evidenceId: statement.evidence.id, start: statement.quote.start, end: statement.quote.end, recordState: c.recordState, publicationDate: statement.evidence.publicationDate, retrievedAt: statement.evidence.provenance.retrievedAt };
      const existing = known.get(key);
      if (existing) { if (existing.references.length < 20) existing.references.push(reference); continue; }
      if (appearances.length >= 400) { omittedStatements++; continue; }
      const appearance = { id: appearances.length, text: statement.quote.text, source: statement.evidence, references: [reference] };
      known.set(key, appearance); appearances.push(appearance);
    }
  }
  const parents = appearances.map(a => a.id), edges: StatementConnection[] = [];
  function root(index: number): number { while (parents[index] !== index) index = parents[index]; return index; }
  for (let i = 0; i < appearances.length; i++) for (let j = i + 1; j < appearances.length; j++) {
    const sameSource = appearances[i].source.sourceUrl === appearances[j].source.sourceUrl;
    if (sameSource && appearances[i].references.some(left => appearances[j].references.some(right => left.caseId === right.caseId))) continue;
    const wording = relationship(appearances[i].text, appearances[j].text); if (!wording) continue;
    const status = sameSource ? 'same_source_variant' : wording;
    if (edges.length >= 1000) continue;
    edges.push({ from: i, to: j, status }); parents[root(j)] = root(i);
  }
  const groups = new Map<number, StatementAppearance[]>();
  for (const appearance of appearances) { const id = root(appearance.id); const group = groups.get(id) ?? []; group.push(appearance); groups.set(id, group); }
  const connected = [...groups.values()].filter(group => group.length >= 2).sort((a, b) => b.length - a.length || a[0].id - b[0].id);
  const families = connected.slice(0, 20).map((members, index) => {
    const ids = new Set(members.map(m => m.id));
    return { id: `family-${index + 1}`, members, connections: edges.filter(e => ids.has(e.from) && ids.has(e.to)) };
  });
  return { families, caseCount: cases.length, sourceStatementCount: appearances.length, unconnectedCount: appearances.filter(a => !edges.some(e => e.from === a.id || e.to === a.id)).length, omittedStatements, omittedFamilies: Math.max(0, connected.length - families.length) };
}
