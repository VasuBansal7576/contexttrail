/** Browser-safe scan record. Changes describe local pixels, never scene identity or manipulation. */
export interface VisualScan {
  schemaVersion: 'contexttrail-visual-scan-v1';
  method: 'two-fps-64px-luminance-v1';
  durationMs: number;
  scannedTimestampsMs: number[];
  changes: Array<{ timestampMs: number; meanLuminanceChange: number }>;
  searchTargetsMs: number[];
  limitations: string[];
}
const FRAME_BYTES = 64 * 64;
/** FFmpeg decodes the whole track, retaining two tiny local samples per second. */
export function inspectVisualTrack(bytes: Uint8Array, durationMs: number): VisualScan {
  const count = bytes.length / FRAME_BYTES;
  if (!Number.isInteger(count) || count < 1 || count > 241 || !Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 120000 || count < Math.floor(durationMs / 500)) throw new Error('Incomplete bounded visual scan');
  const timestamps = Array.from({ length: count }, (_, index) => index * 500).filter(time => time < durationMs);
  const changes = timestamps.slice(1).map((timestampMs, index) => {
    let difference = 0;
    for (let pixel = 0; pixel < FRAME_BYTES; pixel++) difference += Math.abs(bytes[(index + 1) * FRAME_BYTES + pixel] - bytes[index * FRAME_BYTES + pixel]);
    return { timestampMs, meanLuminanceChange: difference / (FRAME_BYTES * 255) };
  });
  // Keep endpoint coverage even when the strongest motion is near the start.
  const last = timestamps[timestamps.length - 1];
  const targets = [...new Set([0, last])];
  const separation = Math.max(500, Math.min(1000, durationMs / 6));
  const peak = [...changes].sort((a, b) => b.meanLuminanceChange - a.meanLuminanceChange || a.timestampMs - b.timestampMs)
    .find(change => change.meanLuminanceChange >= .08 && targets.every(time => Math.abs(time - change.timestampMs) >= separation));
  const middle = peak?.timestampMs ?? timestamps[Math.floor(timestamps.length / 2)];
  if (!targets.includes(middle)) targets.push(middle);
  return { schemaVersion: 'contexttrail-visual-scan-v1', method: 'two-fps-64px-luminance-v1', durationMs, scannedTimestampsMs: timestamps, changes, searchTargetsMs: targets.sort((a, b) => a - b), limitations: ['The whole video track was decoded locally into two 64×64 luminance samples per second. Brief events between samples and fine detail can be missed.', 'Pixel changes can come from motion, edits, exposure or camera movement; they do not prove a scene boundary, manipulation or identity.', 'Up to three search frames are chosen from observed changes and timeline coverage. Web retrieval still concerns those frames, not every video interval.'] };
}
export function parseVisualScan(value: unknown): VisualScan {
  if (!value || typeof value !== 'object' || !('schemaVersion' in value) || value.schemaVersion !== 'contexttrail-visual-scan-v1' || !('method' in value) || value.method !== 'two-fps-64px-luminance-v1' || !('durationMs' in value) || typeof value.durationMs !== 'number' || !Number.isFinite(value.durationMs) || value.durationMs <= 0 || value.durationMs > 120000 || !('scannedTimestampsMs' in value) || !Array.isArray(value.scannedTimestampsMs) || !value.scannedTimestampsMs.length || value.scannedTimestampsMs.length > 241 || !('changes' in value) || !Array.isArray(value.changes) || !('searchTargetsMs' in value) || !Array.isArray(value.searchTargetsMs) || !value.searchTargetsMs.length || value.searchTargetsMs.length > 3 || !('limitations' in value) || !Array.isArray(value.limitations) || value.limitations.length > 20) throw new Error('Invalid visual scan');
  const duration = value.durationMs;
  const timestamps: number[] = value.scannedTimestampsMs.map((time, index) => { if (typeof time !== 'number' || time !== index * 500 || time >= duration) throw new Error('Invalid scan timestamps'); return time; });
  if (timestamps.length < Math.floor(duration / 500) || value.changes.length !== timestamps.length - 1) throw new Error('Incomplete visual scan');
  const changes = value.changes.map((item, index) => { if (!item || typeof item !== 'object' || !('timestampMs' in item) || item.timestampMs !== timestamps[index + 1] || !('meanLuminanceChange' in item) || typeof item.meanLuminanceChange !== 'number' || !Number.isFinite(item.meanLuminanceChange) || item.meanLuminanceChange < 0 || item.meanLuminanceChange > 1) throw new Error('Invalid visual change'); return { timestampMs: timestamps[index + 1], meanLuminanceChange: item.meanLuminanceChange }; });
  const targets: number[] = value.searchTargetsMs.map(time => { if (typeof time !== 'number' || !timestamps.includes(time)) throw new Error('Invalid search target'); return time; });
  if (new Set(targets).size !== targets.length || targets.some((time, index) => index > 0 && time <= targets[index - 1])) throw new Error('Invalid target order');
  const limitations: string[] = value.limitations.map(text => { if (typeof text !== 'string' || text.length > 2000) throw new Error('Invalid scan limitation'); return text; });
  return { schemaVersion: value.schemaVersion, method: value.method, durationMs: duration, scannedTimestampsMs: timestamps, changes, searchTargetsMs: targets, limitations };
}
