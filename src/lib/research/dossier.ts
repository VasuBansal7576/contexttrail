import type { CaseEvidence, CaseRecord } from '../cases/model';
import type { ClaimReport, QuoteReference } from './claim-report';
import { researchFocus, type ResearchFocus } from './search-plan';

export interface ResearchFacet { id: string; title: string; wanted: string; pattern: RegExp }
const facets: Record<ResearchFocus, ResearchFacet[]> = {
  general: [
    { id: 'history', title: 'How it developed', wanted: 'Dated accounts of the earlier history.', pattern: /\b(?:introduced|launched|started|since|history|inception|rollout|established)\b/i },
    { id: 'mechanisms', title: 'Explanations offered', wanted: 'Evidence explaining the mechanisms, beyond a trend or correlation.', pattern: /\b(?:because|due to|driven|enabled|interoperab|ease|cost|barriers|mechanism|incentive|access|efficien|acceptance|convenien|affordab|infrastruct|smartphone|demoneti)/i },
    { id: 'measurements', title: 'What changed', wanted: 'Measurements with their period, population and method.', pattern: /\b(?:billion|million|crore|percent|grew|growth|increased|declined|statistics|volume|study|survey)\b|%/i },
    { id: 'alternatives', title: 'Other explanations and limits', wanted: 'Contrary evidence, limitations and alternative explanations.', pattern: /\b(?:however|limitation|challenge|risk|bias|alternative|correlation|uncertain|decline|fraud|critic)/i },
  ],
  news: [
    { id: 'record', title: 'The underlying record', wanted: 'The original record, dataset or direct statement behind the claim.', pattern: /\b(?:data|statistics|statement|according|report|record|announced)\b/i },
    { id: 'scope', title: 'Dates and scope', wanted: 'Matching period, entity, unit and breadth.', pattern: /\b(?:20\d\d|January|February|March|April|May|June|July|August|September|October|November|December|monthly|annual|year|billion|million|crore)\b/i },
    { id: 'corrections', title: 'Corrections and challenges', wanted: 'A correction, clarification or substantive opposing account.', pattern: /\b(?:correct|clarif|mislead|false|denied|dispute|contradict|however)/i },
  ],
  reviews: [
    { id: 'practice', title: 'What practice is documented', wanted: 'Records distinguishing fabricated, incentivised, filtered and suppressed reviews.', pattern: /\b(?:fabricat|fake|suppress|block|negative review|incentivi|moderation|filter)/i },
    { id: 'experiences', title: 'What customers report', wanted: 'Specific experiences, dates, product versions and verified purchase status.', pattern: /\b(?:customer|purchase|experience|complaint|refund|received|rating)\b/i },
    { id: 'provenance', title: 'Where the pattern comes from', wanted: 'Review provenance, independent records and relevant platform rules.', pattern: /\b(?:regulator|commission|settlement|verified|policy|investigation|platform|independent)\b/i },
    { id: 'response', title: 'Responses and alternatives', wanted: 'Responses and explanations that could account for the pattern.', pattern: /\b(?:response|respond|spokesperson|contended|denied|dispute|however|explanation|policy|resolved)\b/i },
  ],
  brand: [
    { id: 'claims', title: 'Claims being made', wanted: 'The exact claim and product/version it addresses.', pattern: /\b(?:claim|advertis|promis|statement|product|version)/i },
    { id: 'tests', title: 'Tests and official records', wanted: 'Relevant tests, recalls or regulator records.', pattern: /\b(?:test|study|recall|regulator|safety|measurement|investigation)/i },
    { id: 'responses', title: 'Challenges and responses', wanted: 'Opposing evidence, complaints and the company response.', pattern: /\b(?:complaint|response|denied|dispute|clarif|however|critic)/i },
  ],
  attribution: [
    { id: 'appearances', title: 'Earlier appearances', wanted: 'Dated earlier appearances of the same work, not merely similar work.', pattern: /\b(?:published|posted|appeared|archive|original|earlier|first)\b/i },
    { id: 'credit', title: 'Who is credited', wanted: 'Explicit author credits and their source.', pattern: /\b(?:author|credit|created|photograph|artist|portfolio|attribution)/i },
    { id: 'rights', title: 'Permission and ownership', wanted: 'Evidence of authorship, permission or a licence; earliest found is insufficient.', pattern: /\b(?:licen[cs]e|permission|copyright|ownership|rights)\b/i },
  ],
  shopping: [
    { id: 'advertisement', title: 'What was advertised', wanted: 'The exact listing and its material, size, appearance and version.', pattern: /\b(?:advertis|listing|material|fabric|size|specification|description)/i },
    { id: 'received', title: 'What was received', wanted: 'The received item, transaction and relevant photos.', pattern: /\b(?:received|delivered|mismatch|customer|purchase|batch|wrong)\b/i },
    { id: 'response', title: 'Seller response and other explanations', wanted: 'Responses, returns and possible variant, batch or photography differences.', pattern: /\b(?:response|return|refund|batch|variant|lighting|difference)/i },
  ],
};
function words(text: string) { return new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(word => word.length >= 3 && !/^(?:the|and|for|that|this|with|from|have|were|been|their|they|more|than|which|when|also|why|how|what|did|does|can|could|would|should|will|claim|question|evidence|explanation|explanations|distinguish|distinguishes|quickly|according)$/.test(word))); }
function sourceSentences(text: string): Array<{passage: string; start: number}> {
  const spans: Array<{passage: string; start: number}> = [];
  let pendingStart: number | null = null;
  for (const match of text.matchAll(/.+?(?:[.!?](?=\s|$)|(?=\n|$))/g)) {
    const fragment = match[0].trim();
    const start: number = pendingStart ?? (match.index ?? 0) + match[0].indexOf(fragment);
    if (/\b(?:Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|Mr|Mrs|Ms|Dr|Prof|St)\.$/i.test(fragment)) { pendingStart = start; continue; }
    const end = (match.index ?? 0) + match[0].trimEnd().length;
    spans.push({passage: text.slice(start, end), start});
    pendingStart = null;
  }
  if (pendingStart !== null) spans.push({passage: text.slice(pendingStart).trimEnd(), start: pendingStart});
  return spans;
}
export interface SourceStatement { evidence: CaseEvidence; quote: QuoteReference; relation: string }
/** Every statement is an exact span of retained page text. Search snippets cannot become an inspected assertion. */
export function sourceStatements(report: ClaimReport | null, record: CaseRecord): SourceStatement[] {
  const wanted = report ? words(report.question) : null, statements: SourceStatement[] = [];
  const acronyms = new Set(((report?.question ?? '').match(/\b[A-Z][A-Z0-9]{1,8}\b/g) ?? []).map(word => word.toLowerCase()));
  for (const evidence of record.evidence) {
    if (evidence.content.kind !== 'text' || evidence.content.attribution !== 'page_quote') continue;
    const assessment = report?.sources.find(source => source.evidenceId === evidence.id);
    if (assessment?.relevance !== null && assessment?.relevance !== undefined && assessment.relevance < 0.5) continue;
    const text = evidence.content.text;
    const heading = evidence.title?.trim().toLowerCase().replace(/(?:\.{3}|…)$/, '').trim();
    const titleLike = (passage: string) => Boolean(heading && (passage.toLowerCase().replace(/[.!]$/, '') === heading || /(?:\.{3}|…)$/.test(evidence.title?.trim() ?? '') && heading.length >= 24 && passage.toLowerCase().startsWith(heading) && passage.length < heading.length + 80));
    const spans = sourceSentences(text).map(({passage, start}) => {
      const terms = words(passage);
      return { passage, start, overlap: [...terms].filter(word => wanted?.has(word)).length, anchor: [...terms].some(word => acronyms.has(word)) };
    }).filter(span => span.passage.length >= 40 && span.passage.length <= 1200 && !span.passage.endsWith('?') && !titleLike(span.passage) && span.passage.trim().toLowerCase() !== evidence.title?.trim().toLowerCase() && (wanted === null || wanted.size > 0 && (span.anchor || span.overlap >= Math.min(2, wanted.size))))
      .sort((a, b) => b.overlap - a.overlap || a.start - b.start).slice(0, 12);
    for (const span of spans) statements.push({ evidence, relation: assessment?.relation ?? 'insufficient', quote: { evidenceId: evidence.id, start: span.start, end: span.start + span.passage.length, text: span.passage, attribution: 'page_quote' } });
  }
  return statements;
}
export function researchDossier(report: ClaimReport, record: CaseRecord) {
  const focus = researchFocus(report.question), statements = sourceStatements(report, record);
  const sections = facets[focus].map(facet => {
    const matching = statements.filter(statement => facet.pattern.test(statement.quote.text));
    const firstBySource = matching.filter((statement, index) => matching.findIndex(other => other.evidence.sourceUrl === statement.evidence.sourceUrl) === index);
    return { ...facet, statements: [...firstBySource, ...matching.filter(statement => !firstBySource.includes(statement))].slice(0, 4) };
  });
  const connections: Array<{ left: SourceStatement; right: SourceStatement; status: 'same_retained_wording' | 'plausible_connection'; reason: string }> = [];
  for (let i = 0; i < statements.length; i++) for (let j = i + 1; j < statements.length; j++) {
    const left = statements[i], right = statements[j];
    if (left.evidence.id === right.evidence.id || left.evidence.sourceUrl === right.evidence.sourceUrl) continue;
    const a = words(left.quote.text), b = words(right.quote.text), common = [...a].filter(word => b.has(word));
    if (left.quote.text === right.quote.text) connections.push({ left, right, status: 'same_retained_wording', reason: 'These inspected passages contain exactly the same wording. This does not establish who copied whom or whether the sources are independent.' });
    else if (common.length >= 4 && common.length / new Set([...a, ...b]).size >= 0.4) connections.push({ left, right, status: 'plausible_connection', reason: 'The passages share substantial wording. Different dates, figures, places or assertions remain visible; their relationship and direction of spread are unresolved.' });
  }
  return { focus, sections, connections: connections.slice(0, 12), gaps: sections.filter(section => !section.statements.length).map(section => section.wanted) };
}
