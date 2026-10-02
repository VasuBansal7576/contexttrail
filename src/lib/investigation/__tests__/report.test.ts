import { describe, it, expect } from 'vitest';
import { deriveReport, auditUrl, readFailure } from '../report';
import { evaluateClaimPolicy } from '../policy';
import { ProviderError } from '../../providers/http';
import { makeCandidate, makeExact, makeJudgment, separateOrigin } from './testkit';
import type { TimelineItem } from '../contracts/investigation';

const coverage = { eligible: 0, selected: 0, comparedPairs: 0, displayedDatedCore: 0, comparedPairIds: [] };
const contradiction = () => makeJudgment({ claimRelation: { supports: 0, contradicts: .9, neutral: .05, insufficient: .05 } });
const report = (candidates: ReturnType<typeof makeCandidate>[], items: TimelineItem[] = [], claimMode = true) =>
  deriveReport({ candidates, items, coverage, earliestObservedOccurrence: null, claimMode });

describe('source-linked report without verdict inflation', () => {
  it('undated exact contradiction is explained while original remains unknown and status stays possible', () => {
    const c = makeExact({ judgment: contradiction() });
    const r = report([c]);
    expect(r.captionFindings[0].signals.some(s => s.kind === 'caption_contradiction')).toBe(true);
    expect(r.captionFindings[0].authority).toBe('not_established');
    expect(r.provenanceCompleteness.originalPublication.status).toBe('unknown');
    expect(r.provenanceCompleteness.datedCoreOccurrences).toBe(0);
    expect(evaluateClaimPolicy([c]).status).toBe('POSSIBLE_CONTEXT_CONFLICT');
  });
  it('keeps visual-lead contradiction explicitly ineligible even on a famous-looking domain', () => {
    const c = makeCandidate({ sourceUrl: 'https://institution.example/photo', judgment: contradiction(), publishedAt: '2000-01-01' });
    const r = report([c]);
    expect(r.captionFindings[0].policyEligibleIdentity).toBe(false);
    expect(r.captionFindings[0].authority).toBe('not_established');
    expect(r.sourceRoles[0].eventRole).toBe('unresolved');
    expect(evaluateClaimPolicy([c]).status).toBe('INSUFFICIENT_EVIDENCE');
  });
  it('does not turn a correction page displaying media into caption circulation or original publication', () => {
    const c = makeExact({ judgment: makeJudgment({ pageRole: { reporting: 0, factCheck: 1, socialRepost: 0, aggregator: 0, commentary: 0, other: 0 } }) });
    const role = report([c]).sourceRoles[0];
    expect(role.documentRole.basis).toBe('model_assessed');
    expect(role.eventRole).toBe('media_occurrence');
    expect(role.captionCirculation).toBe('unresolved');
    expect(role.correctionPublication).toBe('unresolved');
    expect(role.originalPublication).toBe('unresolved');
  });
  it('shared-origin corrections remain uncorroborated under unchanged policy', () => {
    const a = separateOrigin(makeExact({ judgment: contradiction() }), 'shared');
    const b = separateOrigin(makeExact({ judgment: contradiction() }), 'shared');
    expect(report([a, b]).captionFindings).toHaveLength(2);
    expect(evaluateClaimPolicy([a, b]).status).toBe('POSSIBLE_CONTEXT_CONFLICT');
  });
  it('retains conflicting source assessments instead of resolving the claim by counting', () => {
    const a = makeExact({ judgment: contradiction() });
    const b = makeExact({ judgment: makeJudgment() });
    expect(report([a,b]).captionFindings).toHaveLength(2);
    expect(report([a,b],[],false).captionFindings).toEqual([]);
  });
  it('requires relevance and preserves no-judgment uncertainty', () => {
    expect(report([makeExact(), makeExact({ judgment: makeJudgment({ relevance: .1 }) })]).captionFindings).toEqual([]);
    expect(report([makeExact()]).sourceRoles[0].documentRole.basis).toBe('unresolved');
  });
  it('does not invent verbatim text, entailment or original dates from snippets', () => {
    const c = makeExact({ judgment: contradiction(), snippet: 'Search says something' });
    const r = report([c]);
    expect(r.captionFindings[0].excerpt).toBeNull();
    expect(r.captionFindings[0].excerptEntailment).toBe('not_separately_verified');
    expect(r.pageReadAuditAvailable).toBe(false);
  });
  it('retains actual displayed excerpt attribution and distinct classification context', () => {
    const c = makeExact({ judgment: contradiction() });
    const item = { evidenceId: c.id, excerpt: 'Exact page paragraph.', excerptSource: 'page_text', classificationContext: 'Title plus paragraph' } as TimelineItem;
    const f = report([c], [item]).captionFindings[0];
    expect(f.excerpt).toBe(item.excerpt);
    expect(f.classificationContext).toBe(item.classificationContext);
  });
});

describe('bounded read audit sanitization', () => {
  it('drops credentials, query tokens and fragments and rejects unsupported schemes', () => {
    expect(auditUrl('https://user:secret@public.example/path?api_key=private#token')).toBe('https://public.example/path');
    expect(auditUrl('file:///private')).toBeNull();
  });
  it.each(['timeout','aborted','malformed','network','http'] as const)('retains only allowlisted %s category, never error text', kind => {
    const r = readFailure(new ProviderError(kind, 'secret resolver details', 403));
    expect(r.failureCode).toBe(kind);
    expect(r.httpStatus).toBe(kind === 'http' ? 403 : null);
    expect(JSON.stringify(r)).not.toContain('secret');
  });
  it('does not guess cause from arbitrary thrown errors or accept bogus status codes', () => {
    expect(readFailure(new Error('timeout at private address'))).toEqual({ failureCode: 'unknown', httpStatus: null });
    expect(readFailure(new ProviderError('http', 'private', 999)).httpStatus).toBeNull();
  });
});
