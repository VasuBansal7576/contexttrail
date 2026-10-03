import { describe, it, expect, vi } from 'vitest';
import { assessClaimSource, buildClaimReport, explicitTopicClaim, invalidateClaimReport, parseClaimReport, CLAIM_QUESTIONS } from './claim-report';
import { JEV_MODEL, type JevAskResult, JevClient } from '../jev/client';
import type { CaseEvidence, CaseRecord } from '../cases/model';
import { investigateTopic } from './automatic';
function evidence(text: string, id = 'a'): CaseEvidence {
  return { id, sourceUrl: `https://${id}.example.org/evidence`, title: null, content: { kind: 'text', text, attribution: 'page_quote' }, publicationDate: { status: 'unknown', reason: 'Unknown.' }, provenance: { method: 'page_extraction', toolVersion: null, capturedAt: null, retrievedAt: null, rights: 'unknown', retention: 'reference_only', contentHash: null } };
}
function record(items: CaseEvidence[]): CaseRecord {
  return { schemaVersion: 'contexttrail-case-v1', id: 'test', revision: 1, createdAt: '2026-10-02T00:00:00.000Z', evidence: items, claims: [], assets: [], occurrences: [], relations: [], coverage: { scope: 'retrieved_evidence', completeness: 'partial', omittedEvidenceCount: 0, originalPublication: { status: 'unknown', reason: 'Unknown.' }, searches: [], limitations: [] } };
}
function answer(relation: 'support'|'challenge'|'context'|'insufficient', scopes = ['compatible', 'compatible', 'compatible']): JevAskResult {
  const choice = (keys: string[], winner: string) => ({ type: 'choice', choice: winner, probabilities: Object.fromEntries(keys.map(key => [key, key === winner ? 1 : 0])) });
  return { model: JEV_MODEL, identity: { requested: JEV_MODEL, reported: JEV_MODEL, status: 'verified', pinned: true }, answers: { relevance: { type: 'noul', noul: 0.9 }, relation: choice(['support','challenge','context','insufficient'], relation), entity_property: choice(['compatible','different','unknown'],scopes[0]), time: choice(['compatible','different','unknown'], scopes[1]), variant: choice(['compatible','different','unknown'], scopes[2]) } };
}
describe('claim-scoped policy fixtures (offline probabilities, not a live model evaluation)', () => {
  it.each([
    ['review suppression is not fabrication', 'All Brand reviews are fabricated.', 'The FTC alleged that Brand suppressed lower-star reviews.', ['different','unknown','different']],
    ['historical settlement is not all current reviews', 'All current Brand reviews are fabricated.', 'Brand settled the review suppression case in 2022.', ['different','different','different']],
    ['mixed dress experiences and refund', 'The dress reviews are all fake.', 'My dress fit poorly. Another customer liked the fit. The seller refunded my purchase.', ['different','unknown','different']],
    ['legitimate archival reuse', 'This photograph is a deceptive recent report.', 'This archive displays the 1978 photograph as a historical illustration, with the original date in its caption.', ['different','different','compatible']],
  ])('%s cannot become support merely because excerpt relation is high', (_name, claim, quote, scopes) => {
    const source = assessClaimSource(evidence(quote), claim, answer('support', scopes));
    expect(source.relation).toBe('context');
    expect(source.quote?.text).toBe(quote);
    expect(source.reasons.some(reason => reason.includes('scope'))).toBe(true);
  });
  it('visibly demotes low relevance even when relationship and scope probabilities are high', () => {
    const assessed = answer('support'); assessed.answers.relevance = { type: 'noul', noul: 0.1 };
    const item = evidence('Newsletter information for readers.');
    const question = 'Claim: The product is defective.';
    const source = assessClaimSource(item, explicitTopicClaim(question), assessed);
    expect(source.relation).toBe('insufficient');
    expect(source.relevance).toBe(0.1);
    expect(source.reasons.some(reason => reason.startsWith('Low topic relevance'))).toBe(true);
    const snapshot = record([item]);
    const report = buildClaimReport(question, snapshot, [source]);
    expect(parseClaimReport(report, snapshot, question)).toEqual(report);
  });
  it('keeps mixed real review disagreements unresolved rather than voting', () => {
    const question = 'Claim: This dress fits the listed measurements for size M in 2026.';
    const items = [evidence('I measured the 2026 size M dress and it matches the listed waist and length.'), evidence('I measured the 2026 size M dress and its waist and length are both smaller than listed.', 'b')];
    const report = buildClaimReport(question, record(items), items.map((item, index) => assessClaimSource(item, explicitTopicClaim(question), answer(index ? 'challenge':'support'))));
    expect(report.unresolvedDisagreements).toHaveLength(1);
    expect(report).not.toHaveProperty('verdict'); expect(report).not.toHaveProperty('score');
    expect(report.dependencies[0].status).toBe('unknown');
  });
  it('keeps broad questions as exact candidate source quotations and refuses direct repetition as proof', () => {
    const item = evidence('Some customers report a long delivery wait; other customers report timely arrival.');
    const report = buildClaimReport('Are these reviews fake?', record([item]), [assessClaimSource(item,null,answer('support'))]);
    expect(report.mode).toBe('source_assertions'); expect(report.claim).toBeNull();
    expect(report.sources[0].candidateAssertion?.text).toBe(item.content.kind === 'text' ? item.content.text : '');
    expect(report.sources[0].relation).toBe('context'); expect(report.sources[0].scope.time).toBe('unknown');
    expect(assessClaimSource(evidence('All reviews are fake.'), 'All reviews are fake.', answer('support')).relation).toBe('context');
  });
  it('uses unknown defaults and refuses malformed or unpinned probabilities', () => {
    const item = evidence('An excerpt.');
    const missing = assessClaimSource(item,'The product is defective.',null);
    expect(missing.relation).toBe('insufficient'); expect(missing.scope.time).toBe('unknown');
    const malformed = answer('support'); malformed.answers.time = { type:'choice',choice:'compatible',probabilities:{compatible:2,different:0,unknown:0} };
    expect(assessClaimSource(item,'The product is defective.',malformed).relation).toBe('context');
    malformed.identity = { ...malformed.identity, reported: 'other-model' };
    expect(assessClaimSource(item,'The product is defective.',malformed).model).toBeNull();
    expect(Object.keys(CLAIM_QUESTIONS)).toHaveLength(5);
  });
  it('records exact duplication/citation signals without asserting independence or deception', () => {
    const passage = 'This archived account provides a detailed chronology of the original image publication and its later reuse in historical reports.';
    const items = [evidence(passage + ' https://b.example.org/evidence'), evidence(passage,'b')];
    const report = buildClaimReport('Image chronology',record(items),items.map(item => assessClaimSource(item,null,null)));
    expect(report.dependencies[0].signals.map(signal => signal.kind)).toEqual(['exact_duplicate_passage','citation_url']);
    expect(report.dependencies[0].status).toBe('unknown');
  });
  it('validates persisted reports and invalidates edits to text, attribution, date, claim, assets or question', () => {
    const question = 'Claim: The product is defective.'; const item = evidence('The lab measured a fracture in this product.'); const r = record([item]);
    const report = buildClaimReport(question,r,[assessClaimSource(item,explicitTopicClaim(question),answer('context'))]);
    expect(parseClaimReport(JSON.parse(JSON.stringify(report)),r,question)).toEqual(report);
    expect(invalidateClaimReport(report,r,question)).toBe(report);
    for (const edit of [(v: CaseRecord) => { v.evidence[0].title='Changed'; }, (v: CaseRecord) => { v.evidence[0].content={kind:'text',text:'Changed',attribution:'search_snippet'}; }, (v: CaseRecord) => { v.evidence[0].publicationDate={status:'unknown',reason:'Changed'}; }]) {
      const changed = structuredClone(r); edit(changed); expect(invalidateClaimReport(report,changed,question)).toBeNull();
    }
    expect(invalidateClaimReport(report,r,'Another claim')).toBeNull();
    const tampered = structuredClone(report); tampered.sources[0].relation='support';
    expect(parseClaimReport(tampered,r,question)).toBeNull();
    const forged = structuredClone(report); forged.sources[0].quote!.text='Invented quotation';
    expect(parseClaimReport(forged,r,question)).toBeNull();
  });
  it('topic orchestration stays at 3 searches, 5 page reads, 8 provider calls and 40 questions', async () => {
    const search = vi.fn(async (params: {engine:string;q?:string}) => ({ search_metadata:{status:'Success'}, [params.engine==='google_news'?'news_results':'organic_results']:Array.from({length:8},(_,i)=>({link:`https://${params.engine==='google_news'?'news':'web'}.example.org/${i}`,snippet:'Source text.',title:'Source'})) }));
    const fetchImpl = vi.fn(async () => Response.json({model:JEV_MODEL,answers:answer('context').answers}));
    const fetchPage = vi.fn(async (url:string) => ({url,html:`<html><body><article><p>${'Source text with relevant evidence for the topic. '.repeat(20)}</p></article></body></html>`}));
    const result = await investigateTopic('Are the reviews fake?',()=>{}, {serpapi:{search,uploadImage:vi.fn()},fetchPage,jev:new JevClient({apiKey:'offline-fixture',fetchImpl})});
    expect(search).toHaveBeenCalledTimes(3);expect(search.mock.calls[2][0].q).toContain('(statement OR clarification OR "press release" OR correction)');expect(fetchPage).toHaveBeenCalledTimes(5);expect(fetchImpl).toHaveBeenCalledTimes(8);
    expect(result.claimReport?.sources).toHaveLength(8);
    expect(parseClaimReport(result.claimReport,result.caseRecord,result.question)).not.toBeNull();
  });
});

