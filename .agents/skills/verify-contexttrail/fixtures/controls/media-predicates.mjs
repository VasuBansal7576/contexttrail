/**
 * Offline derivative of the accepted A10 media/layout predicates.
 *
 * The maintained media path measures the image's whole ancestor chain —
 * display, visibility, hidden, aria-hidden, opacity and content-visibility on
 * EVERY ancestor — plus rendered geometry, viewport presence, a complete
 * decode and at least one non-transparent pixel. The wrap predicate measures
 * the FULL text range of the host element: line-clamp, ellipsis,
 * overflow-clipped lines and document horizontal overflow are all red. The
 * target predicate measures real interactive controls; a secondary control
 * under the 44px floor is a recorded inconsistency, not a violation.
 *
 * This exercises the REAL exported verdicts — visibleImageVerdict,
 * wrapVerdict, targetVerdict, motionAtRestOk — plus a parse check on each
 * in-page function source.
 *
 *   node fixtures/controls/media-predicates.mjs
 */
import {
  visibleImageVerdict,
  wrapVerdict,
  targetVerdict,
  motionAtRestOk,
  VISIBLE_IMAGE_FN,
  CLIP_FN,
  TARGET_FN,
} from "../../cli/control-contexttrail.mjs";

let failures = 0;
const results = [];
const expect = (name, cond, detail) => {
  results.push({ name, ok: cond === true, detail: detail ?? null });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

for (const [name, src] of Object.entries({ VISIBLE_IMAGE_FN, CLIP_FN, TARGET_FN })) {
  let ok = true;
  try {
    new Function(`return ${src}`);
  } catch {
    ok = false;
  }
  expect(`${name} parses as a page-side function`, ok);
}

// Synthetic records in exactly the shape VISIBLE_IMAGE_FN returns.
const img = (over = {}) => ({
  present: true,
  alt: "Retrieved image 1",
  complete: true,
  naturalWidth: 320,
  naturalHeight: 240,
  visiblePixels: 76800,
  decodeOk: true,
  decodeError: null,
  ownOpacity: 1,
  renderedGeometry: true,
  inViewport: true,
  rect: { width: 320, height: 240, top: 100 },
  hiddenBy: [],
  runningAnimations: [],
  runningAnimationCount: 0,
  ...over,
});

// Positive: a decoded, rendered, in-viewport, non-transparent image passes.
expect("a decoded visible image passes", visibleImageVerdict(img()).pass === true);

// Negatives — every hiding/degradation shape is red.
expect("a missing image is RED", visibleImageVerdict({ present: false, reason: "no image" }).pass === false);
expect(
  "a hidden-by-ancestor decode is RED",
  visibleImageVerdict(img({ hiddenBy: [{ tag: "DIV", reason: "display:none" }] })).pass === false,
);
expect("own opacity 0 is RED", visibleImageVerdict(img({ ownOpacity: 0 })).pass === false);
expect("zero rendered geometry is RED", visibleImageVerdict(img({ renderedGeometry: false })).pass === false);
expect("outside the viewport is RED", visibleImageVerdict(img({ inViewport: false })).pass === false);
expect(
  "an incomplete/corrupt image is RED",
  visibleImageVerdict(img({ complete: false, naturalWidth: 0, decodeOk: false, decodeError: "drawImage threw" })).pass === false,
);
expect("a fully transparent image is RED", visibleImageVerdict(img({ visiblePixels: 0 })).pass === false);

// At-rest motion on the media record.
expect("no running animations is at rest", motionAtRestOk(img()) === true);
expect("a running animation is NOT at rest", motionAtRestOk(img({ runningAnimationCount: 1, runningAnimations: [{ playState: "running" }] })) === false);
expect("an unmeasured animation count is NOT at rest", motionAtRestOk(img({ runningAnimationCount: null })) === false);
expect("an unmeasured record is NOT at rest", motionAtRestOk({}) === false);

// Synthetic records in exactly the shape CLIP_FN returns.
const clip = (over = {}) => ({
  found: true,
  tag: "P",
  textLength: 64,
  fullContentBounds: { width: 320, height: 42, lineCount: 2 },
  lineClampApplied: false,
  textOverflowEllipsis: false,
  verticalOverflowHidden: false,
  overflowHidden: false,
  clippedLineRects: 0,
  fullTextRendered: true,
  documentScrollWidth: 390,
  documentClientWidth: 390,
  horizontalOverflow: false,
  ...over,
});

// Positive: fully rendered wrapped text passes.
expect("fully rendered wrapped text passes", wrapVerdict(clip()).pass === true);

// Negatives — each explicit clipping shape is red.
expect("a missing text node is RED", wrapVerdict({ found: false }).pass === false);
expect("line-clamp is RED", wrapVerdict(clip({ lineClampApplied: true })).pass === false);
expect("text-overflow:ellipsis is RED", wrapVerdict(clip({ textOverflowEllipsis: true })).pass === false);
expect("vertical overflow hidden is RED", wrapVerdict(clip({ verticalOverflowHidden: true })).pass === false);
expect("overflow hidden is RED", wrapVerdict(clip({ overflowHidden: true })).pass === false);
expect("line rects outside the host box are RED", wrapVerdict(clip({ clippedLineRects: 2 })).pass === false);
expect("a partially rendered string is RED", wrapVerdict(clip({ fullTextRendered: false })).pass === false);
expect("document horizontal overflow is RED", wrapVerdict(clip({ horizontalOverflow: true })).pass === false);

// Synthetic records in exactly the shape TARGET_FN returns.
const target = (over = {}) => ({
  found: true,
  tag: "BUTTON",
  role: null,
  accessibleName: "Start investigation",
  width: 220,
  height: 48,
  minHeight44: true,
  minWidth44: true,
  interactive: true,
  disabled: false,
  ariaDisabled: null,
  ...over,
});

// Positive: a real interactive control at the floor passes.
expect("a valid primary target passes", targetVerdict(target()).pass === true);
expect("a primary target exactly at 44px passes", targetVerdict(target({ height: 44 })).pass === true);

// Negatives.
expect("a primary target under 44px is RED", targetVerdict(target({ height: 20 })).pass === false);
expect("a non-interactive element is RED", targetVerdict(target({ interactive: false, tag: "P" })).pass === false);
expect("a disabled control is RED", targetVerdict(target({ disabled: true })).pass === false);
expect("a missing control is RED", targetVerdict({ found: false }).pass === false);
expect("a zero-geometry control is RED", targetVerdict(target({ width: 0, height: 0 })).pass === false);

// A secondary sub-44 control is recorded, not failed against the primary
// requirement: pass:true with the belowPrimaryFloor flag carrying the finding.
const secondary = targetVerdict(target({ height: 20, accessibleName: "Back" }), { primary: false });
expect(
  "a secondary sub-44 target is recorded without failing the primary requirement",
  secondary.pass === true && secondary.belowPrimaryFloor === true,
);

console.log(
  JSON.stringify({ control: "media-predicates", checks: results.length, failures, ok: failures === 0 }),
);
console.log(failures === 0 ? "PASS: media/layout predicates discriminate" : `FAIL: ${failures} expectation(s) failed`);
process.exit(failures === 0 ? 0 : 1);
