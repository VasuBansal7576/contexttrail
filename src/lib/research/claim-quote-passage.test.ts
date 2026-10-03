import { describe, expect, it } from 'vitest';
import type { CaseEvidence } from '../cases/model';
import type { QuoteReference } from './claim-report';
import { selectClaimQuotePassage } from './claim-quote-passage';
import { localizedLoginPrefix, localizedProfile, localizedFooter, localizedNavigationQuote, localizedSourceUrl } from './claim-quote-passage-fixture';

const prefix = 'PostLog inSign upPostLog inSign up';
const body = 'Synthetic publisher: “A substantive source passage about the launch programme.”';
function fixture(text: string, start = 0, end = text.length, attribution: QuoteReference['attribution'] = 'page_quote') {
  const evidence: CaseEvidence = { id: 'source', sourceUrl: 'https://publisher.example.org/item', title: 'Synthetic source',
    content: { kind: 'text', text, attribution }, publicationDate: { status: 'unknown', reason: 'Synthetic unknown date' },
    provenance: { method: 'page_extraction', toolVersion: null, capturedAt: null, retrievedAt: null, rights: 'public_reference', retention: 'reference_only', contentHash: null } };
  const quote: QuoteReference = { evidenceId: evidence.id, start, end, text: text.slice(start, end), attribution };
  return { evidence, quote };
}
describe('exact display passages without modifying assessed evidence', () => {
  it('keeps the exact bound localized X profile/login/trends excerpt as an inspectable lead', () => {
    const { evidence, quote } = fixture(localizedNavigationQuote);
    evidence.sourceUrl = localizedSourceUrl;
    const before = JSON.stringify({ evidence, quote });
    expect(quote.end).toBe(378);
    expect(selectClaimQuotePassage(quote, evidence)).toEqual({ kind: 'navigation_only', quote: null, original: quote });
    expect(JSON.stringify({ evidence, quote })).toBe(before);
  });
  it('recognizes the bounded profile structure without depending on an account identity', () => {
    for (const profile of [localizedProfile.replace('NewsDrum@thenewsdrum', 'Друг профил@other_account'), 'Друг профил@other_accountСледване']) {
      const { evidence, quote } = fixture(localizedLoginPrefix + profile + localizedFooter);
      evidence.sourceUrl = 'https://twitter.com/other_account/status/123456789?lang=bg';
      expect(selectClaimQuotePassage(quote, evidence)).toEqual({ kind: 'navigation_only', quote: null, original: quote });
    }
  });
  it.each([
    'ИСРО заяви: „Няма да бъдем приватизирани.“',
    'इसरो ने कहा कि उसका निजीकरण नहीं होगा।',
    'The agency says its public role continues. ИСРО потвърди това.',
  ])('preserves a multilingual assertion following the recognized login controls: %s', assertion => {
    const { evidence, quote } = fixture(localizedLoginPrefix + assertion);
    evidence.sourceUrl = localizedSourceUrl;
    expect(selectClaimQuotePassage(quote, evidence)).toEqual({ kind: 'selected', quote: { ...quote, start: localizedLoginPrefix.length, text: assertion }, original: quote });
  });
  it.each([
    localizedProfile + 'ИСРО заяви: „Няма да бъдем приватизирани.“' + localizedFooter,
    localizedProfile.replace('Mobile-first digital platform', 'ИСРО остава държавна агенция. Mobile-first digital platform') + localizedFooter,
    localizedProfile.replace('catering to all sets of audiences.', 'catering to all sets of audiences. ISRO remains public.') + localizedFooter,
    localizedProfile + localizedFooter + 'ИСРО остава държавна агенция.',
    localizedProfile + localizedFooter.replace('Бисквитки', ''),
    'Непознат профил@accountСледванеСъдържание на източника.' + localizedFooter,
  ])('does not discard unknown or asserted profile/body text: %s', remainder => {
    const { evidence, quote } = fixture(localizedLoginPrefix + remainder);
    evidence.sourceUrl = localizedSourceUrl;
    expect(selectClaimQuotePassage(quote, evidence)).toEqual({ kind: 'selected', quote: { ...quote, start: localizedLoginPrefix.length, text: remainder }, original: quote });
  });
  it('does not treat Bulgarian words, a partial control cluster or another site as X navigation', () => {
    for (const text of ['Виж какво се случва. ИСРО заяви, че остава държавна агенция.', localizedLoginPrefix.replace('Continue with phone', 'Continue with email') + body, localizedLoginPrefix + 'та описват програмата.']) {
      const { evidence, quote } = fixture(text);
      evidence.sourceUrl = localizedSourceUrl;
      expect(selectClaimQuotePassage(quote, evidence)).toEqual({ kind: 'unchanged', quote, original: null });
    }
    const other = fixture(localizedNavigationQuote);
    for (const sourceUrl of ['https://x.com.evil.example/account/status/123', 'https://x.com/account/profile', 'https://publisher.example/?source=x.com', 'not a URL']) {
      other.evidence.sourceUrl = sourceUrl;
      expect(selectClaimQuotePassage(other.quote, other.evidence).kind).toBe('unchanged');
    }
  });
  it('keeps localized chrome ownership and absolute UTF-16 offsets inside the assessed quote', () => {
    const leading = '😀 Retained outside the assessed quote. ';
    const assertion = 'ИСРО: „Нашата мисия 🚀 продължава.“';
    const { evidence, quote } = fixture(leading + localizedLoginPrefix + assertion + ' Outside.', leading.length, leading.length + localizedLoginPrefix.length + assertion.length);
    evidence.sourceUrl = localizedSourceUrl;
    const selected = selectClaimQuotePassage(quote, evidence);
    expect(selected).toMatchObject({ kind: 'selected', quote: { start: leading.length + localizedLoginPrefix.length, end: quote.end, text: assertion } });
    if (!selected.quote) throw new Error('Missing exact assertion');
    expect(evidence.content.kind === 'text' && evidence.content.text.slice(selected.quote.start, selected.quote.end)).toBe(assertion);
    const malformed = { ...quote, text: localizedNavigationQuote };
    expect(selectClaimQuotePassage(malformed, evidence).kind).toBe('unbound');
    for (const attribution of ['search_snippet', 'classification_context'] satisfies QuoteReference['attribution'][]) {
      const other = fixture(localizedNavigationQuote, 0, localizedNavigationQuote.length, attribution);
      other.evidence.sourceUrl = localizedSourceUrl;
      expect(selectClaimQuotePassage(other.quote, other.evidence).kind).toBe('unchanged');
    }
  });
  it.each([prefix, 'Log in Sign up Log in Sign up\n', 'POSTLog inSign upPOSTLog inSign up'])('selects after the recognized repeated navigation cluster %s', navigation => {
    const { evidence, quote } = fixture(navigation + body);
    const before = structuredClone({ evidence, quote });
    const selected = selectClaimQuotePassage(quote, evidence);
    expect(selected).toMatchObject({ kind: 'selected', quote: { start: navigation.length, end: navigation.length + body.length, text: body }, original: quote });
    expect({ evidence, quote }).toEqual(before);
  });
  it('uses absolute UTF-16 offsets without finding an earlier repeated body or rewriting punctuation/whitespace', () => {
    const selectedBody = `Synthetic publisher: “Launch 🚀 update.”  \n`;
    const leading = `😀 ${selectedBody}\n`;
    const text = leading + prefix + selectedBody + 'Outside the assessed excerpt.';
    const { evidence, quote } = fixture(text, leading.length, leading.length + prefix.length + selectedBody.length);
    const selected = selectClaimQuotePassage(quote, evidence);
    if (!selected.quote) throw new Error('Missing exact selected passage');
    expect(selected.quote).toMatchObject({ start: leading.length + prefix.length, end: quote.end, text: selectedBody });
    expect(text.slice(selected.quote.start, selected.quote.end)).toBe(selected.quote.text);
  });
  it.each([
    'The source says “Log in” before describing its programme.',
    'Log in to inspect the archived source, then sign up for updates.',
    'PostLog inSign upSynthetic publisher: “One ambiguous navigation cluster.”',
    prefix + 'grades the system; these words are a possible continuous source phrase.',
    'Unrecognized navigation controls. ' + body,
  ])('preserves legitimate words and ambiguous or unrecognized prefixes: %s', text => {
    const { evidence, quote } = fixture(text);
    expect(selectClaimQuotePassage(quote, evidence)).toEqual({ kind: 'unchanged', quote, original: null });
  });
  it('does not upgrade a search snippet or classification context into a clean page quotation', () => {
    for (const attribution of ['search_snippet', 'classification_context'] satisfies QuoteReference['attribution'][]) {
      const { evidence, quote } = fixture(prefix + body, 0, prefix.length + body.length, attribution);
      expect(selectClaimQuotePassage(quote, evidence)).toEqual({ kind: 'unchanged', quote, original: null });
    }
  });
  it('keeps a navigation-only excerpt inspectable as a lead without inventing a substantive quotation', () => {
    const { evidence, quote } = fixture(prefix + ' \n');
    expect(selectClaimQuotePassage(quote, evidence)).toEqual({ kind: 'navigation_only', quote: null, original: quote });
  });
  it('withholds display selection for unbound or malformed quote coordinates', () => {
    const { evidence, quote } = fixture(prefix + body);
    const malformed = [
      { ...quote, evidenceId: 'another-source' }, { ...quote, start: -1 }, { ...quote, start: 0.5 },
      { ...quote, end: evidence.content.kind === 'text' ? evidence.content.text.length + 1 : 0 },
      { ...quote, text: 'Invented source words.' }, { ...quote, attribution: 'search_snippet' as const },
    ];
    for (const wrong of malformed) expect(selectClaimQuotePassage(wrong, evidence)).toEqual({ kind: 'unbound', quote: null, original: null });
    expect(selectClaimQuotePassage(quote, undefined).kind).toBe('unbound');
    expect(selectClaimQuotePassage(null, evidence).kind).toBe('unbound');
  });
});
