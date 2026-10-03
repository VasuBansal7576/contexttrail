import type { CaseEvidence } from '../cases/model';
import type { QuoteReference } from './claim-report';

export type ClaimQuotePassage =
  | { kind: 'unchanged'; quote: QuoteReference; original: null }
  | { kind: 'selected'; quote: QuoteReference; original: QuoteReference }
  | { kind: 'navigation_only'; quote: null; original: QuoteReference }
  | { kind: 'unbound'; quote: null; original: null };

const localizedLoginCluster = /^Виж какво се случва и се присъедини към разговора\s*Continue with phone\s*или\s*Влизане с потребителско име или имейл\s*Подходящи хора\s*/u;
const localizedProfileHeader = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,49}@[A-Za-z0-9_]{1,15}\s*Следване\s*/u;
const localizedProfileFooter = /Тренд в момента\s*Условия\s*Поверителност\s*Бисквитки\s*Достъпност\s*Информация за рекламите\s*©\s*\d{4}\s*X Corp\.\s*$/u;
const observedPlatformDescription = /^Mobile-first digital platform - objective, contextual, factual, informative, catering to all sets of audiences\.\s*(?:https:\/\/t\.co\/[A-Za-z0-9]{1,32})?$/u;

function isXPostSource(sourceUrl: string): boolean {
  try {
    const url = new URL(sourceUrl);
    return url.protocol === 'https:' && !url.username && !url.password
      && ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname)
      && /^\/[^/]+\/status\/\d+\/?$/.test(url.pathname);
  } catch { return false; }
}

/** A closed observed profile-card shape, not a language or assertion detector.
 * Unknown bios or any additional source words remain available as an exact quote.
 */
function isLocalizedProfileChrome(text: string): boolean {
  if (text.length > 1024) return false;
  const header = localizedProfileHeader.exec(text)?.[0];
  const footer = localizedProfileFooter.exec(text);
  if (!header || !footer || footer.index < header.length) return false;
  const description = text.slice(header.length, footer.index).trim();
  return !description || observedPlatformDescription.test(description);
}

/** Display selection only: retained evidence, model input and assessment stay intact.
 * Recognized login clusters are a narrow navigation cue, not an assertion
 * detector. Unknown prefixes and arbitrary profile/source words remain exact.
 */
export function selectClaimQuotePassage(quote: QuoteReference | null, evidence: CaseEvidence | undefined): ClaimQuotePassage {
  if (!quote || !evidence || evidence.id !== quote.evidenceId || evidence.content.kind !== 'text'
    || evidence.content.attribution !== quote.attribution || !Number.isInteger(quote.start) || !Number.isInteger(quote.end)
    || quote.start < 0 || quote.end < quote.start || quote.end > evidence.content.text.length
    || evidence.content.text.slice(quote.start, quote.end) !== quote.text) return { kind: 'unbound', quote: null, original: null };
  const unchanged: ClaimQuotePassage = { kind: 'unchanged', quote, original: null };
  if (quote.attribution !== 'page_quote') return unchanged;
  const localizedPrefix = isXPostSource(evidence.sourceUrl) ? localizedLoginCluster.exec(quote.text)?.[0] : undefined;
  const prefix = localizedPrefix ?? /^(?:(?:post\s*)?log\s+in\s*sign\s+up\s*){2,}/i.exec(quote.text)?.[0];
  if (!prefix) return unchanged;
  const remainder = quote.text.slice(prefix.length);
  // Do not split a possible source word such as "upgrades" at "up".
  if (/^\p{Ll}/u.test(remainder) && !/\s$/.test(prefix)) return unchanged;
  if (!remainder.trim() || (localizedPrefix && isLocalizedProfileChrome(remainder))) return { kind: 'navigation_only', quote: null, original: quote };
  return { kind: 'selected', quote: { ...quote, start: quote.start + prefix.length, text: remainder }, original: quote };
}
