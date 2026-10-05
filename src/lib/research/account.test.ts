import { expect, it } from 'vitest';
import { savedTopicFixture } from './saved-topic-fixture';
import { researchAccount } from './account';

it('withholds an account when relevance is unassessed, and never promotes a mismatched quote', () => {
  const { claimReport, caseRecord } = savedTopicFixture('account-test');
  expect(researchAccount(claimReport, caseRecord).sources).toEqual([]);
  const source = claimReport.sources[0];
  source.relevance = 0.95;
  if (!source.quote) throw new Error('The fixture must contain a retained quote');
  source.quote.text = 'An assertion not present in the retained evidence';
  expect(researchAccount(claimReport, caseRecord).sources).toEqual([]);
});

it('keeps a bound lead visibly separate from inspected page text, without changing the saved report', () => {
  const { claimReport, caseRecord } = savedTopicFixture('account-test');
  const source = claimReport.sources[0];
  source.relevance = 0.95;
  const before = JSON.stringify({ claimReport, caseRecord });
  const account = researchAccount(claimReport, caseRecord);
  expect(account.sources).toHaveLength(1);
  expect(account.sources[0].passage).toBe(source.quote?.text);
  expect(account.sources[0].evidence.id).toBe(source.evidenceId);
  expect(account.headline).toBe('What the sources say.');
  expect(account.supporting).toEqual([]);
  expect(JSON.stringify({ claimReport, caseRecord })).toBe(before);
});
