import { describe, expect, it } from 'vitest';
import { mediaContainerControls } from './media-container-controls.mjs';
import { hasSelfContainedMovLayout } from '../src/lib/video/container-signature';
import { parseComparisonForm } from '../src/lib/video/matching/application';

function form(video) {
  const body = new FormData();
  body.set('left', new Blob([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' }), 'left.png');
  body.set('right', new Blob([video], { type: 'video/mp4' }), 'right.mp4');
  body.set('leftKind', 'image'); body.set('rightKind', 'video'); body.set('rights', 'user_provided');
  return body;
}
describe('media HTTP script container controls', () => {
  it('retains the exact old malformed input as a pre-decoder 415 control', async () => {
    const { malformedLayout } = mediaContainerControls();
    const original = Buffer.alloc(20); original.write('ftyp', 4);
    expect(malformedLayout).toEqual(original);
    expect(hasSelfContainedMovLayout(malformedLayout)).toBe(false);
    await expect(parseComparisonForm(form(malformedLayout), new AbortController().signal)).rejects.toMatchObject({ status: 415, code: 'SIGNATURE_MISMATCH' });
  });
  it('allows the separate bounded movie/media layout through the actual form parser for native validation', async () => {
    const { undecodableLayout } = mediaContainerControls();
    expect(undecodableLayout.length).toBe(35);
    expect(hasSelfContainedMovLayout(undecodableLayout)).toBe(true);
    const parsed = await parseComparisonForm(form(undecodableLayout), new AbortController().signal);
    expect(parsed.right).toEqual({ kind: 'video', bytes: undecodableLayout, rights: 'user_provided' });
    expect(undecodableLayout.includes(Buffer.from('trak'))).toBe(false);
  });
  it('uses deterministic isolated fixtures and rejects truncated layout controls', () => {
    const first = mediaContainerControls(), second = mediaContainerControls();
    expect(second).toEqual(first);
    for (const bytes of [first.undecodableLayout.subarray(0, 24), first.undecodableLayout.subarray(0, 34)]) expect(hasSelfContainedMovLayout(bytes)).toBe(false);
    first.malformedLayout.fill(0xff); first.undecodableLayout.fill(0xff);
    expect(mediaContainerControls()).toEqual(second);
  });
});
