import { expect, it } from 'vitest';
import { documentQuery } from './search-plan';
it('keeps date bounds and the named topic while searching research documents for an open question', () => {
  const query = documentQuery('Why did UPI adoption grow so quickly in India, and what evidence shows how its use changed from 2016 to 2025?');
  for (const token of ['UPI','adoption','India','2016','2025']) expect(query).toContain(token);
  expect(query).toContain('annual report');
  expect(query).not.toContain('clarification');
});
it('does not remove negation or universal quantifiers from a claim search', () => {
  const query = documentQuery('Claim: All reviews for the hotel are not independent, including reviews in 2025 and 2026.');
  expect(query).toContain('All'); expect(query).toContain('not'); expect(query).toContain('2025'); expect(query).toContain('2026');
});
it('preserves a short news question and its clarification query without inventing an institution URL', () => {
  const question='Is ISRO being privatised? What changed in August–September 2026?';
  expect(documentQuery(question)).toBe(`${question} (statement OR clarification OR "press release" OR correction)`);
});
