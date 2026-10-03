import { retainableSourceUrl } from './source-reference';
import { hasHistoricalMediaCue } from './historical-media-cue';

export interface SourceLink {
  url: string;
  text: string;
  supportingText: string;
  /** Document-order index, inspectable against the retained fetched URL. */
  location: { element: 'anchor' | 'embed'; index: number };
  historicalLead: boolean;
}

export const MAX_SOURCE_LINKS = 12;
const SUPPORT_CAP = 1200;

/** Retain source references in article paragraphs/embeds, never navigation.
 * Temporal language only selects a lead; no date is assigned from this text.
 * The HTML base element is deliberately ignored; links resolve at the fetched URL.
 */
export function extractSourceLinks(doc: Document, pageUrl: string): SourceLink[] {
  const out: SourceLink[] = [];
  const elements = doc.querySelectorAll('a[href], iframe[src]');
  for (let index = 0; index < elements.length; index += 1) {
    const el = elements[index];
    if (el.closest('nav, header, footer, aside, [role="navigation"]')) continue;
    const container = el.closest('p, blockquote, figure');
    if (!container || !container.closest('article, main, [role="main"]')) continue;
    const supportingText = (container.textContent ?? '').trim();
    // Keep complete bounded support instead of truncating away the actual link.
    if (!supportingText || supportingText.length > SUPPORT_CAP) continue;
    const raw = el.getAttribute(el.tagName === 'IFRAME' ? 'src' : 'href');
    if (!raw || raw.startsWith('#')) continue;
    let resolved: string;
    try { resolved = new URL(raw, pageUrl).toString(); } catch { continue; }
    const url = retainableSourceUrl(resolved);
    if (!url || url === retainableSourceUrl(pageUrl)) continue;
    const historicalLead = hasHistoricalMediaCue(supportingText);
    const link: SourceLink = { url, text: (el.textContent ?? el.getAttribute('title') ?? '').trim().slice(0, 400), supportingText,
      location: { element: el.tagName === 'IFRAME' ? 'embed' : 'anchor', index }, historicalLead };
    const duplicate = out.findIndex(candidate => candidate.url === url);
    if (duplicate >= 0) {
      if (historicalLead && !out[duplicate].historicalLead) out[duplicate] = link;
      continue;
    }
    if (out.length < MAX_SOURCE_LINKS) out.push(link);
    else if (historicalLead) {
      for (let replace = out.length - 1; replace >= 0; replace -= 1) {
        if (!out[replace].historicalLead) {
          out[replace] = link;
          break;
        }
      }
    }
  }
  return out.sort((a, b) => a.location.index - b.location.index);
}
