/** Acquisition only: retain several relevant verbatim paragraphs from one read
 * page so a broad question is not reduced to one sentence. No facts are added. */
const filler = new Set('a an and are as at be being by can claim did do does for from had has have how in is it its of on or so that the their this to was were what when where which who why will with would evidence shows show quickly more than'.split(' '));
function terms(value: string) {
  return new Set((value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(word => !filler.has(word) && (word.length >= 3 || /^\d+$/.test(word))));
}
export function topicPassages(question: string, paragraphs: readonly string[]): string | null {
  const wanted = terms(question);
  const ranked = paragraphs.map((text, index) => ({ text: text.trim(), index, overlap: [...terms(text)].filter(term => wanted.has(term)).length }))
    .filter(item => item.text && item.overlap > 0).sort((a, b) => b.overlap - a.overlap || a.index - b.index);
  const kept: typeof ranked = [];
  for (const item of ranked) {
    if (kept.some(prior => prior.text === item.text)) continue;
    kept.push(item);
    if (kept.length === 3) break;
  }
  // The highest-overlap paragraph leads, followed by adjacent source material.
  // Every character remains an exact source substring; newline joins are explicit.
  return kept.length ? kept.map(item => item.text.slice(0, 2400)).join('\n\n').slice(0, 8000) : null;
}
