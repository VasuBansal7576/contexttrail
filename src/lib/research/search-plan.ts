/** Keep the original search and news question. The document search removes only
 * closed grammatical filler, preserving entities, negation, quantifiers and dates. */
const filler = new Set('a an and are as at be being by can did do does for from had has have how in is it its of on or so that the their this to was were what when where which who why will with would evidence shows show quickly'.split(' '));
export function documentQuery(question: string): string {
  const documentary = /^(?:why|how|when|what (?:factors|led|caused|changed|explains))\b/i.test(question.trim());
  const suffix = documentary ? '(data OR statistics OR study OR "annual report")' : '(statement OR clarification OR "press release" OR correction)';
  // Short questions already work as source-search queries. Preserve their wording.
  if (!documentary && question.length <= 100) return `${question} ${suffix}`;
  const tokens = question.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
  const wanted = tokens.filter(token => !filler.has(token.toLowerCase()));
  return `${wanted.length ? wanted.join(' ') : question} ${suffix}`;
}
