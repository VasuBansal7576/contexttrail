/**
 * Offline derivative of the accepted A10 selected-panel contrast semantics.
 *
 * The maintained contrast path resolves the selected tab's own aria-controls
 * panel, asserts every measured node belongs to that panel, folds OWN opacity
 * and ancestor opacity into the effective foreground alpha, and returns
 * verdict UNSUPPORTED for every group-forming ancestor with opacity < 1 — a
 * non-pass whose diagnostic contrastRatio is never an accepted number.
 *
 * The canvas/brightness math itself runs in-page (EFFECTIVE_CONTRAST_FN), so
 * this control exercises the REAL exported verdict and scope predicates plus a
 * parse check on the page-side source: unit-opacity positives can pass, every
 * UNSUPPORTED and low-opacity shape is a non-pass, and a panel-scope record
 * that does not resolve to the selected tab's own tabpanel is RED.
 *
 *   node fixtures/controls/contrast-panel.mjs
 */
import {
  aaThreshold,
  contrastVerdictFor,
  panelScopeOk,
  panelContractPopulated,
  PANEL_NODE_TARGETS,
  EFFECTIVE_CONTRAST_FN,
  PANEL_MEASURE_FN,
} from "../../cli/control-contexttrail.mjs";

let failures = 0;
const results = [];
const expect = (name, cond, detail) => {
  results.push({ name, ok: cond === true, detail: detail ?? null });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

for (const [name, src] of Object.entries({ EFFECTIVE_CONTRAST_FN, PANEL_MEASURE_FN })) {
  let ok = true;
  try {
    new Function(`return ${src}`);
  } catch {
    ok = false;
  }
  expect(`${name} parses as a page-side function`, ok);
}

// Synthetic node records in exactly the shape EFFECTIVE_CONTRAST_FN returns,
// including the rendered-visibility record the verdict now requires.
const node = (over = {}) => ({
  tag: "P",
  fontSizePx: 14,
  fontWeight: "400",
  ownOpacity: 1,
  ownColorAlpha: 1,
  effectiveAlpha: 1,
  ancestorOpacityProduct: 1,
  groupBreaks: [],
  unsupportedLayerConfigurations: [],
  contrastRatio: 7.2,
  verdict: "COMPUTED",
  rendered: true,
  display: "block",
  visibility: "visible",
  rect: { width: 320, height: 21 },
  hiddenByAncestor: null,
  ...over,
});

// AA thresholds.
expect("normal text threshold is 4.5", aaThreshold(14, "400").threshold === 4.5);
expect(">=24px text threshold is 3.0", aaThreshold(24, "400").threshold === 3.0);
expect(">=18.66px bold text threshold is 3.0", aaThreshold(19, "700").threshold === 3.0);
expect("18.66px regular text is still normal", aaThreshold(19, "400").threshold === 4.5);

// Positives.
expect(
  "a unit-opacity computed node above threshold can pass",
  contrastVerdictFor(node({ contrastRatio: 7.2 }), 4.5).pass === true,
);
expect(
  "a computed node exactly at threshold passes",
  contrastVerdictFor(node({ contrastRatio: 4.5 }), 4.5).pass === true,
);

// Negatives: every unmodelled/opacity-degraded shape is a non-pass, even when a
// diagnostic ratio is present — the number is not an accepted contrast result.
expect(
  "an UNSUPPORTED opaque group break is a non-pass despite a diagnostic ratio",
  contrastVerdictFor(
    node({ verdict: "UNSUPPORTED", contrastRatio: 12.4, unsupportedLayerConfigurations: [{ tag: "DIV", opacity: 0.98, backgroundShape: "opaque" }] }),
    4.5,
  ).pass === false,
);
expect(
  "an UNSUPPORTED translucent group break is a non-pass despite a diagnostic ratio",
  contrastVerdictFor(
    node({ verdict: "UNSUPPORTED", contrastRatio: 21.0, unsupportedLayerConfigurations: [{ tag: "DIV", opacity: 0.5, backgroundShape: "translucent" }] }),
    4.5,
  ).pass === false,
);
expect(
  "a below-threshold computed node is a non-pass",
  contrastVerdictFor(node({ contrastRatio: 3.1 }), 4.5).pass === false,
);
expect(
  "a missing ratio is a non-pass",
  contrastVerdictFor(node({ contrastRatio: null }), 4.5).pass === false,
);
expect(
  "a null node is a non-pass",
  contrastVerdictFor(null, 4.5).pass === false,
);
expect(
  "an unknown verdict is a non-pass",
  contrastVerdictFor(node({ verdict: "MAYBE" }), 4.5).pass === false,
);

// Visibility prerequisite (F38-2): contrast is accepted only on a node the
// user can actually see — hidden, ancestor-hidden and boxless targets are
// non-pass even with a computed ratio above threshold.
expect(
  "a display:none node is a non-pass despite a good ratio",
  contrastVerdictFor(node({ rendered: false, display: "none", rect: { width: 0, height: 0 } }), 4.5).pass === false,
);
expect(
  "a visibility:hidden node is a non-pass despite a good ratio",
  contrastVerdictFor(node({ rendered: false, visibility: "hidden" }), 4.5).pass === false,
);
expect(
  "an ancestor-hidden node is a non-pass despite a good ratio",
  contrastVerdictFor(node({ rendered: false, hiddenByAncestor: { tag: "SECTION", display: "none" } }), 4.5).pass === false,
);
expect(
  "a node with no painted rect is a non-pass despite a good ratio",
  contrastVerdictFor(node({ rendered: false, rect: { width: 0, height: 0 } }), 4.5).pass === false,
);
expect(
  "a node without a rendered record at all is a non-pass (fail-closed)",
  contrastVerdictFor(node({ rendered: undefined }), 4.5).pass === false,
);

// Panel scope: the measurement surface must resolve to the selected tab's own
// aria-controls panel — the defect this corrects was a broad union that
// measured shared headers.
const scope = (over = {}) => ({
  observedTab: "Sources",
  tabAriaControls: "ct-panel-sources",
  panelId: "ct-panel-sources",
  panelExists: true,
  panelRole: "tabpanel",
  settled: true,
  ...over,
});
expect("a resolved selected panel is in scope", panelScopeOk(scope()) === true);
expect("no aria-controls on the tab is RED", panelScopeOk(scope({ tabAriaControls: null })) === false);
expect("a missing panel is RED", panelScopeOk(scope({ panelExists: false })) === false);
expect("a panel id that is not the tab's aria-controls is RED", panelScopeOk(scope({ panelId: "ct-panel-overview" })) === false);
expect("a panel without role=tabpanel is RED", panelScopeOk(scope({ panelRole: null })) === false);
expect("a null scope record is RED", panelScopeOk(null) === false);

// The accepted node set is scoped per view and names real, contract-bound
// content targets — never the shared ContextTrail header or a bare action
// link. Every entry carries a populated selector (a bare selector string or
// a scoped {selector, scope?, nth?} spec resolved inside the panel) and the
// contract that decides whether it is owed; contract-empty targets name the
// explanation node that must render instead (F38-3, V39-4).
const selOk = (s) => typeof s === "string" || (s !== null && typeof s === "object" && typeof s.selector === "string");
for (const [view, targets] of Object.entries(PANEL_NODE_TARGETS)) {
  expect(
    `${view} panel targets name ${targets.length} contract-bound content node(s)`,
    targets.length > 0 &&
      targets.every(
        (t) =>
          typeof t.key === "string" &&
          selOk(t.populated) &&
          typeof t.populatedWhen === "string" &&
          typeof t.note === "string" &&
          (t.populatedWhen === "always" ||
            (t.populatedWhen === "accountingRows" && t.absentOk === true) ||
            (t.empty && selOk(t.empty.selector ?? t.empty) && typeof t.empty.text === "string")),
      ),
  );
}
expect("no panel targets are declared for overview", (PANEL_NODE_TARGETS.overview ?? []).length === 0);

// The measurement contract itself discriminates over the tri-state resolver:
// a fixture terminal that ships occurrences owes populated Sources/Timeline
// nodes; a terminal with none owes the visible explanation; the retrieval
// accounting contract mirrors the product's three branches (requestLog array
// → rows+note even when empty, absent requestLog + empty counts → the
// explanation, non-empty counts → legacy rows+note); and an unknown contract
// (live run) stays populated-required — a selector finding nothing is a
// measured miss, never a skip.
const populatedTerminal = { timeline: [{}], supportingEvidence: [], contextualEvidence: [], undatedEvidence: [] };
const emptyTerminal = { timeline: [], supportingEvidence: [], contextualEvidence: [], undatedEvidence: [], requestLog: null };
expect("populated contract: occurrences present", panelContractPopulated("hasAnyOccurrence", { terminal: populatedTerminal }) === "populated");
expect("empty contract: no occurrences at all", panelContractPopulated("hasAnyOccurrence", { terminal: emptyTerminal }) === "empty");
expect(
  "empty contract: absent requestLog + known-empty counts owes the explanation for the note",
  panelContractPopulated("accountingNote", { terminal: emptyTerminal, searchCounts: [] }) === "empty",
);
expect(
  "empty contract: the same surface owes NO rows (absent, not empty)",
  panelContractPopulated("accountingRows", { terminal: emptyTerminal, searchCounts: [] }) === "absent",
);
expect("populated contract: requestLog rows present", panelContractPopulated("accountingRows", { terminal: { requestLog: [{ engine: "x" }] } }) === "populated");
expect(
  "populated contract: legacy searchCounts rows present",
  panelContractPopulated("accountingRows", { terminal: { requestLog: null }, searchCounts: [{ engine: "x", count: 2 }] }) === "populated",
);
expect(
  "absent contract: an empty requestLog array keeps the branch but owes zero rows",
  panelContractPopulated("accountingRows", { terminal: { requestLog: [] } }) === "absent",
);
expect(
  "populated contract: the accounting note still renders for an empty requestLog",
  panelContractPopulated("accountingNote", { terminal: { requestLog: [] } }) === "populated",
);
expect(
  "optional contract: absent requestLog + unknowable counts is measured, not skipped",
  panelContractPopulated("accountingRows", { terminal: emptyTerminal, searchCounts: null }) === "optional",
);
expect("an unknown contract (live) requires the populated branch", panelContractPopulated("hasAnyOccurrence", null) === "populated");
expect("the always contract never requires an explanation", panelContractPopulated("always", { terminal: emptyTerminal }) === "populated");
expect("an unknown contract mode requires the populated branch", panelContractPopulated("never-heard-of", { terminal: emptyTerminal }) === "populated");

console.log(
  JSON.stringify({ control: "contrast-panel", checks: results.length, failures, ok: failures === 0 }),
);
console.log(failures === 0 ? "PASS: contrast/panel predicates discriminate" : `FAIL: ${failures} expectation(s) failed`);
process.exit(failures === 0 ? 0 : 1);
