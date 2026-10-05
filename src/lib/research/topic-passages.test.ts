import { expect, it } from 'vitest';
import { topicPassages } from './topic-passages';
it('retains numerical scope and separate explanatory passages without title or snippet synthesis', () => {
  const paragraphs = ['Subscribe to our newsletter.', 'UPI processed 24 billion transactions in August 2026.', 'UPI adoption grew with interoperable payment acceptance.', 'UPI adoption reduced payment friction.', 'UPI adoption reduced payment friction.'];
  const result = topicPassages('Why did UPI adoption grow, and did UPI process 24 billion transactions in August 2026?', paragraphs);
  expect(result).toContain(paragraphs[1]);
  expect(result?.split('\n\n')).toHaveLength(3);
  expect(result).not.toContain('newsletter');
  for (const passage of result?.split('\n\n') ?? []) expect(paragraphs).toContain(passage);
});
it('supports non-Latin questions and keeps wholly unrelated pages unread as evidence', () => {
  expect(topicPassages('Как се промени програмата?', ['Програмата се промени през 2025 година.'])).toBe('Програмата се промени през 2025 година.');
  expect(topicPassages('Coral recovery measurements', ['Unrelated subscription information.'])).toBeNull();
  expect(topicPassages('Coral recovery', ['Coral recovery '.repeat(500)])?.length).toBeLessThanOrEqual(2400);
});
