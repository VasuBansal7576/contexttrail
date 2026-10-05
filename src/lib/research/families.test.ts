import { expect, it } from 'vitest';
import { CASE_SCHEMA_VERSION, type CaseRecord, type CaseEvidence } from '../cases/model';
import { assessClaimSource, buildClaimReport } from './claim-report';
import { parseFamilyCases, researchFamilies, type FamilyCase } from './families';
const text = 'UPI payment adoption in India reached 24.51 billion monthly transactions during August 2026.';
function sample(id: string, url: string, wording = text, attribution: 'page_quote' | 'search_snippet' = 'page_quote'): FamilyCase {
  const evidence: CaseEvidence = { id: `source-${id}`, sourceUrl: url, title: `UPI record ${id}`, content: { kind: 'text', text: wording, attribution }, publicationDate: { status: 'observed', observation: { value: '2026-09-01', precision: 'day', source: { kind: 'page_meta', url, recordedValue: '2026-09-01' } } }, provenance: { method: 'page_extraction', toolVersion: null, capturedAt: null, retrievedAt: '2026-10-04T00:00:00Z', rights: 'unknown', retention: 'reference_only', contentHash: null } };
  const record: CaseRecord = { schemaVersion: CASE_SCHEMA_VERSION, id, revision: 1, createdAt: '2026-10-04T00:00:00Z', claims: [], assets: [], evidence: [evidence], occurrences: [], relations: [], coverage: { scope: 'retrieved_evidence', completeness: 'partial', omittedEvidenceCount: 0, originalPublication: { status: 'unknown', reason: 'Unknown origin' }, limitations: [], searches: [] } };
  const question = 'What explains UPI payment adoption in India?';
  return { caseId: id, question, record, recordState: 'current', report: buildClaimReport(question, record, [assessClaimSource(evidence, null, null)]) };
}
it('connects actual repeated wording and changed figures without turning them into a truth or spread verdict', () => {
  const cases = [sample('one', 'https://one.example.org/source'), sample('two', 'https://two.example.org/source'), sample('three', 'https://three.example.org/source', text.replace('24.51', '20.01'))];
  expect(parseFamilyCases(JSON.parse(JSON.stringify(cases)))).toEqual(cases);
  const result = researchFamilies(cases); expect(result.families).toHaveLength(1); expect(result.families[0].members).toHaveLength(3);
  expect(result.families[0].connections.filter(e => e.status === 'same_retained_wording')).toHaveLength(1);
  expect(result.families[0].connections.filter(e => e.status === 'plausible_connection')).toHaveLength(2);
  expect(result.families[0].members[2].text).toContain('20.01');
});
it('merges repeated checks of identical source wording without manufacturing another appearance', () => {
  const cases = [sample('one', 'https://one.example.org/source'), sample('two', 'https://one.example.org/source')];
  const result = researchFamilies(cases); expect(result.sourceStatementCount).toBe(1); expect(result.families).toEqual([]); expect(result.unconnectedCount).toBe(1);
});
it('distinguishes same-page retained variants from different-page connections and retains their snapshot dates', () => {
  const cases = [sample('one', 'https://one.example.org/source'), sample('two', 'https://one.example.org/source', text.replace('24.51', '20.01'))];
  const result = researchFamilies(cases); expect(result.families[0].connections[0].status).toBe('same_source_variant');
  expect(result.families[0].members[0].references[0].publicationDate.status).toBe('observed');
  expect(result.families[0].members[0].references[0].retrievedAt).toBe('2026-10-04T00:00:00Z');
});
it('does not promote snippets, low relevance, stale bindings or unrelated boilerplate into a family', () => {
  const one = sample('one', 'https://one.example.org/source'); const snippet = sample('snippet', 'https://snippet.example.org/source', text, 'search_snippet');
  expect(researchFamilies([one, snippet]).families).toEqual([]);
  expect(() => parseFamilyCases([{ ...one, question: 'An unrelated question?' }])).toThrow(/bindings/);
  expect(() => parseFamilyCases([{ ...one, caseId: 'different' }])).toThrow(/identity/);
});
