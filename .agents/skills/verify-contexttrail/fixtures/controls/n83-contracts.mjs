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
  // Helper sanity: the connector semantics match the pin's COMPARISON_COPY.
  expect("N83-4: uncertain counts as performed, unexamined never",
    comparisonIsUnexamined(edges[1]) === true &&
      comparisonIsUnexamined(edges[2]) === false &&
      comparisonStateLabel("uncertain") === "Comparison inconclusive — performed but not established" &&
      comparisonStateLabel("unexamined") === "Not compared in this investigation");
}

console.log(
  JSON.stringify({ control: "n83-contracts", checks: results.length, failures, ok: failures === 0 }),
);
console.log(failures === 0 ? "PASS: n83 predicates discriminate" : `FAIL: ${failures} expectation(s) failed`);
process.exit(failures === 0 ? 0 : 1);
