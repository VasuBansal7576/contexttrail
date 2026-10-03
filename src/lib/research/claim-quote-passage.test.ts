import { describe, expect, it } from 'vitest';
import type { CaseEvidence } from '../cases/model';
import type { QuoteReference } from './claim-report';
import { selectClaimQuotePassage } from './claim-quote-passage';

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
