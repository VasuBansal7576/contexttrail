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

// Synthetic records in exactly the shape the scoped CLIP_FN returns: a real
// Range over the measured node's own text, the node's border box, and the
// ancestor clip chain — never a body-global text search.
const clip = (over = {}) => ({
  found: true,
  rendered: true,
  rangeMeasured: true,
  lineRects: [
    { left: 8, right: 328, top: 10, bottom: 28 },
    { left: 8, right: 200, top: 30, bottom: 48 },
  ],
  union: { left: 8, right: 328, top: 10, bottom: 48 },
  nodeRect: { left: 8, right: 336, top: 8, bottom: 50 },
  display: "block",
  visibility: "visible",
  overflowX: "visible",
  overflowY: "visible",
  clippingAncestors: [],
  documentHorizontalOverflow: false,
  ...over,
});

// Positive: a long inline text that genuinely wraps inside every bound
// passes — length alone never fails.
expect("a wrapped in-bounds range passes", wrapVerdict(clip()).pass === true);
expect(
  "a long multi-line range that stays inside its bounds passes",
  wrapVerdict(
    clip({
      lineRects: Array.from({ length: 8 }, (_, i) => ({ left: 8, right: 328, top: 10 + i * 20, bottom: 28 + i * 20 })),
      nodeRect: { left: 8, right: 336, top: 8, bottom: 170 },
    }),
  ).pass === true,
);

// Negatives — missing, hidden, and boxless nodes are all red, as is an
// empty range.
expect("a missing scoped node is RED", wrapVerdict({ found: false, reason: "scoped node not found" }).pass === false);
expect("a hidden (no-rect) node is RED", wrapVerdict(clip({ rendered: false, reason: "node has no rendered box", nodeRect: { left: 0, right: 0, top: 0, bottom: 0 } })).pass === false);
expect("an ancestor-hidden node is RED", wrapVerdict(clip({ rendered: false, hiddenByAncestor: { tag: "DIV", display: "none" } })).pass === false);
expect("an empty text range is RED", wrapVerdict(clip({ rangeMeasured: false, lineRects: [] })).pass === false);

// Clipping vs visible overflow (V39-5): a range outrunning its own node box
// is green while neither axis clips — overflow:visible paints the overhang —
// and red the moment the node itself clips that axis.
expect(
  "a range wider than a NON-clipping node box is GREEN (visible overflow)",
  wrapVerdict(clip({ lineRects: [{ left: 8, right: 500, top: 10, bottom: 28 }] })).pass === true,
);
expect(
  "the same range is RED once the node clips horizontally",
  wrapVerdict(clip({ overflowX: "hidden", lineRects: [{ left: 8, right: 500, top: 10, bottom: 28 }] })).pass === false,
);
expect(
  "a range below a NON-clipping node box is GREEN (visible overflow)",
  wrapVerdict(clip({ lineRects: [{ left: 8, right: 328, top: 10, bottom: 80 }] })).pass === true,
);
expect(
  "the same range is RED once the node clips vertically",
  wrapVerdict(clip({ overflowY: "clip", lineRects: [{ left: 8, right: 328, top: 10, bottom: 80 }] })).pass === false,
);
expect(
  "an overflow-x:hidden ancestor narrower than the range is RED (too-wide)",
  wrapVerdict(
    clip({
      nodeRect: { left: 8, right: 600, top: 8, bottom: 30 },
      lineRects: [{ left: 8, right: 600, top: 10, bottom: 28 }],
      clippingAncestors: [
        { tag: "LI", overflowX: "hidden", overflowY: "visible", paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0, rect: { left: 8, right: 340, top: 8, bottom: 30 } },
      ],
    }),
  ).pass === false,
);
expect(
  "an overflow-y:hidden ancestor cutting the range is RED",
  wrapVerdict(
    clip({
      clippingAncestors: [
        { tag: "DIV", overflowX: "visible", overflowY: "hidden", paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0, rect: { left: 0, right: 390, top: 8, bottom: 40 } },
      ],
    }),
  ).pass === false,
);
expect(
  "a visible-overflow ancestor wider than the range does not fail it",
  wrapVerdict(
    clip({
      clippingAncestors: [
        { tag: "DIV", overflowX: "auto", overflowY: "visible", paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0, rect: { left: 0, right: 390, top: 0, bottom: 200 } },
      ],
    }),
  ).pass === true,
);
expect(
  "document horizontal overflow is RED",
  wrapVerdict(clip({ documentHorizontalOverflow: true })).pass === false,
);

// Synthetic records in exactly the shape TARGET_FN returns — found, rendered
// visibility through the ancestor chain, real geometry, interactivity.
const target = (over = {}) => ({
  found: true,
  rendered: true,
  hiddenByAncestor: null,
  effectiveOpacity: 1,
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
  display: "inline-flex",
  visibility: "visible",
  ...over,
});

// Positive: a real interactive control at the floor passes.
expect("a valid primary target passes", targetVerdict(target()).pass === true);
expect("a primary target exactly at 44px passes", targetVerdict(target({ height: 44 })).pass === true);

// Visibility prerequisite (F38-2): a control the user cannot see is not a
// hit target — before its size is even a question.
expect("a display:none control is RED", targetVerdict(target({ rendered: false, display: "none", width: 0, height: 0 })).pass === false);
expect("a visibility:hidden control is RED", targetVerdict(target({ rendered: false, visibility: "hidden" })).pass === false);
expect("an ancestor-hidden control is RED", targetVerdict(target({ rendered: false, hiddenByAncestor: { tag: "DIV", display: "none" } })).pass === false);
expect("a zero-opacity control is RED", targetVerdict(target({ rendered: false, effectiveOpacity: 0 })).pass === false);
expect("a control without a rendered record is RED (fail-closed)", targetVerdict(target({ rendered: undefined })).pass === false);

// Negatives.
expect("a primary target under 44px is RED", targetVerdict(target({ height: 20 })).pass === false);
expect("a non-interactive element is RED", targetVerdict(target({ interactive: false, tag: "P" })).pass === false);
expect("a disabled control is RED", targetVerdict(target({ disabled: true })).pass === false);
expect("a missing control is RED", targetVerdict({ found: false }).pass === false);
expect("a zero-geometry control is RED", targetVerdict(target({ rendered: false, width: 0, height: 0 })).pass === false);

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
