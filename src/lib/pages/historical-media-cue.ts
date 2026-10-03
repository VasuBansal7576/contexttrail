/** A bounded work-selection cue only: it establishes no date or media identity. */
export function hasHistoricalMediaCue(text: string): boolean {
  return text.length <= 1200
    && /\b(?:video|footage|clip|image|photo(?:graph)?|post(?:ed)?|upload(?:ed)?|original)\b/i.test(text)
    && /\b(?:19\d{2}|20\d{2}|earlier|previously|old(?:er)?|originally)\b/i.test(text);
}
