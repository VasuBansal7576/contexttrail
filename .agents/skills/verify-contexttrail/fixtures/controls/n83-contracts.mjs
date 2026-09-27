/**
 * Offline control for the N83 consumer corrections — every predicate is driven
 * against the REAL exported machinery, never a reimplementation:
 *
 *   N83-1 — the Locator.evaluate call contract: `readFocusDescriptor` must
 *           hand a REAL serializable function to the locator (a stub that
 *           reproduces Playwright semantics — strings are evaluated as
 *           expressions and never invoked with the element — proves the old
 *           call shape returns null while the new one returns the descriptor).
 *   N83-2 — heading-scoped semantic matching: the REAL A8_TIMELINE_PROBE_FN /
 *           A8_ANALYSIS_PROBE_FN strings are evaluated in a real DOM (jsdom)
 *           under authored-mixed-case, authored-uppercase, wrong-text, missing,
 *           hidden and duplicate headings, then the real verdicts run.
 *   N83-3 — longValueLayout: the REAL page-side measurement is evaluated in a
 *           jsdom DOM with scripted geometry — sibling-column exemption,
 *           within-column reversal, direct-li column-reverse and
 *           container/descendant dedup all exercised for real.
 *   N83-4 — a8CoverageVerdict: performed identity bound to the explicit
 *           compared-pair id set over the consumed terminal edges, all
 *           relationship rows honestly labeled, unexamined never promoted.
 *
 * jsdom has no layout engine: rects are injected per element so the REAL
 * ordering math runs on scripted geometry.
 *
 *   node fixtures/controls/n83-contracts.mjs
 */
import { JSDOM } from "jsdom";
import {
  readFocusDescriptor,
  FOCUS_DESCRIPTOR_EVALUATOR,
  a8HeadingTextMatches,
  a8PlacementVerdict,
  a8GatesVerdict,
  a8CoverageVerdict,
  comparisonStateLabel,
  comparisonEdgeKey,
  comparisonIsUnexamined,
  longValueLayout,
  compareReadingOrder,
  fixtureResult,
  expectedCaseFor,
  expectedRecordKind,
  A8_TIMELINE_PROBE_FN,
  A8_ANALYSIS_PROBE_FN,
  technicalDetailsDisclosureReader,
  technicalDetailsModelVerdict,
  technicalDetailsFieldVerdict,
} from "../../cli/control-contexttrail.mjs";

let failures = 0;
const results = [];
const expect = (name, cond, detail) => {
  results.push({ name, ok: cond === true, detail: detail ?? null });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

/* ----------------------------- N83-1 call contract ------------------------ */

{
  // A locator stub faithful to the real Locator.evaluate contract: a FUNCTION
  // argument is serialized and invoked in-page with the element; a STRING is
  // evaluated as an expression — it never receives the element, and its value
  // (a function object) is not serializable, yielding null.
  const describe = { key: "elkey-1", role: "button", label: "Inspect evidence" };
  const fakeEl = { nodeName: "BUTTON" };
  const calls = [];
  const locator = {
    evaluate: async (arg) => {
      calls.push(typeof arg);
      if (typeof arg === "function") return arg.call(undefined, fakeEl);
      // String form: evaluate the expression; a function result is
      // unserializable — the descriptor is lost exactly as in the real run.
      const value = eval(arg); // eslint-disable-line no-eval — reproducing the engine semantics
      return typeof value === "function" ? undefined : value;
    },
  };
  globalThis.window = { __ctFocusDescribe: (el) => ({ ...describe, tag: el.nodeName }) };
  const desc = await readFocusDescriptor(locator);
  expect("N83-1: locator receives a real function and returns the descriptor",
    calls[0] === "function" && desc?.key === "elkey-1",
    `typeof arg=${calls[0]} desc=${JSON.stringify(desc)}`);
  // The old call shape, replayed through the same stub, is decisively null.
  const stale = await locator.evaluate(`(el) => (window.__ctFocusDescribe ? window.__ctFocusDescribe(el) : null)`);
  expect("N83-1: the old string-expression call shape cannot return a descriptor",
    stale === null || stale === undefined,
    `string evaluate returned ${JSON.stringify(stale)}`);
  // The serialized function source still runs against the real sampler
  // contract — exactly what Playwright does with Function.prototype.toString.
  const w = new JSDOM("", { runScripts: "outside-only" }).window;
  w.__ctFocusDescribe = (el) => ({ key: "k-" + el.id });
  const serialized = w.eval(`(${FOCUS_DESCRIPTOR_EVALUATOR.toString()})({id:"z"})`);
  expect("N83-1: serialized evaluator invokes __ctFocusDescribe with the element",
    serialized?.key === "k-z", JSON.stringify(serialized));
  delete globalThis.window;
}

/* ----------------------------- N83-2 headings ----------------------------- */

function jsdomPage(html) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    runScripts: "outside-only",
  });
  const w = dom.window;
  Object.defineProperty(w.HTMLElement.prototype, "innerText", {
    get() {
      return this.textContent ?? "";
    },
    configurable: true,
  });
  // Honest geometry: jsdom lays out nothing, so the effective-visibility
  // rendered-box check would zero every element. Elements carry a real box
  // unless a control overrides one to zero (the zero-box negative).
  Object.defineProperty(w.HTMLElement.prototype, "getBoundingClientRect", {
    value() {
      return { top: 10, left: 10, width: 200, height: 24, right: 210, bottom: 34 };
    },
    configurable: true,
    writable: true,
  });
  return {
    window: w,
    evaluate: async (src, arg) => (typeof src === "string" ? w.eval(src) : src(arg)),
  };
}

