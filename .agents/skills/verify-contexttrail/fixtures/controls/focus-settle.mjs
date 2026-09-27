/**
 * Offline derivative of the accepted focus-settle predicates.
 *
 * The maintained focus return proof is keyed: `document.activeElement` is
 * sampled once per animation frame, every element that takes focus carries a
 * recorded per-element `data-ctfk` key, the close marker is the frame the log
 * actually recorded the dialog leaving the DOM, and only the final consecutive
 * identity run can satisfy the dwell — a same-label A/B/A is not stability and
 * a descriptor-only run is weaker proof that `requireKeyBasis` rejects.
 *
 * This exercises the REAL exported predicates — focusIdentityOf,
 * deriveDialogCloseMarker, settleFocusRun, restorableFocusTargetOk,
 * focusRestoreExpectation and driveOutcomeOk — plus a parse check on every
 * in-page function source, since a broken page-side string is otherwise
 * invisible offline.
 *
 *   node fixtures/controls/focus-settle.mjs
 */
import {
  focusIdentityOf,
  deriveDialogCloseMarker,
  settleFocusRun,
  restorableFocusTargetOk,
  focusRestoreExpectation,
  driveOutcomeOk,
  FOCUS_SAMPLER_FN,
  FOCUS_DESCRIPTOR_FN,
  FOCUS_OPENER_MUTATE_FN,
} from "../../cli/control-contexttrail.mjs";