it('accepts only the exact historical low-relevance prose omission, retaining all factual gates', () => {
  const question = 'Claim: The product is defective.';
  const item = evidence('Newsletter information for readers.');
  const snapshot = record([item]);
  const assessment = answer('support'); assessment.answers.relevance = { type: 'noul', noul: 0.1 };
  const current = buildClaimReport(question, snapshot, [assessClaimSource(item, explicitTopicClaim(question), assessment)]);
  const legacy = structuredClone(current); legacy.sources[0].reasons.shift();
  expect(parseClaimReport(legacy, snapshot, question)).toEqual(legacy);
  expect(invalidateClaimReport(legacy, snapshot, question)).toBeNull();
  expect(invalidateClaimReport(current, snapshot, question)).toEqual(current);
  const mutations: Array<(report: typeof legacy) => void> = [
    report => { report.sources[0].relation = 'support'; },
    report => { report.sources[0].scope.time = 'unknown'; },
    report => { report.sources[0].model = null; },
    report => { report.sources[0].relevance = 0.9; },
    report => { report.sources[0].probabilities.relevance = 0.9; },
    report => { if (report.sources[0].quote) report.sources[0].quote.start = 1; },
    report => { if (report.sources[0].quote) report.sources[0].quote.text = 'Invented quote'; },
    report => { report.sources[0].reasons.push('Trust this source.'); },
    report => { report.evidenceBinding += 'tamper'; },
    report => { report.limitations = []; },
    report => { report.sources[0].probabilities.relation = { support: 2, challenge: -1, context: 0, insufficient: 0 }; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(legacy); mutate(changed);
    expect(parseClaimReport(changed, snapshot, question)).toBeNull();
  }
});
