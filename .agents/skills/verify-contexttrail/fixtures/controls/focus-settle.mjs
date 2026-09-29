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
  acquireFocusSettle,
  focusLogFloor,
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

/* -------- bounded close acquisition (F38-1), real acquireFocusSettle --------
 * The drive's acquisition loop is exercised against a stub page whose
 * evaluate() serves the sampler log and the selected-tab descriptor — the
 * same calls the real drive makes. Every scenario drives the REAL loop:
 * fresh-interval marker scoping, dwell counting, decisive early return and
 * bound-exhausted truthful failure. */

// A stub page: function args run against a scripted __ctFocusLog; the string
// evaluate is the selected-tab descriptor call.
const stubPage = (log, selectedTab) => {
  globalThis.window = { __ctFocusLog: log };
  return {
    evaluate: async (arg) => (typeof arg === "function" ? arg() : selectedTab),
  };
};

// Positive: a fresh open interval, an actual recorded close marker and a
// full dwell of post-close samples on the expected opener key.
{
  const log = [];
  const floor = log.length; // captured before the open click
  log.push(frame(0, { tag: "DIV" }, true), frame(1, { tag: "DIV" }, true)); // open interval
  for (let f = 2; f < 8; f++) log.push(frame(f, el("B"), false)); // settled post-close run
  const page = stubPage(log, el("TAB"));
  const r = await acquireFocusSettle(page, {
    opener: el("B"),
    openFloor: floor,
    dwell: 3,
    timeoutMs: 2000,
    pollMs: 5,
  });
  expect("a fresh close window acquires (marker + dwell)", r.acquired === true, `marker=${r.closeMarker} post=${r.postCloseSamples}`);
  expect("the acquired settle is GREEN on the recorded opener key", r.settle.ok === true, r.settle.reason);
  expect("the persisted record carries the keyed frame log", Array.isArray(r.log) && r.log.length === 8);
}

// Marker isolation: a cumulative log that already contains an open/close
// interval must NOT satisfy the second acquisition — its marker is scoped to
// frames at/after THIS open's floor, so a borrowed first close is impossible.
{
  const log = [
    frame(0, el("B"), true), frame(1, el("B"), true), // FIRST open interval
    frame(2, el("B")), frame(3, el("B")), frame(4, el("B")), frame(5, el("B")), // first close + run
  ];
  const floor = await focusLogFloor(stubPage(log, el("TAB")));
  // Second close happens but the sampler records NO new open interval
  // (reopen click raced, or the sampler died): the first marker must not
  // be borrowed.
  log.push(frame(6, el("B")), frame(7, el("B")), frame(8, el("B")));
  const r = await acquireFocusSettle(stubPage(log, el("TAB")), {
    opener: el("B"),
    openFloor: floor,
    dwell: 3,
    timeoutMs: 200,
    pollMs: 5,
  });
  expect("a second close cannot borrow the first close's marker", r.closeMarker === null && r.acquired === false,
    `marker=${r.closeMarker} acquired=${r.acquired}`);
}

// Premature bound: hidden DOM is not a sampled close — when the log never
// reaches a dwell of post-close samples, the bound exhausts truthfully.
{
  const log = [frame(0, { tag: "DIV" }, true), frame(1, { tag: "DIV" }, true), frame(2, el("B"))];
  const r = await acquireFocusSettle(stubPage(log, el("TAB")), {
    opener: el("B"),
    openFloor: 0,
    dwell: 3,
    timeoutMs: 200,
    pollMs: 5,
  });
  expect("too few post-close samples is a bounded failure, not a pass", r.acquired === false && r.settle.ok === false,
    `post=${r.postCloseSamples} settle=${r.settle.reason}`);
}

// Wrong-key settle is a decisive RED: acquisition completes but the run is on
// the wrong recorded key.
{
  const log = [frame(0, { tag: "DIV" }, true)];
  for (let f = 1; f < 7; f++) log.push(frame(f, el("WRONG"), false));
  const r = await acquireFocusSettle(stubPage(log, el("TAB")), {
    opener: el("B"),
    openFloor: 0,
    dwell: 3,
    timeoutMs: 2000,
    pollMs: 5,
  });
  expect("a settled wrong-key run is decisively RED", r.acquired === true && r.settle.ok === false && r.settle.reason === "settled-on-unexpected-target",
    r.settle.reason);
}

// Descriptor-only final run: weaker proof, still rejected under key basis.
{
  const d = { tag: "BUTTON", label: "Close", role: null, selected: null, key: null };
  const log = [frame(0, { tag: "DIV" }, true)];
  for (let f = 1; f < 7; f++) log.push(frame(f, d, false));
  const r = await acquireFocusSettle(stubPage(log, { tag: "BUTTON", label: "Close", key: null }), {
    opener: { tag: "BUTTON", label: "Close", key: null },
    openFloor: 0,
    dwell: 3,
    timeoutMs: 2000,
    pollMs: 5,
  });
  expect("a descriptor-only run is RED under the recorded-key basis", r.acquired === true && r.settle.ok === false,
    `${r.settle.reason} basis=${JSON.stringify(r.settle.stabilityBasis)}`);
}

console.log(
  JSON.stringify({ control: "focus-settle", checks: results.length, failures, ok: failures === 0 }),
);
console.log(failures === 0 ? "PASS: focus-settle predicates discriminate" : `FAIL: ${failures} expectation(s) failed`);
process.exit(failures === 0 ? 0 : 1);