const ANALYSIS_WRAP = (inner) =>
  `<div id="ct-panel-analysis"><section aria-label="Analysis">${inner}</section></div>`;

// The probe's "Why this result" slice owns the gate list only through the
// unique, visible, correctly-named h3.
const gateProbe = async (headingMarkup) => {
  const page = jsdomPage(
    ANALYSIS_WRAP(
      `<h3>Comparison coverage</h3><p>t</p>
       ${headingMarkup}
       <h3>Reporting origins</h3><p>t</p>`,
    ),
  );
  return page.evaluate(A8_ANALYSIS_PROBE_FN);
};

const gateList = `<ul><li><p><span aria-hidden="true">✓ </span>Qualifying conflicts: passed</p><p>2 candidate(s)</p></li></ul>`;

{
  // Real product shape: authored mixed case + CSS uppercase transform.
  const s = await gateProbe(`<h3 style="text-transform:uppercase">Why this result</h3>${gateList}`);
  expect("N83-2: authored mixed-case heading under text-transform:uppercase owns its section",
    (s?.gateItems?.length ?? 0) === 1, `gateItems=${s?.gateItems?.length}`);
}
{
  // Rendered-case authored heading (what a browser's innerText reports under
  // the transform): semantic match must still find it.
  const s = await gateProbe(`<h3>WHY THIS RESULT</h3>${gateList}`);
  expect("N83-2: authored-uppercase heading owns its section (case-insensitive heading scope)",
    (s?.gateItems?.length ?? 0) === 1, `gateItems=${s?.gateItems?.length}`);
}
{
  const s = await gateProbe(`<h3>Why this outcome</h3>${gateList}`);
  expect("N83-2: wrong heading text owns nothing (RED)", (s?.gateItems?.length ?? 0) === 0,
    `gateItems=${s?.gateItems?.length}`);
}
{
  const s = await gateProbe(`${gateList}`);
  expect("N83-2: missing heading owns nothing (RED)", (s?.gateItems?.length ?? 0) === 0,
    `gateItems=${s?.gateItems?.length}`);
}
{
  const s = await gateProbe(`<h3 style="display:none">Why this result</h3>${gateList}`);
  expect("N83-2: hidden heading does not own a section (RED)", (s?.gateItems?.length ?? 0) === 0,
    `gateItems=${s?.gateItems?.length}`);
}
{
  const s = await gateProbe(
    `<h3>Why this result</h3><p>decoy</p><h3>Why this result</h3>${gateList}`,
  );
  expect("N83-2: duplicate matching headings are ambiguous — neither owns (RED)",
    (s?.gateItems?.length ?? 0) === 0, `gateItems=${s?.gateItems?.length}`);
}
{
  // A wrong heading must not leak into the OTHER sections either — the
  // Comparison coverage slice stays bound to its own heading.
  const s = await gateProbe(
    `<h3 style="text-transform:uppercase">Why this result</h3>${gateList}`,
  );
  expect("N83-2: gate list does not pool across sections", (s?.coverageText ?? null) === "t",
    `coverageText=${JSON.stringify(s?.coverageText)}`);
}

