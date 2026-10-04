/** Retrieval priority only. A document cue is not authority, truth or corroboration. */
import type { EvidenceCandidate } from '../investigation/contracts/evidence';
import type { EvidenceDateSources } from '../investigation/dates';
import { retainableSourceUrl } from '../pages/source-reference';
import { AUTOMATIC_RESEARCH_LIMITS } from './automatic-contract';

export interface TopicCandidate {
  candidate: EvidenceCandidate;
  dates: EvidenceDateSources;
  search: number;
}
const stopWords = new Set('a an and are as at be being by can change changed changes did do does for from has have how in is it of on or research should that the their this to use uses used was were what when where which who why will with would january february march april may june july august september october november december'.split(' '));
function terms(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter(term => term.length >= 3 && !/^\d+$/.test(term) && !stopWords.has(term))
    // A bounded lexical screen handles simple inflections without judging claims.
    .map(term => term.length >= 6 ? term.slice(0, 6) : term));
}
export function originalAccountCue(topic: string, candidate: Pick<EvidenceCandidate, 'title' | 'snippet'>): number {
  const text = `${candidate.title ?? ''} ${candidate.snippet ?? ''}`;
  if (!/\b(?:clarification|statement|press release|policy overview|policy document|program overview|programme overview|we (?:announce|state|explain)|our policy)\b/i.test(text)) return 0;
  const coverage = questionCoverage(terms(topic), candidate);
  // Most question terms must match: a multiword institution name plus generic
  // policy boilerplate must not crowd out the actual conduct/tool being asked.
  // This is deliberately conservative and can miss paraphrased relevant leads.
  return coverage.matches >= 2 && coverage.tier === 'substantial' ? coverage.matches : 0;
}

/** Public document surfaces guide a read slot; they do not certify authority. */
export function documentSurfaceCue(topic: string, candidate: Pick<EvidenceCandidate, 'title' | 'snippet' | 'sourceUrl'>): number {
  const coverage = questionCoverage(terms(topic), candidate);
  const acronym = topic.match(/\b[A-Z][A-Z0-9]{1,8}\b/g) ?? [];
  const text = `${candidate.title ?? ''} ${candidate.snippet ?? ''}`;
  const acronymOverlap = acronym.some(term => new RegExp(`\\b${term}\\b`, 'i').test(text));
  const source = new URL(candidate.sourceUrl);
  const publicInstitution = /(?:\.gov(?:\.[a-z]{2})?|\.int)$/.test(source.hostname);
  const publication = /(?:^|\/)(?:publications?|reports?|statistics|bulletins?)(?:\/|view|\.|$)/i.test(source.pathname);
  const document = /\b(?:annual report|working paper|bulletin|statistical|statistics|empirical study|factsheet)\b/i.test(text);
  if (!acronymOverlap && !(publication && coverage.matches >= 1) && (coverage.matches < 2 || coverage.tier !== 'substantial')) return 0;
  // Public institution pages can be commentary, and report URLs can be misleading.
  // Prioritise inspection rather than asserting that they are primary evidence.
  return publicInstitution ? coverage.matches + 30 : publication ? coverage.matches + 20 : document ? coverage.matches + 10 : 0;
}

type CoverageTier = 'substantial' | 'partial' | 'none';
function questionCoverage(wanted: ReadonlySet<string>, candidate: Pick<EvidenceCandidate, 'title' | 'snippet'>): { matches: number; tier: CoverageTier } {
  const present = terms(`${candidate.title ?? ''} ${candidate.snippet ?? ''}`);
  const matches = [...wanted].filter(term => present.has(term)).length;
  return { matches, tier: matches === 0 ? 'none' : matches >= Math.ceil(wanted.size * 0.75) ? 'substantial' : 'partial' };
}

/** Balance surfaces within lexical tiers; absent overlap remains an eligible fallback. */
export function selectTopicSources(topic: string, entries: readonly TopicCandidate[]): TopicCandidate[] {
  const safe = entries.filter(entry => retainableSourceUrl(entry.candidate.sourceUrl) !== null);
  const wanted = terms(topic);
  const ranked = safe.map((entry, order) => ({ entry, order, ...questionCoverage(wanted, entry.candidate) }))
    .sort((a, b) => b.matches - a.matches || a.order - b.order);
  const selected: TopicCandidate[] = [];
  const cues = safe.map((entry, order) => ({ entry, order, score: Math.max(originalAccountCue(topic, entry.candidate), documentSurfaceCue(topic, entry.candidate)) }))
    .filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.order - b.order);
  // Two explicit documentary cues, then one exploratory read of a document
  // whose search metadata says little beyond "Annual Report". A missing
  // snippet is a reason to inspect a returned document, not to infer its
  // relevance or authority. The page must still pass binding and assessment.
  for (const item of cues) {
    if (selected.length === 2) break;
    if (selected.some(entry => new URL(entry.candidate.sourceUrl).hostname === new URL(item.entry.candidate.sourceUrl).hostname)) continue;
    selected.push(item.entry);
  }
  const metadataPoor = safe.find(entry => {
    const candidate = entry.candidate;
    return !candidate.snippet?.trim() && /^(?:annual report|publications?|reports?|statistics|bulletin)$/i.test(candidate.title?.trim() ?? '')
      && /(?:^|\/)(?:publications?|reports?|statistics|bulletins?)(?:\/|view|\.|$)/i.test(new URL(candidate.sourceUrl).pathname)
      && !selected.some(prior => new URL(prior.candidate.sourceUrl).hostname === new URL(candidate.sourceUrl).hostname);
  });
  if (metadataPoor) selected.push(metadataPoor);
  for (const item of cues) {
    if (selected.length === 3) break;
    if (!selected.some(entry => new URL(entry.candidate.sourceUrl).hostname === new URL(item.entry.candidate.sourceUrl).hostname)) selected.push(item.entry);
  }
  // A zero-overlap surface cannot spend a read slot ahead of an available
  // question-matching lead merely because its provider rank was higher.
  // Partial/absent matches can be paraphrases: keep them as fallbacks, not
  // semantic rejections. The returned order also owns the five page reads.
  for (const tier of ['substantial', 'partial', 'none'] satisfies CoverageTier[]) {
    // Balance equally relevant leads, not a one-word incidental hit against
    // a source addressing the entity and conduct. Provider diversity cannot
    // manufacture relevance or consume the limited page-reading slots.
    const levels = [...new Set(ranked.filter(item => item.tier === tier).map(item => item.matches))];
    for (const level of levels) {
      const groups = Array.from({ length: AUTOMATIC_RESEARCH_LIMITS.topicSearches }, (_, search) => ranked
        .filter(item => item.entry.search === search && item.tier === tier && item.matches === level).map(item => item.entry));
      for (let offset = 0; selected.length < AUTOMATIC_RESEARCH_LIMITS.topicSources && groups.some(group => offset < group.length); offset++) {
        for (const group of groups) {
          const entry = group[offset];
          if (entry && !selected.includes(entry) && selected.length < AUTOMATIC_RESEARCH_LIMITS.topicSources) selected.push(entry);
        }
      }
    }
  }
  return selected;
}
