/** Timing authored in Product HTMLs/ContextTrail.html, in milliseconds. */
export const chapterTiming = [
  { id: 'cover', duration: 10_000, selectionInterval: 0 },
  { id: 'image', duration: 18_000, selectionInterval: 0 },
  { id: 'video', duration: 21_000, selectionInterval: 4_000 },
  { id: 'questions', duration: 22_000, selectionInterval: 6_500 },
  { id: 'evidence', duration: 24_000, selectionInterval: 7_500 },
  { id: 'sources', duration: 18_000, selectionInterval: 4_500 },
  { id: 'changes', duration: 19_000, selectionInterval: 6_000 },
  { id: 'watch', duration: 19_000, selectionInterval: 0 },
  { id: 'answers', duration: 21_000, selectionInterval: 6_500 },
] as const;
export const tourDuration = chapterTiming.reduce((total, chapter) => total + chapter.duration, 0);
export function chapterPosition(index: number, elapsed: number) {
  return chapterTiming.slice(0, index).reduce((total, chapter) => total + chapter.duration, 0) + elapsed;
}
export function tourClock(milliseconds: number) {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