// Placement heading: authored-uppercase h3 under the real aria-label must read
// green through the REAL verdict; wrong/hidden/duplicate headings stay red.
{
  const placementCase = expectedCaseFor("controlled-placement-disputed-vs-unknown");
  const plRec = placementCase.visibleExpectations.find(
    (r) => expectedRecordKind(r, "controlled-placement-disputed-vs-unknown") === "placement",
  );
  const wantHeading = plRec.expectSectionHeading;
  const baseUndated = {
    sectionPresent: true,
    headingCount: 1,
    headingVisible: true,
    items: [
      { title: "a", text: "Date unknown No usable date was retrieved for this occurrence. The retrieved dates for this occurrence disagree." },
      { title: "b", text: "Date unknown No usable date was retrieved for this occurrence." },
    ],
  };
  const ids = ["ev-muiw5aiv-54", "ev-muiw5aiv-55"];
  const okSurface = {
    datedIdsOpened: ["ev-muiw5aiv-53"],
    undated: {
      ...baseUndated,
      // the DOM-authored string vs the browser-rendered transform
      heading: wantHeading,
      headingRendered: wantHeading.toUpperCase(),
    },
  };
  expect("N83-2: placement green with authored heading + uppercase render",
    a8PlacementVerdict(plRec, okSurface, ids).ok === true);
  expect("N83-2: placement green when authored text itself is uppercase",
    a8PlacementVerdict(plRec, {
      ...okSurface,
      undated: { ...okSurface.undated, heading: wantHeading.toUpperCase(), headingRendered: wantHeading.toUpperCase() },
    }, ids).ok === true);
  expect("N83-2: placement RED on wrong heading text",
    a8PlacementVerdict(plRec, {
      ...okSurface,
      undated: { ...okSurface.undated, heading: "Undated evidence", headingRendered: "UNDATED EVIDENCE" },
    }, ids).ok === false);
  expect("N83-2: placement RED on hidden heading",
    a8PlacementVerdict(plRec, {
      ...okSurface,
      undated: { ...okSurface.undated, headingVisible: false },
    }, ids).ok === false);
  expect("N83-2: placement RED on duplicate headings (wrong occurrence)",
    a8PlacementVerdict(plRec, {
      ...okSurface,
      undated: { ...okSurface.undated, headingCount: 2 },
    }, ids).ok === false);
  expect("N83-2: placement restored green on the same predicates",
    a8PlacementVerdict(plRec, okSurface, ids).ok === true);
}
{
  // Probe-level undated read: authored-uppercase h3 populates heading fields.
  const page = jsdomPage(
    `<div id="ct-panel-timeline"><ol></ol>
     <section aria-label="Evidence with unknown dates"><h3>ADDITIONAL EVIDENCE · DATE UNKNOWN</h3><ul><li><h3>t</h3><p>x</p></li></ul></section>
     </div>`,
  );
  const s = await page.evaluate(A8_TIMELINE_PROBE_FN);
  expect("N83-2: undated probe reads authored-uppercase heading, scoped to section-level h3",
    s?.undated?.heading === "ADDITIONAL EVIDENCE · DATE UNKNOWN" &&
      s?.undated?.headingCount === 1 &&
      s?.undated?.headingVisible === true &&
      s?.undated?.items?.length === 1,
    JSON.stringify({ h: s?.undated?.heading, n: s?.undated?.headingCount }));
}
{
  // The item-card h3 inside the undated li must not be counted as a second
  // section heading.
  const page = jsdomPage(
    `<div id="ct-panel-timeline"><section aria-label="Evidence with unknown dates"><h3>Additional evidence · date unknown</h3><ul><li><h3>Card title</h3></li><li><h3>Other card</h3></li></ul></section></div>`,
  );
  const s = await page.evaluate(A8_TIMELINE_PROBE_FN);
  expect("N83-2: item-card h3s are not section headings (scope > h3)",
    s?.undated?.headingCount === 1 && s?.undated?.heading === "Additional evidence · date unknown",
    `headingCount=${s?.undated?.headingCount}`);
}

/* --- N83-R2: EFFECTIVE visibility — own/ancestor opacity + CSS hiding + box --- */

{
  // opacity:0 on the heading itself leaves display/visibility normal — only
  // the effective check sees it. The gate list must not be owned.
  const page = jsdomPage(
    ANALYSIS_WRAP(`<h3>Comparison coverage</h3><p>t</p>
      <h3 style="opacity:0">Why this result</h3>${gateList}
      <h3>Reporting origins</h3><p>t</p>`),
  );
  const s = await page.evaluate(A8_ANALYSIS_PROBE_FN);
  expect("N83-R2: own opacity:0 heading owns nothing (RED)",
    (s?.gateItems?.length ?? 0) === 0, `gateItems=${s?.gateItems?.length}`);
}
{
  // An ANCESTOR with display:none hides the heading while its own computed
  // display stays normal — the ancestor walk must catch it.
  const page = jsdomPage(
    `<div id="ct-panel-analysis"><div style="display:none"><section aria-label="Analysis"><h3>Comparison coverage</h3><p>t</p>
      <h3>Why this result</h3>${gateList}
      <h3>Reporting origins</h3><p>t</p></section></div></div>`,
  );
  const s = await page.evaluate(A8_ANALYSIS_PROBE_FN);
  expect("N83-R2: ancestor display:none heading owns nothing (RED)",
    (s?.gateItems?.length ?? 0) === 0, `gateItems=${s?.gateItems?.length}`);
}
{
  // A zero-size rendered box is not a rendered heading.
  const page = jsdomPage(
    ANALYSIS_WRAP(`<h3>Comparison coverage</h3><p>t</p>
      <h3 id="zerobox">Why this result</h3>${gateList}
      <h3>Reporting origins</h3><p>t</p>`),
  );
  page.window.document.getElementById("zerobox").getBoundingClientRect = () =>
    ({ top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 });
  const s = await page.evaluate(A8_ANALYSIS_PROBE_FN);
  expect("N83-R2: zero rendered box heading owns nothing (RED)",
    (s?.gateItems?.length ?? 0) === 0, `gateItems=${s?.gateItems?.length}`);
}
{
  // Ancestor opacity:0 hides the whole subtree the same way.
  const page = jsdomPage(
    `<div id="ct-panel-analysis"><div style="opacity:0"><section aria-label="Analysis"><h3>Comparison coverage</h3><p>t</p>
      <h3>Why this result</h3>${gateList}
      <h3>Reporting origins</h3><p>t</p></section></div></div>`,
  );
  const s = await page.evaluate(A8_ANALYSIS_PROBE_FN);
  expect("N83-R2: ancestor opacity:0 heading owns nothing (RED)",
    (s?.gateItems?.length ?? 0) === 0, `gateItems=${s?.gateItems?.length}`);
}
{
  // Restored — same markup, visible heading owns its section again.
  const s = await gateProbe(`<h3 style="text-transform:uppercase">Why this result</h3>${gateList}`);
  expect("N83-R2: restored visible heading owns its section again",
    (s?.gateItems?.length ?? 0) === 1, `gateItems=${s?.gateItems?.length}`);
}
{
  // Timeline probe: undated heading opacity:0 → headingVisible false.
  const page = jsdomPage(
    `<div id="ct-panel-timeline"><section aria-label="Evidence with unknown dates"><h3 style="opacity:0">Additional evidence · date unknown</h3><ul><li><h3>t</h3><p>x</p></li></ul></section></div>`,
  );
  const s = await page.evaluate(A8_TIMELINE_PROBE_FN);
  expect("N83-R2: undated heading own opacity:0 → headingVisible false (RED surface)",
    s?.undated?.headingVisible === false && s?.undated?.headingCount === 1,
    `visible=${s?.undated?.headingVisible}`);
}
{
  // Timeline probe: hiding the undated SECTION ancestor reads invisible.
  const page = jsdomPage(
    `<div id="ct-panel-timeline"><section aria-label="Evidence with unknown dates" style="display:none"><h3>Additional evidence · date unknown</h3><ul><li><h3>t</h3><p>x</p></li></ul></section></div>`,
  );
  const s = await page.evaluate(A8_TIMELINE_PROBE_FN);
  expect("N83-R2: undated section display:none → headingVisible false (RED surface)",
    s?.undated?.headingVisible === false, `visible=${s?.undated?.headingVisible}`);
}

