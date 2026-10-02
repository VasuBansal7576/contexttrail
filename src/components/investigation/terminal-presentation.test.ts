import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
const css = readFileSync('src/app/globals.css', 'utf8');
function luminance(hex: string) {
  const channels = [1,3,5].map(offset => parseInt(hex.slice(offset,offset+2),16)/255).map(value => value<=0.04045 ? value/12.92 : ((value+0.055)/1.055)**2.4);
  return (channels[0] ?? 0)*0.2126+(channels[1] ?? 0)*0.7152+(channels[2] ?? 0)*0.0722;
}
function contrast(foreground: string, background: string) {
  const values=[luminance(foreground),luminance(background)].sort((a,b)=>b-a);
  return ((values[0] ?? 0)+0.05)/((values[1] ?? 0)+0.05);
}
it('keeps terminal error title and body above AA against the exact solid alert background',()=>{
  const alert = css.match(/\.investigation-failure \{ background:(#[0-9a-f]+); color:(#[0-9a-f]+);/);
  const title = css.match(/\.investigation-failure-title \{ color:(#[0-9a-f]+);/);
  if(!alert?.[1] || !alert[2] || !title?.[1]) throw new Error('Missing terminal alert colors');
  expect(contrast(title[1],alert[1])).toBeGreaterThanOrEqual(4.5);
  expect(contrast(alert[2],alert[1])).toBeGreaterThanOrEqual(4.5);
  expect(contrast('#d6e0e2','#234d70')).toBeGreaterThanOrEqual(4.5);
  // Existing evidence panel is 5% white over the blue chapter background.
  expect(contrast('#d6e0e2','#2e5677')).toBeGreaterThanOrEqual(4.5);
  expect(contrast('#d6e0e2','#315a85')).toBeGreaterThanOrEqual(4.5);
});
it('fits manual sidebar display headings without arbitrary punctuation breaks',()=>{
  expect(css).toContain('.workspace-side .chapter-heading h1 { font-size:clamp(50px,5vw,72px); overflow-wrap:normal; }');
});
it('lets intrinsic grid items shrink and wraps full retained text instead of clipping it',()=>{
  expect(css).toContain('.investigation-work-grid>*,.progress-evidence .evidence-collection>* { min-width:0; }');
  expect(css).toContain('.investigation-detail,.investigation-candidate-title { white-space:normal; overflow-wrap:anywhere; }');
});
