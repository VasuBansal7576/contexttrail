/** Keep the original search and news question. The document search removes only
 * closed grammatical filler, preserving entities, negation, quantifiers and dates. */
const filler = new Set('a an and are as at be being by can did do does for from had has have how in is it its of on or so that the their this to was were what when where which who why will with would evidence shows show quickly distinguishes explanations'.split(' '));
function searchSubject(question: string): string {
  const [primary, secondary] = question.split(/\band (?:which|what|where|when)\b/i);
  return /^(?:did|does|has|have|is|are|was|were)\b/i.test(question.trim()) && secondary && !/\d/.test(secondary) ? primary : question;
}
export function documentQuery(question: string): string {
  const documentary = /^(?:why|how|when|what (?:factors|led|caused|changed|explains))\b/i.test(question.trim());
  const suffix = documentary ? '(data OR statistics OR study OR "annual report")' : '(statement OR clarification OR "press release" OR correction)';
  // Short questions already work as source-search queries. Preserve their wording.
  if (!documentary && question.length <= 100 && !/\b(?:did|does|has|have|is|are|was|were)\b.*\band (?:which|what|where|when)\b/i.test(question)) return `${question} ${suffix}`;
  const primary = searchSubject(question);
  const tokens = primary.match(/\d[\d,]*(?:\.\d+)?|[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
  const wanted = tokens.filter(token => !filler.has(token.toLowerCase()));
  return `${wanted.length ? wanted.join(' ') : question} ${suffix}`;
}

export type ResearchFocus = 'general' | 'news' | 'brand' | 'reviews' | 'attribution' | 'shopping';
/** Routes the user's wording, without classifying a person, product or claim as deceptive. */
export function researchFocus(question: string): ResearchFocus {
  if (/\b(?:reviews|ratings?|testimonials?|complaints?|(?:customer|fake|paid|hotel|product) review)\b/i.test(question)) return 'reviews';
  if (/\b(?:authorship|attribution|stolen|plagiari(?:sm|sed|zed)|reposted|copyright|who (?:made|created|photographed))\b/i.test(question)) return 'attribution';
  if (/\b(?:advertised|received|delivered|mismatch|clothing|fabric|wrong product|shopping)\b/i.test(question)) return 'shopping';
  if (/\b(?:brand|recall|product safety|company claims)\b/i.test(question)) return 'brand';
  if (/^(?:claim|check this claim)\s*:/i.test(question)) return 'news';
  if (/^(?:did|does|has|have|is|are|was|were)\b/i.test(question.trim())) return 'news';
  return 'general';
}
export interface ResearchSearch { engine: 'google' | 'google_news'; q: string; kind: 'google_search' | 'google_news'; purpose: string }
function keywords(question: string): string {
  const tokens = searchSubject(question.replace(/^(?:claim|check this claim)\s*:/i, '')).match(/\d[\d,]*(?:\.\d+)?|[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
  return tokens.filter(token => !filler.has(token.toLowerCase())).join(' ').slice(0, 350) || question;
}
/** Additional searches have distinct evidence goals; failed searches are never silently retried. */
export function followupSearches(question: string, focus = researchFocus(question)): ResearchSearch[] {
  const base = keywords(question);
  const suffixes: Record<ResearchFocus, Array<[string, string]>> = {
    general: [['(history OR timeline OR launch)', 'earlier history'], ['(study OR research) (causes OR adoption OR mechanisms)', 'explanations and research'], ['("original data" OR "primary source" OR "official statistics") (methodology OR limitations)', 'underlying measurements and limitations']],
    news: [['(data OR statistics OR official) (monthly OR report)', 'underlying data'], ['(clarification OR correction OR factcheck)', 'corrections and opposing evidence'], ['(statement OR methodology OR source)', 'original statement and methods']],
    brand: [['(statement OR recall OR regulator)', 'brand and regulator records'], ['(independent OR test OR complaint)', 'independent tests and complaints'], ['(response OR clarification OR correction)', 'responses and changed claims']],
    reviews: [['(regulator OR investigation OR settlement) reviews', 'substantiated review practices'], ['(verified purchase OR platform policy OR authenticity) reviews', 'review provenance and platform rules'], ['(complaints OR positive experiences OR response)', 'experiences and responses']],
    attribution: [['(original OR author OR first published)', 'earlier appearances and attribution'], ['(archive OR portfolio OR publication) attribution', 'dated attribution records'], ['(licence OR permission OR credit)', 'rights and attribution claims']],
    shopping: [['(specifications OR material OR size guide)', 'advertised product specification'], ['(returns OR complaints OR batch)', 'received-product experiences'], ['(test OR response OR refund)', 'tests and seller responses']],
  };
  return suffixes[focus].map(([suffix, purpose]) => ({ engine: 'google', kind: 'google_search', q: `${base} ${suffix}`, purpose }));
}
