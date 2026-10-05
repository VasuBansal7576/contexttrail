import { expect, it } from 'vitest';
import { inspectVisualTrack, parseVisualScan } from './visual-scan';
function frames(values: number[]) { const bytes = new Uint8Array(values.length * 4096); values.forEach((value, index) => bytes.fill(value, index * 4096, (index + 1) * 4096)); return bytes; }
it('inspects the end of the track and chooses later changed content rather than only opening intervals', () => {
  const scan = inspectVisualTrack(frames([...Array(16).fill(20), ...Array(4).fill(240)]), 10000);
  expect(scan.scannedTimestampsMs).toHaveLength(20); expect(scan.scannedTimestampsMs.at(-1)).toBe(9500);
  expect(scan.searchTargetsMs).toContain(8000); expect(scan.searchTargetsMs[0]).toBe(0);
  expect(scan.changes.find(c => c.timestampMs === 8000)?.meanLuminanceChange).toBeCloseTo(220 / 255);
  expect(parseVisualScan(JSON.parse(JSON.stringify(scan)))).toEqual(scan);
});
it('keeps beginning, midpoint and endpoint coverage when there is no measured change', () => {
  expect(inspectVisualTrack(frames(Array(20).fill(20)), 10000).searchTargetsMs).toEqual([0, 5000, 9500]);
});
it('rejects incomplete, oversized or falsely timestamped scans', () => {
  expect(() => inspectVisualTrack(frames([0, 255]), 10000)).toThrow();
  expect(() => inspectVisualTrack(frames(Array(242).fill(0)), 120000)).toThrow();
  const scan = inspectVisualTrack(frames(Array(20).fill(20)), 10000);
  expect(() => parseVisualScan({ ...scan, scannedTimestampsMs: scan.scannedTimestampsMs.slice(0, 2) })).toThrow();
  expect(() => parseVisualScan({ ...scan, searchTargetsMs: [100] })).toThrow();
});