let failures = 0;
const results = [];
const expect = (name, cond, detail) => {
  results.push({ name, ok: cond === true, detail: detail ?? null });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

// In-page function sources must at least parse — an unparsable page-side
// string would only surface during a native drive otherwise.
for (const [name, src] of Object.entries({ FOCUS_SAMPLER_FN, FOCUS_DESCRIPTOR_FN, FOCUS_OPENER_MUTATE_FN })) {
  let ok = true;
  try {
    new Function(`return ${src}`);
  } catch {
    ok = false;
  }
  expect(`${name} parses as a page-side function`, ok);
}

// Synthetic log shapes matching the sampler's record: {frame, dialogOpen, active}.
const el = (key, over = {}) => ({
  tag: "BUTTON",
  label: "Close",
  role: null,
  selected: null,
  connected: true,
  rendered: true,
  disabled: false,
  tabIndex: 0,
  key,
  ...over,
});
const frame = (f, active, dialogOpen = false) => ({ frame: f, dialogOpen, active });

// The recorded dialog was open through frame 2; the marker is the first frame
// after the last open frame, not a caller guess.
const base = [frame(0, el("A"), true), frame(1, el("A"), true), frame(2, el("A"), true), frame(3, el("B")), frame(4, el("B")), frame(5, el("B")), frame(6, el("B"))];
const marker = deriveDialogCloseMarker(base);
expect("close marker is the frame after the last recorded open frame", marker === 3, `marker=${marker}`);
expect("a log that never saw an open dialog has no marker", deriveDialogCloseMarker([frame(0, el("A")), frame(1, el("A"))]) === null);
expect("an empty log has no marker", deriveDialogCloseMarker([]) === null);
expect("non-array samples have no marker", deriveDialogCloseMarker("x") === null);

// Positive: expected key holds across EVERY sample of the final run.
expect(
  "keyed final run settles on the expected element",
  settleFocusRun(base, marker, { key: "B", requireKeyBasis: true }).ok === true,
);
expect(
  "samples before the close marker do not count toward the run",
  settleFocusRun(base, marker, { key: "B" }).settledAtFrame === 3,
);

// Negatives.
expect(
  "the wrong stable key is RED even with a clean run",
  settleFocusRun(base, marker, { key: "A", requireKeyBasis: true }).ok === false,
);
// A/B/A with dwell 3: the final run is A,A,A — the earlier same-label B,B pair
// is reset and cannot satisfy an expectation on B.
const aba = [frame(0, el("X"), true), frame(1, el("B1")), frame(2, el("B1")), frame(3, el("A")), frame(4, el("A")), frame(5, el("A")), frame(6, el("A"))];
const abaMarker = deriveDialogCloseMarker(aba);
expect(
  "same-label A/B/A is stable on the FINAL run only (A passes)",
  settleFocusRun(aba, abaMarker, { key: "A", requireKeyBasis: true }).ok === true,
);
expect(
  "same-label A/B/A expecting the displaced B is RED",
  settleFocusRun(aba, abaMarker, { key: "B", requireKeyBasis: true }).ok === false,
);
// Two DIFFERENT elements sharing a label and descriptor: only the key
// distinguishes them — the descriptor-only identity would conflate them.
const twin1 = el("T1"), twin2 = el("T2");
expect(
  "two same-label elements have different recorded-key identities",
  focusIdentityOf(twin1).id !== focusIdentityOf(twin2).id,
);
const d1 = { tag: "BUTTON", label: "Close", role: null, selected: null, key: null };
const d2 = { tag: "BUTTON", label: "Close", role: null, selected: null, key: null };
expect(
  "descriptor-only identity cannot distinguish same-label elements (weaker proof)",
  focusIdentityOf(d1).id === focusIdentityOf(d2).id && focusIdentityOf(d1).basis === "descriptor-only",
);

// Descriptor-only runs: valid but weaker, rejected under requireKeyBasis.
const descLog = [frame(0, el("A"), true), frame(1, d1), frame(2, d1), frame(3, d1), frame(4, d1)];
const descMarker = deriveDialogCloseMarker(descLog);
const descSettle = settleFocusRun(descLog, descMarker, {});
expect("a descriptor-only run can settle (weaker proof)", descSettle.ok === true && descSettle.proofStrength.includes("descriptor-only"));
expect("descriptor-only run is RED when the recorded key basis is required", settleFocusRun(descLog, descMarker, { requireKeyBasis: true }).ok === false);

// Dwell and marker discipline.
const short = [frame(0, el("A"), true), frame(1, el("B")), frame(2, el("B"))];
expect("a run shorter than the dwell is RED", settleFocusRun(short, 1, { key: "B" }).reason === "never-stabilized-within-bounded-wait");
expect("a missing marker is RED, never a guess", settleFocusRun(base, null, { key: "B" }).ok === false);
expect("no samples at/after the marker is RED", settleFocusRun(base, 99, { key: "B" }).ok === false);
expect("non-array samples are RED, never a pass", settleFocusRun(null, 1, { key: "B" }).ok === false);
// Focus passing through BODY between unmount and restore is tolerated mid-run
// but cannot be the final identity.
const throughBody = [frame(0, el("A"), true), frame(1, { tag: "BODY" }), frame(2, el("B")), frame(3, el("B")), frame(4, el("B")), frame(5, el("B"))];
const tb = settleFocusRun(throughBody, 1, { key: "B", requireKeyBasis: true });
expect("a transient BODY frame mid-run does not fail the settle", tb.ok === true && tb.bodyFrames === 1);
const stuckBody = [frame(0, el("A"), true), frame(1, { tag: "BODY" }), frame(2, { tag: "BODY" }), frame(3, { tag: "BODY" }), frame(4, { tag: "BODY" })];
expect("focus lost to BODY is RED", settleFocusRun(stuckBody, 1, { key: "B", requireKeyBasis: true }).ok === false);

// Opener validity: the four invalid-opener prerequisites force the fallback.
const opener = el("OP");
expect("a restorable recorded opener is the expectation", focusRestoreExpectation({ opener, selectedTab: el("TAB") }).key === "OP");
for (const [kind, mut] of [
  ["hidden", { rendered: false }],
  ["disabled", { disabled: true }],
  ["disconnected", { connected: false }],
  ["tabindex-negative", { tabIndex: -1 }],
]) {
  const bad = { ...opener, ...mut };
  const r = restorableFocusTargetOk(bad);
  const e = focusRestoreExpectation({ opener: bad, selectedTab: el("TAB") });
  expect(`invalid opener (${kind}) is not restorable`, r.ok === false, r.reason);
  expect(`invalid opener (${kind}) falls back to the selected tab's key`, e.basis === "selected-tab-fallback" && e.key === "TAB");
}
expect("no opener and no key-able tab is no usable target", focusRestoreExpectation({ opener: null, selectedTab: null }).key === null);

// FD2: the maintained drive record itself is fail-closed.
const good = { outcome: "PASS", complete: true, assertions: { pass: 5, fail: 0, info: 2 } };
expect("a complete PASS record is a valid verdict", driveOutcomeOk(good).ok === true);
for (const [name, rec] of [
  ["PASS with zero assertions", { outcome: "PASS", complete: true, assertions: { pass: 0, fail: 0, info: 0 } }],
  ["PASS with a failed assertion", { outcome: "PASS", complete: true, assertions: { pass: 5, fail: 1, info: 0 } }],
  ["PASS missing the assertions block", { outcome: "PASS", complete: true }],
  ["PASS missing the complete flag", { outcome: "PASS", assertions: { pass: 5, fail: 0, info: 0 } }],
  ["PASS on an incomplete drive", { outcome: "PASS", complete: false, assertions: { pass: 5, fail: 0, info: 0 } }],
  ["unknown outcome", { outcome: "GREEN", complete: true, assertions: { pass: 5, fail: 0, info: 0 } }],
  ["non-integer counts", { outcome: "PASS", complete: true, assertions: { pass: "5", fail: 0, info: 0 } }],
  ["null record", null],
  ["empty object", {}],
]) {
  expect(`malformed record is never acceptance: ${name}`, driveOutcomeOk(rec).ok === false);
}

console.log(
  JSON.stringify({ control: "focus-settle", checks: results.length, failures, ok: failures === 0 }),
);
console.log(failures === 0 ? "PASS: focus-settle predicates discriminate" : `FAIL: ${failures} expectation(s) failed`);
process.exit(failures === 0 ? 0 : 1);
