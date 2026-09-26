/**
 * Offline derivative of the RO5 reading-order target predicates.
 *
 * With no reading fault requested, the honest requirement is that no sabotage
 * target exists at all — the requested panel is established by the PRECEDING
 * check (result.measurement-surface-is-the-requested-panel). Conditioning on
 * "Sources" here made every other valid --view a false red, which is the RO5
 * defect. This exercises the REAL exported predicates: all four ordinary views
 * positive, a non-null unexpected target negative, a wrong panel RED through
 * the actual preceding check, and the fault-requested branch still requiring
 * the real applied target.
 *
 *   node fixtures/controls/reading-order-target.mjs
 */
import { readingOrderTargetOk, measurementSurfaceOk } from "../../cli/control-contexttrail.mjs";

let failures = 0;
const expect = (name, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

const VIEWS = ["Overview", "Timeline", "Sources", "Analysis"];
const panel = (view) => ({ observedTab: view, panelId: `ct-panel-${view.toLowerCase()}`, settled: true });
const target = (panelId) => ({ panelId, tab: "Sources", selector: `#${panelId} section > ul`, directRows: 3, applied: true });

// Positives: every ordinary requested view passes with no fault and no target.
for (const v of VIEWS) {
  expect(`no-fault ${v}: measurement surface is the requested panel`, measurementSurfaceOk(v, panel(v)) === true);
  expect(`no-fault ${v}: null target accepted`, readingOrderTargetOk(null, null, panel(v).panelId) === true);
}

// The RO5 defect demonstrated against the OLD formula: requiring observedTab
// "Sources" unconditionally made a valid non-Sources view red.
const oldFormula = (view) => measurementSurfaceOk(view, panel(view)) && panel(view).observedTab === "Sources";
expect("old formula was a false red for Timeline", oldFormula("Timeline") === false);
expect("new predicate accepts Timeline", measurementSurfaceOk("Timeline", panel("Timeline")) && readingOrderTargetOk(null, null, "ct-panel-timeline"));

// Negative: a sabotage target present with NO fault requested must fail.
expect(
  "no-fault + unexpected non-null target is RED",
  readingOrderTargetOk(null, target("ct-panel-sources"), "ct-panel-sources") === false,
);

// Wrong requested panel goes RED through the actual preceding check, not the
// target predicate.
expect(
  "requested Overview but observed Sources: preceding check is RED",
  measurementSurfaceOk("Overview", { observedTab: "Sources", panelId: "ct-panel-sources", settled: true }) === false,
);
expect(
  "unsettled panel: preceding check is RED",
  measurementSurfaceOk("Overview", { observedTab: "Overview", panelId: "ct-panel-overview", settled: false }) === false,
);

// Fault-requested branch still requires the real applied target on the
// measured panel.
expect(
  "reading fault + real target on measured panel accepted",
  readingOrderTargetOk("reading-order-reversed", target("ct-panel-sources"), "ct-panel-sources") === true,
);
expect(
  "reading fault + target on the WRONG panel is RED",
  readingOrderTargetOk("reading-order-reversed", target("ct-panel-overview"), "ct-panel-sources") === false,
);
expect(
  "reading fault + no target is RED",
  readingOrderTargetOk("reading-order-reversed", null, "ct-panel-sources") === false,
);
expect(
  "reading fault + target that never applied is RED",
  readingOrderTargetOk("reading-order-reversed", { ...target("ct-panel-sources"), applied: false }, "ct-panel-sources") === false,
);
expect(
  "reading fault + a single-row list cannot prove reversal (directRows<2) is RED",
  readingOrderTargetOk("reading-order-reversed", { ...target("ct-panel-sources"), directRows: 1 }, "ct-panel-sources") === false,
);
expect(
  "restored variant still requires the applied target",
  readingOrderTargetOk("reading-order-restored", { ...target("ct-panel-sources"), restored: true }, "ct-panel-sources") === true,
);

// An unrelated fault must not satisfy the reading-order requirement either.
expect(
  "non-reading fault + target present is RED",
  readingOrderTargetOk("long-value-truncated", target("ct-panel-sources"), "ct-panel-sources") === false,
);
expect(
  "non-reading fault + no target accepted",
  readingOrderTargetOk("long-value-truncated", null, "ct-panel-sources") === true,
);

console.log(failures === 0 ? "PASS: the predicates discriminate" : `FAIL: ${failures} expectation(s) failed`);
process.exit(failures === 0 ? 0 : 1);
