/** Explicit page-owned media references only; never a sweep of arbitrary JSON URLs. */
import { JSDOM } from 'jsdom';
import type { SourceLink } from './source-links';
import { retainableSourceUrl } from './source-reference';
import { bindFetchedSource } from './source-binding';
import { hasHistoricalMediaCue } from './historical-media-cue';

const MAX_SCRIPT_BYTES = 524288;
const MAX_JSON_SCRIPTS = 8;
const MAX_VISITED_NODES = 512;
const MAX_DEPTH = 8;
const MAX_CARDS = 16;
const MAX_ITEMS = 64;
const SUPPORT_CAP = 1200;
const excluded = 'nav, header, footer, aside, [role="navigation"], [hidden], [aria-hidden="true"]';
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function supportText(el: Element): string | null {
  const text = (el.textContent ?? '').trim();
  return text && text.length <= SUPPORT_CAP ? text : null;
}
function key(text: string): string { return text.replace(/\s+/g, ' ').trim(); }

export type ReadableReferenceIndex = ReadonlyMap<string, ReadonlySet<string>>;

/** Index joint paragraph/resource ownership once for the chosen article. */
export function indexReadableReferences(readable: Document | null, pageUrl: string): ReadableReferenceIndex {
  const index = new Map<string, Set<string>>();
  if (!readable) return index;
  const supports = new WeakMap<Element, string | null>();
  for (const el of readable.querySelectorAll('a[href], iframe[src]')) {
    if (el.closest(excluded)) continue;
    const retainedContainer = el.closest('p, blockquote, figure');
    if (!retainedContainer) continue;
    if (!supports.has(retainedContainer)) supports.set(retainedContainer, supportText(retainedContainer));
    const support = supports.get(retainedContainer);
    if (!support) continue;
    const raw = el.getAttribute(el.tagName === 'IFRAME' ? 'src' : 'href');
    if (!raw) continue;
    try {
      const url = retainableSourceUrl(new URL(raw, pageUrl).toString());
      if (!url) continue;
      const normalized = key(support), urls = index.get(normalized) ?? new Set<string>();
      urls.add(url);
      index.set(normalized, urls);
    } catch { /* malformed reference */ }
  }
  return index;
}

/** The same complete paragraph/container must retain both support and resource. */
export function readableReferenceSurvives(support: string, url: string, index: ReadableReferenceIndex): boolean {
  return index.get(key(support))?.has(url) ?? false;
}

function uniqueElement(doc: Document, id: string): Element | null {
  const matches = [...doc.querySelectorAll('[id]')].filter(el => el.id === id);
  return matches.length === 1 ? matches[0] : null;
}
interface BoundStory { cards: unknown[]; scriptIndex: number; path: string }