/* ----------------------------- N83-3 reading order ------------------------ */

/** Build a jsdom page whose elements carry scripted rects; the REAL
 *  longValueLayout runs inside the jsdom window so document/getComputedStyle/
 *  rect reads all behave as in-page. */
function layoutPage(html, rects) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    runScripts: "outside-only",
  });
  const w = dom.window;
  for (const el of w.document.querySelectorAll("[data-r]")) {
    const [top, left] = el.getAttribute("data-r").split(",").map(Number);
    Object.defineProperty(el, "getBoundingClientRect", {
      value: () => ({ top, left, width: 120, height: 24, right: left + 120, bottom: top + 24 }),
    });
  }
  return {
    evaluate: async (fn, arg) => w.eval(`(${fn.toString()})(${JSON.stringify(arg)})`),
    window: w,
  };
}

const pad = (s) => `${s} — ${"x".repeat(30)}`;

{
  // Pure single-column flow in correct order.
  const page = layoutPage(
    `<div id="ct-panel-sources"><section aria-label="Sources"><ul>
       <li><p data-r="100,0">${pad("first source")}</p></li>
       <li><p data-r="140,0">${pad("second source")}</p></li>
       <li><p data-r="180,0">${pad("third source")}</p></li></ul></section></div>`,
  );
  const l = await longValueLayout(page, { panelId: "ct-panel-sources" });
  expect("N83-3: ordered single-column flow is green",
    compareReadingOrder(l) === true, `inversions=${l.inversions}`);
}
{
  // The Sources direct-li column-reverse fault: DOM order untouched, visual
  // order bottom-to-top — the first-failure family from the native review.
  const page = layoutPage(
    `<div id="ct-panel-sources"><section aria-label="Sources"><ul>
       <li><p data-r="180,0">${pad("first source")}</p></li>
       <li><p data-r="140,0">${pad("second source")}</p></li>
       <li><p data-r="100,0">${pad("third source")}</p></li></ul></section></div>`,
  );
  const l = await longValueLayout(page, { panelId: "ct-panel-sources" });
  expect("N83-3: reversed flow (Sources column-reverse fault) is RED",
    compareReadingOrder(l) === false && l.inversions > 0, `inversions=${l.inversions}`);
}
{
  // Overview desktop: the product deliberately renders aside LEFT of section
  // via lg:order while DOM keeps result-first — sibling columns of one grid
  // are independent reading streams, never an inversion.
  const page = layoutPage(
    `<div id="ct-panel-overview" style="display:grid;grid-template-columns:1fr 2fr">
       <section aria-label="Investigation result"><p data-r="100,420">${pad("result text")}</p><p data-r="140,420">${pad("more result")}</p></section>
       <aside aria-label="Submitted material"><p data-r="100,0">${pad("submitted claim")}</p></aside>
     </div>`,
  );
  const l = await longValueLayout(page, { panelId: "ct-panel-overview" });
  expect("N83-3: DOM-second column rendered left (Overview order-flip) is green",
    compareReadingOrder(l) === true,
    `inversions=${l.inversions} seq=${JSON.stringify(l.visualDomSequence)}`);
}
{
  // Within-column reversal inside one column of a multi-column grid: still a
  // genuine inversion, exempting cross-column pairs must not mask it.
  const page = layoutPage(
    `<div id="ct-panel-analysis" style="display:grid;grid-template-columns:1fr 1fr">
       <div><p data-r="140,0">${pad("left first")}</p><p data-r="100,0">${pad("left second")}</p></div>
       <div><p data-r="100,300">${pad("right first")}</p><p data-r="140,300">${pad("right second")}</p></div>
     </div>`,
  );
  const l = await longValueLayout(page, { panelId: "ct-panel-analysis" });
  expect("N83-3: within-column reversal inside a two-column grid is RED",
    compareReadingOrder(l) === false && l.inversions > 0,
    `inversions=${l.inversions} seq=${JSON.stringify(l.visualDomSequence)}`);
}
{
  // Normal two-column layout: each column ordered internally, columns side by
  // side — the whole panel green.
  const page = layoutPage(
    `<div id="ct-panel-analysis" style="display:grid;grid-template-columns:1fr 1fr">
       <div><p data-r="100,0">${pad("left first")}</p><p data-r="140,0">${pad("left second")}</p></div>
       <div><p data-r="100,300">${pad("right first")}</p><p data-r="140,300">${pad("right second")}</p></div>
     </div>`,
  );
  const l = await longValueLayout(page, { panelId: "ct-panel-analysis" });
  expect("N83-3: normal two-column layout is green", compareReadingOrder(l) === true,
    `inversions=${l.inversions}`);
}
{
  // Container/descendant double-counting: a long div wrapping a long p must
  // contribute exactly one row — the leaf.
  const page = layoutPage(
    `<div id="ct-panel-sources"><div><p data-r="100,0">${pad("leaf text")}</p></div><p data-r="140,0">${pad("second leaf")}</p></div>`,
  );
  const l = await longValueLayout(page, { panelId: "ct-panel-sources" });
  expect("N83-3: container+descendant collapse to the leaf (no double count)",
    l.rows.length === 2, `rows=${l.rows.length} texts=${JSON.stringify(l.rows.map((r) => r.text.slice(0, 12)))}`);
}
{
  // Restored layout — reversal applied then removed — is green again.
  const page = layoutPage(
    `<div id="ct-panel-sources"><section aria-label="Sources"><ul>
       <li><p data-r="100,0">${pad("first source")}</p></li>
       <li><p data-r="140,0">${pad("second source")}</p></li></ul></section></div>`,
  );
  const l = await longValueLayout(page, { panelId: "ct-panel-sources" });
  expect("N83-3: restored layout is green again", compareReadingOrder(l) === true);
}

