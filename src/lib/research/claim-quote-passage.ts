import type { CaseEvidence } from '../cases/model';
import type { QuoteReference } from './claim-report';

export type ClaimQuotePassage =
  | { kind: 'unchanged'; quote: QuoteReference; original: null }
  | { kind: 'selected'; quote: QuoteReference; original: QuoteReference }
  | { kind: 'navigation_only'; quote: null; original: QuoteReference }
  | { kind: 'unbound'; quote: null; original: null };

/** Display selection only: retained evidence, model input and assessment stay intact.
 * Repeated login/signup clusters are a narrow navigation cue, not an assertion
 * detector. Unknown prefixes and source words elsewhere remain unchanged.
 */
export function selectClaimQuotePassage(quote: QuoteReference | null, evidence: CaseEvidence | undefined): ClaimQuotePassage {
  if (!quote || !evidence || evidence.id !== quote.evidenceId || evidence.content.kind !== 'text'
    || evidence.content.attribution !== quote.attribution || !Number.isInteger(quote.start) || !Number.isInteger(quote.end)
    || quote.start < 0 || quote.end < quote.start || quote.end > evidence.content.text.length
    || evidence.content.text.slice(quote.start, quote.end) !== quote.text) return { kind: 'unbound', quote: null, original: null };
  const unchanged: ClaimQuotePassage = { kind: 'unchanged', quote, original: null };
  if (quote.attribution !== 'page_quote') return unchanged;
  const prefix = /^(?:(?:post\s*)?log\s+in\s*sign\s+up\s*){2,}/i.exec(quote.text)?.[0];
  if (!prefix) return unchanged;
  const remainder = quote.text.slice(prefix.length);
  // Do not split a possible source word such as "upgrades" at "up".
  if (/^\p{Ll}/u.test(remainder) && !/\s$/.test(prefix)) return unchanged;
  if (!remainder.trim()) return { kind: 'navigation_only', quote: null, original: quote };
  return { kind: 'selected', quote: { ...quote, start: quote.start + prefix.length, text: remainder }, original: quote };
}