export function extractStructuredSourceLinks(doc: Document, pageUrl: string, readable: Document | null, offset: number): SourceLink[] {
  if (!readable) return [];
  const stories: BoundStory[] = [];
  let scripts = 0, visited = 0;
  let incomplete = false;
  const walk = (value: unknown, scriptIndex: number, path: string, depth: number): void => {
    if (!object(value) && !Array.isArray(value)) return;
    if (visited >= MAX_VISITED_NODES || depth > MAX_DEPTH || path.length > 1024) { incomplete = true; return; }
    visited++;
    if (object(value) && Array.isArray(value.cards)) {
      // A recognized story is its own binding boundary. No child story or
      // recommendation can inherit the URL of an enclosing story.
      if (typeof value.url === 'string' && /^https?:/i.test(value.url)) {
        const binding = bindFetchedSource(pageUrl, value.url);
        const canonicalSafe = [value['canonical-url'], value.canonicalUrl].every(canonical => {
          if (typeof canonical !== 'string' || !canonical.trim()) return true;
          const ownBinding = bindFetchedSource(pageUrl, canonical);
          return ownBinding === 'same_resource' || ownBinding === 'normalized_resource';
        });
        if ((binding === 'same_resource' || binding === 'normalized_resource') && canonicalSafe) stories.push({ cards: value.cards, scriptIndex, path });
      }
    }
    if (Array.isArray(value) && value.length > MAX_ITEMS) { incomplete = true; return; }
    const children = Array.isArray(value) ? value.map((child, index) => [String(index), child] satisfies [string, unknown]) : Object.entries(value);
    if (children.length > MAX_ITEMS) { incomplete = true; return; }
    for (const [name, child] of children) walk(child, scriptIndex, `${path}/${name.replace(/~/g, '~0').replace(/\//g, '~1')}`, depth + 1);
  };
  for (const [scriptIndex, script] of [...doc.querySelectorAll('script')].entries()) {
    if (script.getAttribute('type')?.trim().toLowerCase() !== 'application/json') continue;
    if (scripts++ >= MAX_JSON_SCRIPTS) { incomplete = true; break; }
    const text = script.textContent ?? '';
    if (text.length > MAX_SCRIPT_BYTES || new TextEncoder().encode(text).length > MAX_SCRIPT_BYTES) { incomplete = true; continue; }
    try { const value: unknown = JSON.parse(text); walk(value, scriptIndex, '', 0); } catch { incomplete = true; }
  }
  // A skipped branch/script can hide another owner. A partial scan never
  // proves that the one observed story is the only page-bound story.
  if (incomplete || stories.length !== 1) return [];
  const story = stories[0], out: SourceLink[] = [];
  if (story.cards.length > MAX_CARDS) return [];
  const cards = story.cards;
  // Validate every recognized item collection before producing any result;
  // a later oversized card cannot leave an earlier partial story accepted.
  if (cards.some(card => object(card) && Array.isArray(card['story-elements']) && card['story-elements'].length > MAX_ITEMS)) return [];
  const originalSupportCounts = new Map<string, number>();
  for (const paragraph of doc.querySelectorAll('p, blockquote, figure')) {
    const text = supportText(paragraph);
    if (!text) continue;
    const normalized = key(text);
    // Wrappers around the same complete paragraph are one passage. Count
    // its deepest representative while keeping separate sibling/card
    // repetitions as independent owners, even when their text is identical.
    if ([...paragraph.querySelectorAll('p, blockquote, figure')].some(child => key(supportText(child) ?? '') === normalized)) continue;
    originalSupportCounts.set(normalized, (originalSupportCounts.get(normalized) ?? 0) + 1);
  }
  const readableSupports = new Set([...readable.querySelectorAll('p, blockquote, figure')].map(el => key(supportText(el) ?? '')).filter(Boolean));
  for (const [cardIndex, card] of cards.entries()) {
    if (!object(card) || typeof card.id !== 'string' || !card.id || card.id.length > 200 || !Array.isArray(card['story-elements'])) continue;
    if (story.cards.filter(item => object(item) && item.id === card.id).length !== 1) continue;
    const originalCard = uniqueElement(doc, card.id);
    if (!originalCard || originalCard.closest(excluded)) continue;
    const originalSupports = new Set([...originalCard.querySelectorAll('p, blockquote, figure')].map(el => key(supportText(el) ?? '')).filter(Boolean));
    const items = card['story-elements'];
    for (const [itemIndex, item] of items.entries()) {
      // Scan the bounded card/item collection completely. The caller owns
      // URL deduplication and the shared cap with historical replacement.
      if (!object(item) || typeof item.type !== 'string' || !/^(?:video|youtube-video|video-embed|embedded-video)$/.test(item.type)) continue;
      const previous = items[itemIndex - 1];
      if (!object(previous) || previous.type !== 'text' || typeof previous.text !== 'string' || previous.text.length > 10000) continue;
      const field = typeof item.url === 'string' ? 'url' : 'embed-url';
      const raw = item[field];
      if (typeof raw !== 'string' || !/^https?:/i.test(raw)) continue;
      const url = retainableSourceUrl(raw);
      if (!url || url === retainableSourceUrl(pageUrl)) continue;
      const supportDoc = new JSDOM(previous.text).window.document;
      const paragraphs = [...supportDoc.querySelectorAll('p, blockquote, figure')];
      const closest = paragraphs[paragraphs.length - 1];
      // Only this immediately adjacent text item may supply support. The
      // whole visible paragraph is retained; no topic/date synthesis occurs.
      // Choose before checking retention/size: an unavailable later paragraph
      // cannot cause an earlier historical paragraph to attach to this embed.
      if (!closest) continue;
      const supportingText = supportText(closest);
      // Readability may remove the card wrapper. Unique original paragraph
      // ownership and that same retained paragraph preserve the card binding.
      if (!supportingText || !originalSupports.has(key(supportingText)) || !readableSupports.has(key(supportingText))
        || originalSupportCounts.get(key(supportingText)) !== 1) continue;
      out.push({ url, text: '', supportingText, historicalLead: hasHistoricalMediaCue(supportingText), location: {
        element: 'structured_embed', index: offset + out.length, scriptIndex: story.scriptIndex,
        jsonPath: `${story.path}/cards/${cardIndex}/story-elements/${itemIndex}/${field}`,
      } });
    }
  }
  return out;
}