/* ----------------------------- N83-4 performed set ------------------------ */

{
  const pairCase = expectedCaseFor("controlled-pair");
  const covRec = pairCase.visibleExpectations.find(
    (r) => expectedRecordKind(r, "controlled-pair") === "analysis-coverage",
  );
  const terminal = fixtureResult("controlled-pair");
  const edges = terminal.comparisons;
  // Rendered rows: every recorded edge, honestly labeled, endpoints present.
  const rows = edges.map((e) => ({
    text: `${comparisonStateLabel(e.connector)} · between two retrieved occurrences Earlier: ${e.fromOccurrenceId} Later: ${e.toOccurrenceId}`,
    buttons: 2,
  }));
  const opened = edges.map(comparisonEdgeKey);
  const covSurface = {
    coverageText: "Context comparisons: 2 pairs compared across 4 selected of 4 eligible occurrences.",
    performedRows: rows,
  };
  expect("N83-4: pair case green — all rows labeled, performed set = comparedPairIds",
    a8CoverageVerdict(covRec, covSurface, opened, terminal).ok === true,
    a8CoverageVerdict(covRec, covSurface, opened, terminal).detail);
  // Phantom performed id: a comparedPairId that resolves to no examined edge.
  const phantom = { ...covRec, expect: { ...covRec.expect, comparedPairIds: [...covRec.expect.comparedPairIds, "ev-x|ev-y"] } };
  expect("N83-4: phantom comparedPairId is RED",
    a8CoverageVerdict(phantom, covSurface, opened, terminal).ok === false);
  // Missing performed edge: terminal drops one compared edge.
  const dropped = { ...terminal, comparisons: edges.filter((e) => comparisonEdgeKey(e) !== covRec.expect.comparedPairIds[0]) };
  const droppedSurface = { ...covSurface, performedRows: rows.slice(1) };
  expect("N83-4: a compared pair with no recorded edge is RED",
    a8CoverageVerdict(covRec, droppedSurface, opened.slice(1), dropped).ok === false);
  // Wrong performed endpoint: the opened key is not the recorded pair.
  const wrongOpened = [...opened];
  wrongOpened[0] = "ev-muiw5agf-26|ev-WRONG";
  expect("N83-4: wrong performed endpoint is RED",
    a8CoverageVerdict(covRec, covSurface, wrongOpened, terminal).ok === false);
  // Promotion: the unexamined edge appears inside comparedPairIds.
  const unexaminedKey = comparisonEdgeKey(edges.find(comparisonIsUnexamined));
  const promoted = { ...covRec, expect: { ...covRec.expect, comparedPairIds: [...covRec.expect.comparedPairIds, unexaminedKey] } };
  expect("N83-4: promoting an unexamined edge into comparedPairIds is RED",
    a8CoverageVerdict(promoted, covSurface, opened, terminal).ok === false);
  // Dishonest label: a performed edge rendered as "Not compared".
  const dishonest = {
    ...covSurface,
    performedRows: rows.map((r, i) => (i === 0 ? { ...r, text: "Not compared in this investigation" } : r)),
  };
  expect("N83-4: a performed edge mislabeled as unexamined is RED",
    a8CoverageVerdict(covRec, dishonest, opened, terminal).ok === false);
  // Unexamined row opened into the compared set.
  const promotedOpen = [...opened];
  promotedOpen[1] = covRec.expect.comparedPairIds[0];
  expect("N83-4: the unexamined row opening a compared id is RED",
    a8CoverageVerdict(covRec, covSurface, promotedOpen, terminal).ok === false);
  // Restored.
  expect("N83-4: restored compared set is green again",
    a8CoverageVerdict(covRec, covSurface, opened, terminal).ok === true);
  // N83-R4: per-row binding — swapping two performed rows' opened keys leaves
  // the performed SET unchanged, so only per-row identity catches it.
  const swapped = [...opened];
  [swapped[0], swapped[2]] = [swapped[2], swapped[0]];
  expect("N83-R4: performed rows 0/2 opening each other's pairs is RED",
    a8CoverageVerdict(covRec, covSurface, swapped, terminal).ok === false);
  // Reversed orientation on a single row is a wrong target, not the same pair.
  const reversed = [...opened];
  reversed[0] = `${edges[0].toOccurrenceId}|${edges[0].fromOccurrenceId}`;
  expect("N83-R4: reversed endpoints on one performed row are RED",
    a8CoverageVerdict(covRec, covSurface, reversed, terminal).ok === false);
  // Wrong unexamined endpoint: red as a wrong target — never promotion.
  const wrongUnx = [...opened];
  wrongUnx[1] = "wrong-unexamined|wrong-unexamined";
  const vUnx = a8CoverageVerdict(covRec, covSurface, wrongUnx, terminal);
  expect("N83-R4: wrong unexamined endpoint is RED without status/count promotion",
    vUnx.ok === false && /row 1/.test(vUnx.detail), vUnx.detail);
  // A performed row whose endpoints never opened is red (null is not valid).
  const unopened = [...opened];
  unopened[0] = null;
  expect("N83-R4: an unopened performed row is RED",
    a8CoverageVerdict(covRec, covSurface, unopened, terminal).ok === false);
  // N83-R4 acquisition: an ATTEMPTED open with an unreadable identity is a
  // failed observation — NOT the unopenable state — on any row status.
  const unreadableUnx = [...opened];
  unreadableUnx[1] = { offered: 2, attempted: true, from: null, to: null, key: null };
  const vUnreadable = a8CoverageVerdict(covRec, covSurface, unreadableUnx, terminal);
  expect("N83-R4: unexamined row whose two opens return no IDs is RED",
    vUnreadable.ok === false && /identity read incomplete/.test(vUnreadable.detail), vUnreadable.detail);
  // Same when only ONE endpoint identity is missing — either side.
  const missFirst = [...opened];
  missFirst[1] = { offered: 2, attempted: true, from: null, to: edges[1].toOccurrenceId, key: null };
  expect("N83-R4: missing first endpoint identity is RED",
    a8CoverageVerdict(covRec, covSurface, missFirst, terminal).ok === false);
  const missSecond = [...opened];
  missSecond[1] = { offered: 2, attempted: true, from: edges[1].fromOccurrenceId, to: null, key: null };
  expect("N83-R4: missing second endpoint identity is RED",
    a8CoverageVerdict(covRec, covSurface, missSecond, terminal).ok === false);
  // Same failure on a performed row stays red.
  const unreadablePerf = [...opened];
  unreadablePerf[0] = { offered: 2, attempted: true, from: null, to: null, key: null };
  expect("N83-R4: performed row whose opens return no IDs is RED",
    a8CoverageVerdict(covRec, covSurface, unreadablePerf, terminal).ok === false);
  // Genuinely unopenable — the row offered no controls — is a separate honest
  // state on an unexamined edge: allowed, and explicitly reported.
  const noControls = [...opened];
  noControls[1] = { offered: 0, attempted: false, from: null, to: null, key: null };
  const vNoCtl = a8CoverageVerdict(covRec, covSurface, noControls, terminal);
  expect("N83-R4: unopenable unexamined row stays green and is declared",
    vNoCtl.ok === true && /unopenableRows=\[1\]/.test(vNoCtl.detail), vNoCtl.detail);
  // But the same unopenable state on a PERFORMED row is still red.
  const noCtlPerf = [...opened];
  noCtlPerf[0] = { offered: 0, attempted: false, from: null, to: null, key: null };
  expect("N83-R4: unopenable performed row is RED",
    a8CoverageVerdict(covRec, covSurface, noCtlPerf, terminal).ok === false);
  // A positive but INCOMPLETE control count — exactly one endpoint control —
  // is not the zero-controls state: red on any row.
  const oneCtlUnx = [...opened];
  oneCtlUnx[1] = { offered: 1, attempted: false, from: null, to: null, key: null };
  const vOneCtl = a8CoverageVerdict(covRec, covSurface, oneCtlUnx, terminal);
  expect("N83-R4: single offered control on the unexamined row is RED",
    vOneCtl.ok === false && /offered 1 endpoint/.test(vOneCtl.detail), vOneCtl.detail);
  const oneCtlPerf = [...opened];
  oneCtlPerf[0] = { offered: 1, attempted: false, from: null, to: null, key: null };
  expect("N83-R4: single offered control on a performed row is RED",
    a8CoverageVerdict(covRec, covSurface, oneCtlPerf, terminal).ok === false);
  // Restored after the acquisition mutations.
  expect("N83-R4: restored acquisition state is green again",
    a8CoverageVerdict(covRec, covSurface, opened, terminal).ok === true);
  // Helper sanity: the connector semantics match the pin's COMPARISON_COPY.
  expect("N83-4: uncertain counts as performed, unexamined never",
    comparisonIsUnexamined(edges[1]) === true &&
      comparisonIsUnexamined(edges[2]) === false &&
      comparisonStateLabel("uncertain") === "Comparison inconclusive — performed but not established" &&
      comparisonStateLabel("unexamined") === "Not compared in this investigation");
}

