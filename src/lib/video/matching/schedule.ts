/** HTTP scheduling around the byte-for-byte frozen matcher. No algorithm or threshold changes. */
import { setImmediate } from 'node:timers/promises';
import { comparePreparedMedia } from './compare';
import { FrameMatchError, type FrameMatchReport, type PreparedMatchMedia } from './model';

/** Each synchronous interval is one original frame-pair comparison; cancellation waits for it. */
export async function comparePreparedMediaAsync(left: PreparedMatchMedia, right: PreparedMatchMedia, signal: AbortSignal): Promise<FrameMatchReport> {
  // Ask the frozen implementation for its full report envelope and input metadata.
  const report = comparePreparedMedia({ ...left, frames: [] }, { ...right, frames: [] });
  for (const l of left.frames) for (const r of right.frames) {
    await setImmediate();
    if (signal.aborted) throw new FrameMatchError('cancelled');
    const pair = comparePreparedMedia({ ...left, frames: [l] }, { ...right, frames: [r] });
    report.comparisons.push(...pair.comparisons);
    report.candidates.push(...pair.candidates);
    report.comparedFramePairs += pair.comparedFramePairs;
  }
  // Deliver an abort that arrived during the final synchronous pair before returning.
  await setImmediate();
  if (signal.aborted) throw new FrameMatchError('cancelled');
  return report;
}
