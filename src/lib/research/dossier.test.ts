import { expect, it } from 'vitest';
import { assessClaimSource, buildClaimReport } from './claim-report';
import { researchDossier, sourceStatements } from './dossier';
import { followupSearches, researchFocus } from './search-plan';
import { CASE_SCHEMA_VERSION, type CaseRecord, type CaseEvidence } from '../cases/model';
function source(id: string, text: string, attribution: 'page_quote' | 'search_snippet' = 'page_quote'): CaseEvidence { return { id, title: id, sourceUrl: `https://${id}.example.org/record`, content: { kind: 'text', text, attribution }, publicationDate: { status: 'unknown', reason: 'No date' }, provenance: { method: 'page_extraction', toolVersion: null, capturedAt: null, retrievedAt: '2026-10-04T00:00:00Z', rights: 'unknown', retention: 'reference_only', contentHash: null } }; }
function record(evidence: CaseEvidence[]): CaseRecord { return { schemaVersion: CASE_SCHEMA_VERSION, id: 'controlled-dossier', revision: 1, createdAt: '2026-10-04T00:00:00Z', claims: [], assets: [], evidence, occurrences: [], relations: [], coverage: { scope: 'retrieved_evidence', completeness: 'partial', omittedEvidenceCount: 0, originalPublication: { status: 'unknown', reason: 'No original established' }, searches: [], limitations: [] } }; }
it('shows exact inspected assertions from an image trace without inventing a claim assessment', () => {
  const text = 'Taken aboard Apollo 8 by Bill Anders, this iconic picture shows Earth peeking out from beyond the lunar surface.';
  const r = record([source('nasa', text), source('search', 'An uninspected search result must never become an answer assertion.', 'search_snippet')]);
  const statements = sourceStatements(null, r);
  expect(statements).toHaveLength(1);
  expect(statements[0].relation).toBe('insufficient');
  expect(text.slice(statements[0].quote.start, statements[0].quote.end)).toBe(statements[0].quote.text);
});
it('keeps the month abbreviation attached to its date and preserves exact offsets', () => {
  const text = 'On Dec. 24, 1968, Apollo 8 astronauts became the first humans to orbit the Moon.';
  const statements = sourceStatements(null, record([source('nasa', text)]));
  expect(statements[0].quote).toMatchObject({start: 0, end: text.length, text});
});
it('keeps decimal figures and exact source offsets without padding gaps with uninspected leads', () => {
  const question = 'How did UPI payment adoption change in India?';
  const r = record([source('one', 'UPI payment adoption grew to 24.51 billion transactions in India.\nHowever, UPI payment adoption also faces fraud and access limitations in India.'), source('snippet', 'UPI payment adoption was introduced by an original report.', 'search_snippet')]);
  const report = buildClaimReport(question, r, r.evidence.map(e => assessClaimSource(e, null, null)));
  const statements = sourceStatements(report, r);
  expect(statements).toHaveLength(2);
  expect(statements[0].quote.text).toContain('24.51');
  for (const statement of statements) { const e = statement.evidence; if (e.content.kind !== 'text') throw Error(); expect(e.content.text.slice(statement.quote.start, statement.quote.end)).toBe(statement.quote.text); }
  const dossier = researchDossier(report, r);
  expect(dossier.sections.find(s => s.id === 'history')?.statements).toEqual([]);
  expect(dossier.gaps).toContain('Dated accounts of the earlier history.');
  expect(dossier.sections.find(s => s.id === 'alternatives')?.statements).toHaveLength(1);
});
it('distinguishes identical retained wording from changed figures and withholds lineage or independence', () => {
  const text = 'UPI payment adoption in India reached 24.51 billion transactions during August 2026.';
  const r = record([source('one', text), source('two', text), source('three', text.replace('24.51', '20.01'))]);
  const report = buildClaimReport('What explains UPI payment adoption in India?', r, r.evidence.map(e => assessClaimSource(e, null, null)));
  const connections = researchDossier(report, r).connections;
  expect(connections.filter(c => c.status === 'same_retained_wording')).toHaveLength(1);
  expect(connections.filter(c => c.status === 'plausible_connection')).toHaveLength(2);
  expect(connections[0].reason).toContain('does not establish who copied whom');
  expect(connections[1].right.quote.text).toContain('20.01');
});
it('excludes explicitly low relevance passages from explanatory sections', () => {
  const r = record([source('one', 'UPI adoption was introduced in a different jurisdiction according to this history.')]);
  const assessment = { ...assessClaimSource(r.evidence[0], null, null), relevance: .1 };
  expect(sourceStatements(buildClaimReport('How did UPI adoption change?', r, [assessment]), r)).toEqual([]);
});
it('retains short subject acronyms while excluding a country-only or generic question-word overlap', () => {
  const r = record([source('one', 'UPI makes transfers available between accounts through interoperable payment applications.\nAnother explanation concerns the tax payer base in India according to the report.\nThe evidence distinguishes explanations in a completely unrelated research project.')]);
  const question = 'Why did UPI adoption grow so quickly in India, and what evidence distinguishes the explanations?';
  const statements = sourceStatements(buildClaimReport(question, r, r.evidence.map(e => assessClaimSource(e, null, null))), r);
  expect(statements.map(s => s.quote.text)).toEqual(['UPI makes transfers available between accounts through interoperable payment applications.']);
});
it('does not present article titles, questions or adoption measurements as an offered mechanism', () => {
  const r = record([source('one', 'What drives UPI payment adoption in India?\nUPI adoption in India reached 24.51 billion monthly transactions.\nUPI transfers expanded because interoperable infrastructure lowered transaction costs.')]);
  const report = buildClaimReport('Why did UPI adoption grow in India?', r, r.evidence.map(e => assessClaimSource(e, null, null)));
  const dossier = researchDossier(report, r);
  expect(dossier.sections.find(s => s.id === 'mechanisms')?.statements.map(s => s.quote.text)).toEqual(['UPI transfers expanded because interoperable infrastructure lowered transaction costs.']);
  expect(sourceStatements(report, r).some(s => s.quote.text.endsWith('?'))).toBe(false);
});
it.each([
  ['Review the rise of UPI in India', 'general'], ['What changed in hotel customer reviews?', 'reviews'],
  ['Who created this reposted photograph?', 'attribution'], ['Investigate plagiarism in this work', 'attribution'],
  ['Why is the received dress different from the advertised clothing?', 'shopping'], ['Compare brand product safety recall evidence', 'brand'],
  ['Claim: UPI has not always processed 24.51 billion transactions in August 2026.', 'news'],
] as const)('routes the evidence goals without a deceptive verdict: %s', (question, focus) => {
  expect(researchFocus(question)).toBe(focus);
  const searches = followupSearches(question);
  expect(searches).toHaveLength(3); expect(new Set(searches.map(s => s.q)).size).toBe(3);
  expect(searches.every(s => s.engine === 'google')).toBe(true);
  if (focus === 'news') for (const search of searches) { expect(search.q).toContain('not always'); expect(search.q).toContain('August 2026'); }
});

it('rejects a retained title matched by a truncated search title while keeping the article statements', () => {
  const evidence = source('one', 'Fashion Nova suppressed negative online reviews according to the investigation.\nThe Fashion Nova spokesperson contended that the review allegations were inaccurate and deceptive.');
  evidence.title = 'Fashion Nova suppressed negative online ...';
  const r = record([evidence]), report = buildClaimReport('What does evidence establish about Fashion Nova suppressing customer reviews versus fabricating them?',r,[assessClaimSource(evidence,null,null)]);
  const statements = sourceStatements(report,r);
  expect(statements.map(item => item.quote.text)).toEqual(['The Fashion Nova spokesperson contended that the review allegations were inaccurate and deceptive.']);
  expect(researchDossier(report,r).sections.find(section => section.id === 'response')?.statements).toHaveLength(1);
});