/* ------------- native-002: Technical-details reader on the real 7b shape --- */

{
  // Pin-faithful disclosure: retrieval rows as dl>div>dt/dd; the model as the
  // " · jev-1.13.0" suffix of the classification heading <p>; page-metadata
  // <dl>s nested under their own blocks (Type/Headline, og:*) — the surfaces
  // the actual product renders at 7b18c16.
  const TD_DL = `
    <dl class="mt-2 space-y-1 text-xs text-white/70">
      <div class="flex gap-2"><dt>Search ids:</dt><dd>fixture-lens-a8</dd></div>
      <div class="flex gap-2"><dt>Retrieval engine:</dt><dd>Google Lens</dd></div>
      <div class="flex gap-2"><dt>Result type:</dt><dd>Exact match</dd></div>
      <div class="flex gap-2"><dt>Result position:</dt><dd>1</dd></div>
      <div class="flex gap-2"><dt>Source URL:</dt><dd>https://conflict-alpha.test/controlled/1</dd></div>
      <div class="flex gap-2"><dt>Canonical URL:</dt><dd>https://conflict-alpha.test/controlled/1</dd></div>
      <div class="flex gap-2"><dt>Media relationship:</dt><dd>Exact match — reported by Google Lens</dd></div>
      <div class="flex gap-2"><dt>Publication-date source:</dt><dd>Page structured data</dd></div>
      <div class="flex gap-2"><dt>Retrieved at:</dt><dd>2026-09-26T21:17:45.919Z</dd></div>
    </dl>`;
  const TD_META = `
    <div class="mt-3"><p>Page metadata</p>
      <ul><li><span>Structured data root_entity:</span>
        <dl><div><dt>Type:</dt><dd>NewsArticle</dd></div>
            <div><dt>Headline:</dt><dd>CONTROLLED article</dd></div>
            <div><dt>Retrieved at:</dt><dd>WRONG-METADATA-VALUE</dd></div></dl>
      </li></ul>
      <dl><div><dt>og:title:</dt><dd>CONTROLLED article</dd></div></dl>
    </div>`;
  const tdDom = (inner) =>
    new JSDOM(`<details><summary>Technical details</summary>${inner}
      <p class="mt-3 break-all text-xs text-white/60">Occurrence ID: ev-x</p></details>`)
      .window.document.querySelector("details");

  const goodCls = `<div class="mt-3"><p>Classification question answers · jev-1.13.0</p>
    <p>These are the classification model's answers…</p></div>`;

  // Positive: the real structure discharges all three readers.
  let d = tdDom(TD_DL + goodCls + TD_META);
  let td = technicalDetailsDisclosureReader(d);
  expect("TD: scoped read returns exactly the 9 retrieval fields",
    td.fieldCount === 9 && td.labels.length === 9 &&
      !td.labels.some((l) => /^(Type|Headline|og:title)$/.test(l)),
    JSON.stringify(td.labels));
  const tdPairs = td.labels.map((l, i) => [l, td.values[i] ?? ""]);
  const m = technicalDetailsModelVerdict(td.modelParas, "jev-1.13.0");
  expect("TD: classification heading suffix binds the model verbatim", m.ok === true,
    JSON.stringify(m));
  const ts = technicalDetailsFieldVerdict(tdPairs, /^retrieved at$/i, "2026-09-26T21:17:45.919Z");
  expect("TD: 'Retrieved at' binds the fixture timestamp, page-metadata dl not flattened",
    ts.ok === true && ts.candidates === 1, JSON.stringify(ts));

  // Missing model paragraph (distributions absent — the product renders
  // "No classification answers were recorded").
  td = technicalDetailsDisclosureReader(
    tdDom(TD_DL + `<p>No classification answers were recorded for this occurrence.</p>` + TD_META));
  const mMiss = technicalDetailsModelVerdict(td.modelParas, "jev-1.13.0");
  expect("TD: absent classification heading is a missing candidate, not a pass",
    mMiss.ok === false && mMiss.candidates === 0 && mMiss.rendered === null, JSON.stringify(mMiss));

  // Wrong model suffix.
  const mWrong = technicalDetailsModelVerdict(
    ["Classification question answers · jev-0.0.0"], "jev-1.13.0");
  expect("TD: wrong model suffix is RED", mWrong.ok === false, JSON.stringify(mWrong));

  // Heading present but model suffix absent (product renders label only).
  const mBare = technicalDetailsModelVerdict(["Classification question answers"], "jev-1.13.0");
  expect("TD: heading without a model suffix is RED", mBare.ok === false && mBare.rendered === null);

  // Duplicate classification headings — ambiguous scope, never a pass.
  td = technicalDetailsDisclosureReader(tdDom(TD_DL + goodCls + goodCls));
  const mDup = technicalDetailsModelVerdict(td.modelParas, "jev-1.13.0");
  expect("TD: duplicate classification headings are RED",
    mDup.ok === false && mDup.candidates === 2, JSON.stringify(mDup));

  // Wrong scope: the model text living in a DIFFERENT disclosure or in an
  // unrelated paragraph must never satisfy this occurrence's disclosure.
  td = technicalDetailsDisclosureReader(
    tdDom(TD_DL + `<p>Provider report · jev-1.13.0</p>` + TD_META));
  const mScope = technicalDetailsModelVerdict(td.modelParas, "jev-1.13.0");
  expect("TD: jev-1.13.0 in an unrelated paragraph cannot pass",
    mScope.ok === false && mScope.candidates === 0);
  const otherDetails = new JSDOM(`<div>
      <details><summary>Other</summary><p>Classification question answers · jev-1.13.0</p></details>
      <details><summary>Technical details</summary>${TD_DL}${TD_META}</details>
    </div>`).window.document;
  td = technicalDetailsDisclosureReader(otherDetails.querySelectorAll("details")[1]);
  const mOther = technicalDetailsModelVerdict(td.modelParas, "jev-1.13.0");
  expect("TD: a sibling disclosure's model suffix is out of scope",
    mOther.ok === false && mOther.candidates === 0, JSON.stringify(mOther));

  // Old-surface negative: the pre-7ab28e9 "Model version"/"Retrieval
  // timestamp" dt rows are now the WRONG surface — both must reject.
  const oldDl = `<dl><div><dt>Model version:</dt><dd>jev-1.13.0</dd></div>
    <div><dt>Retrieval timestamp:</dt><dd>2026-09-26T21:17:45.919Z</dd></div></dl>`;
  td = technicalDetailsDisclosureReader(tdDom(oldDl + goodCls));
  const mOld = technicalDetailsModelVerdict(td.modelParas, "jev-1.13.0");
  const tsOld = technicalDetailsFieldVerdict(
    td.labels.map((l, i) => [l, td.values[i] ?? ""]), /^retrieved at$/i, "2026-09-26T21:17:45.919Z");
  expect("TD: the heading is the sole model authority — a stray 'Model version' dt row is neither required nor consulted",
    mOld.ok === true);
  expect("TD: the obsolete 'Retrieval timestamp' label is RED under the current surface",
    tsOld.ok === false && tsOld.candidates === 0, JSON.stringify(tsOld));

  // Missing timestamp label, duplicate labels, wrong value — all reject.
  td = technicalDetailsDisclosureReader(tdDom(TD_DL.replace("Retrieved at:", "Collected at:")));
  const tsNone = technicalDetailsFieldVerdict(
    td.labels.map((l, i) => [l, td.values[i] ?? ""]), /^retrieved at$/i, "x");
  expect("TD: missing 'Retrieved at' is RED", tsNone.ok === false && tsNone.candidates === 0);
  const tsDup = technicalDetailsFieldVerdict(
    [["Retrieved at", "a"], ["Retrieved at", "a"]], /^retrieved at$/i, "a");
  expect("TD: duplicate 'Retrieved at' rows are RED", tsDup.ok === false && tsDup.candidates === 2);
  const tsBad = technicalDetailsFieldVerdict(
    [["Retrieved at", "2020-01-01T00:00:00.000Z"]], /^retrieved at$/i, "2026-09-26T21:17:45.919Z");
  expect("TD: wrong timestamp value is RED", tsBad.ok === false);

  // The model string as ordinary body text (a dd value in a nested, non-primary
  // list) is never a candidate.
  td = technicalDetailsDisclosureReader(
    tdDom(TD_DL + `<div><dl><div><dt>Note:</dt><dd>jev-1.13.0</dd></div></dl></div>`));
  const mBody = technicalDetailsModelVerdict(td.modelParas, "jev-1.13.0");
  expect("TD: jev-1.13.0 carried in a dd value cannot satisfy the model check",
    mBody.ok === false && mBody.candidates === 0);

  // A second top-level retrieval list is ambiguous scope — both are ignored
  // (listCount≠1 zeroes the field read).
  td = technicalDetailsDisclosureReader(tdDom(TD_DL + TD_DL));
  expect("TD: two top-level retrieval lists are ambiguous — no fields bound",
    td.listCount === 2 && td.fieldCount === 0);

  // No disclosure-level dl: field count zero (never a pass).
  td = technicalDetailsDisclosureReader(tdDom(goodCls));
  expect("TD: disclosure without its own retrieval dl yields zero fields",
    td.fieldCount === 0 && td.labels.length === 0);
}

console.log(
  JSON.stringify({ control: "n83-contracts", checks: results.length, failures, ok: failures === 0 }),
);
console.log(failures === 0 ? "PASS: n83 predicates discriminate" : `FAIL: ${failures} expectation(s) failed`);
process.exit(failures === 0 ? 0 : 1);
