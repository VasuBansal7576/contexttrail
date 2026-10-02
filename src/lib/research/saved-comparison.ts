import { createHash } from 'node:crypto';
import { parseComparisonResponse } from '../video/matching/client';
/** Validate retained frame bytes without rerunning matching or claiming authenticity. */
export function parseSavedComparison(value: unknown) {
  const result = parseComparisonResponse(value);
  for (const frame of [...result.frames.left, ...result.frames.right]) {
    const actual = createHash('sha256').update(Buffer.from(frame.base64, 'base64')).digest('hex');
    if (actual !== frame.contentHash) throw new Error('Retained comparison frame hash does not match its bytes');
  }
  return result;
}
