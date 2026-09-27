/**
 * Offline contract control for the V39 corrections that are not full
 * observer-path checks (those live in a8-observer.mjs):
 *
 *   V39-1 — --claim-text on a controlled drive is accepted ONLY when the
 *     resolved case is a claim-mode fixture and the text equals that
 *     fixture's own submitted claim; --image stays strictly live-only; the
 *     live gates are untouched. Exercised through the real parser by spawning
 *     the CLI's argv path (fail()s land at exit 2 with the named reason).
 *   V39-3 — missing/unreadable/digest-mismatched expected-case map refuses a
 *     maintained-A8 drive at parse time (before any effect); a transient
 *     non-roster stream needs no map.
 *   V39-4 — panelContractPopulated's four states over consumed state, the
 *     requestLog-[]-is-truthy product branch, search.batch-folded legacy
 *     counts, heading-scoped/nth measurement (real PANEL_MEASURE_FN), and the
 *     three-way accounting-branch probe + verdict (real ACCOUNTING_BRANCH_FN).
 *   V39-5 — wrapVerdict distinguishes visible overflow (GREEN) from real
 *     clipping in either axis, ancestor clips, empty ranges, unrendered nodes
 *     and document horizontal overflow (RED).
 *   V39-6 — renderedExcerptVerdict strips only the product's outer curly pair
 *     and excerptAttributionHeading reads the h3 bound to that blockquote.
 *   V39-7 — openedOccurrenceId reads exactly one Occurrence ID: field inside
 *     the Technical-details disclosure; counterfeit dialog text, duplicates
 *     and missing fields all refuse.
 *
 *   node fixtures/controls/v39-contracts.mjs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import {
  expectedCaseFor,
  A8_MAINTAINED_FIXTURES,
  fixtureResult,
  fixtureEvents,
  mappedRequestLog,
  consumedSearchCounts,
  panelContractPopulated,
  ACCOUNTING_BRANCH_FN,
  accountingBranchVerdict,
  PANEL_MEASURE_FN,
  wrapVerdict,
  CLIP_FN,
  renderedExcerptVerdict,
  expectedExcerptAttribution,
  excerptAttributionHeading,
  openedOccurrenceId,
} from "../../cli/control-contexttrail.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "..");
const CLI = path.resolve(HERE, "..", "..", "cli", "control-contexttrail.mjs");
const MAP_FILE = path.join(FIXTURES, "a8-expected-case-map.json");
const MAP_BAK = MAP_FILE + ".v39-bak";

let failures = 0;
const results = [];
const expect = (name, cond, detail) => {
  results.push({ name, ok: cond === true, detail: detail ?? null });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

/* ---------------------------- V39-1: parser ------------------------------- */

const CLAIM = "This controlled claim describes a fictional event today.";
const runCli = (args) => {
  try {
    const out = execFileSync("node", [CLI, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, text: out };
  } catch (e) {
    return { code: e.status ?? -1, text: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
};
// Positive vectors must get PAST the parser — the next failure in a
// source-only environment is run resolution, not a schema rejection.
const PAST_PARSE = "cannot resolve run";

expect(
  "parser: controlled claim fixture accepts its own --claim-text (result)",
  runCli(["drive", "result", "--run-id", "__v39", "--case", "controlled-claim", "--view", "overview", "--claim-text", CLAIM]).text.includes(PAST_PARSE),
  runCli(["drive", "result", "--run-id", "__v39", "--case", "controlled-claim", "--view", "overview", "--claim-text", CLAIM]).text.slice(0, 90),
);
expect(
  "parser: a different --claim-text than the fixture's own is rejected",
  runCli(["drive", "result", "--run-id", "__v39", "--case", "controlled-claim", "--claim-text", "some other claim"]).text.includes("must equal the fixture's own submitted claim"),
);
expect(
  "parser: --claim-text on a trace fixture is rejected",
  runCli(["drive", "result", "--run-id", "__v39", "--case", "controlled-trace", "--claim-text", "x"]).text.includes("requires a claim-mode fixture"),
);
expect(
  "parser: viewer --case <claim fixture> accepts the fixture's own --claim-text",
  runCli(["drive", "viewer", "--run-id", "__v39", "--entry", "timeline", "--case", "controlled-claim", "--claim-text", CLAIM]).text.includes(PAST_PARSE),
);
expect(
  "parser: viewer --case <trace fixture> still rejects --claim-text",
  runCli(["drive", "viewer", "--run-id", "__v39", "--entry", "timeline", "--case", "controlled-trace", "--claim-text", "x"]).text.includes("requires a claim-mode fixture"),
);
expect(
  "parser: no --claim-text on a claim fixture passes (default is the fixture's own claim)",
  runCli(["drive", "result", "--run-id", "__v39", "--case", "controlled-claim", "--view", "overview"]).text.includes(PAST_PARSE),
);
expect(
  "parser: --image remains strictly live-only",
  runCli(["drive", "result", "--run-id", "__v39", "--case", "controlled-claim", "--image", "x.png"]).text.includes("--image is only valid with --live"),
);
expect(
  "parser: --claim-text remains legal on a live drive (live gate preserved)",
  !runCli(["drive", "result", "--run-id", "__v39", "--live", "--claim-text", "x", "--image", "nope.png"]).text.includes("only valid with --live"),
  runCli(["drive", "result", "--run-id", "__v39", "--live", "--claim-text", "x", "--image", "nope.png"]).text.slice(0, 90),
);
// Recipe vectors: the same argv the emitted bindings carry must parse.
{
  const bindings = JSON.parse(fs.readFileSync(path.join(FIXTURES, "a8-recipe-bindings.json"), "utf8"));
  const claimRecipe = bindings.recipes.find((r) => r.claimSubmitted !== null);
  const cmd = claimRecipe.commands[0].args.map((a) => (a === "<run-id>" ? "__v39" : a));
  const out = runCli(cmd);
  expect(
    "parser: a real emitted claim recipe vector parses (past schema)",
    out.text.includes(PAST_PARSE),
    `${cmd.join(" ")} → ${out.text.slice(0, 80)}`,
  );
  const traceRecipe = bindings.recipes.find((r) => r.claimSubmitted === null);
  const tcmd = traceRecipe.commands[0].args.map((a) => (a === "<run-id>" ? "__v39" : a));
  const tout = runCli(tcmd);
  expect(
    "parser: a real emitted trace recipe vector parses (no claim-text needed)",
    tout.text.includes(PAST_PARSE),
    `${tcmd.join(" ")} → ${tout.text.slice(0, 80)}`,
  );
  // ...and the same trace recipe FORGED with a claim text must refuse.
  const forged = runCli([...tcmd, "--claim-text", "forged"]);
  expect(
    "parser: forging --claim-text onto a trace recipe is rejected",
    forged.text.includes("requires a claim-mode fixture"),
    forged.text.slice(0, 80),
  );
}

/* --------------------- V39-3: map authority, before effects ---------------- */

{
  const saved = fs.readFileSync(MAP_FILE);
  try {
    fs.renameSync(MAP_FILE, MAP_BAK);
    const out = runCli(["drive", "result", "--run-id", "__v39", "--case", "controlled-claim", "--view", "overview"]);
    expect(
      "map missing: a maintained-A8 drive refuses at parse time",
      out.code === 2 && /expected-case map is missing or unreadable/.test(out.text),
      out.text.slice(0, 110),
    );
  } finally {
    fs.renameSync(MAP_BAK, MAP_FILE);
  }
  try {
    fs.writeFileSync(MAP_FILE, Buffer.concat([saved, Buffer.from(" ")]));
    const out = runCli(["drive", "result", "--run-id", "__v39", "--case", "controlled-claim", "--view", "overview"]);
    expect(
      "map tampered: digest mismatch refuses the drive before effects",
      out.code === 2 && /digest mismatch/.test(out.text),
      out.text.slice(0, 110),
    );
  } finally {
    fs.writeFileSync(MAP_FILE, saved);
  }
  expect(
    "a maintained roster fixture resolves to its real map case",
    expectedCaseFor("controlled-claim")?.fixture === "controlled-claim",
  );
  expect(
    "a transient coverage-mutant stream name is NOT A8 — no map needed",
    A8_MAINTAINED_FIXTURES.has("controlled-empty-contrary-count") === false &&
      expectedCaseFor("controlled-empty-contrary-count") === null,
  );
  expect(
    "every maintained roster name has an accepted map case",
    [...A8_MAINTAINED_FIXTURES].every((n) => expectedCaseFor(n) !== null),
    `${A8_MAINTAINED_FIXTURES.size} roster fixtures`,
  );
}

/* --------------------- V39-4: consumed-state contracts --------------------- */

const T = (over) => ({
  timeline: [{}],
  supportingEvidence: [{}],
  contextualEvidence: [],
  undatedEvidence: [],
  ...over,
});
expect(
  "contract: populated terminal → populated; empty terminal → empty",
  panelContractPopulated("hasAnyOccurrence", { terminal: T(), searchCounts: [] }) === "populated" &&
    panelContractPopulated("hasAnyOccurrence", {
      terminal: T({ timeline: [], supportingEvidence: [] }),
      searchCounts: [],
    }) === "empty",
);
expect(
  "contract: live/unknown (null terminal) keeps populated-required for occurrence surfaces",
  panelContractPopulated("hasAnyOccurrence", { terminal: null, searchCounts: null }) === "populated",
);
{
  // requestLog: [] is TRUTHY in the product — the request-log branch renders
  // with zero rows and its per-operation note still shows.
  const rows = panelContractPopulated("accountingRows", {
    terminal: T({ requestLog: [] }),
    searchCounts: [],
  });
  const note = panelContractPopulated("accountingNote", {
    terminal: T({ requestLog: [] }),
    searchCounts: [],
  });
  expect(
    "contract: requestLog [] → rows absent (empty ul) but the note still renders",
    rows === "absent" && note === "populated",
    `rows=${rows} note=${note}`,
  );
  const rowsPop = panelContractPopulated("accountingRows", {
    terminal: T({ requestLog: [{ engine: "g", attempted: 3, returned: 2 }] }),
    searchCounts: [],
  });
  const notePop = panelContractPopulated("accountingNote", {
    terminal: T({ requestLog: [{ engine: "g" }] }),
    searchCounts: [],
  });
  expect(
    "contract: non-empty requestLog → rows + note populated",
    rowsPop === "populated" && notePop === "populated",
  );
  // Legacy counts folded from consumed search.batch events.
  const counts = consumedSearchCounts([
    { type: "search.batch", engine: "g", count: 3 },
    { type: "stage" },
    { type: "search.batch", engine: "h", count: 0 },
    { type: "search.batch", engine: "g", count: 5 }, // latest wins
  ]);
  expect(
    "contract: search.batch events fold per-engine with latest-wins",
    JSON.stringify(counts) === JSON.stringify([{ engine: "g", count: 5 }, { engine: "h", count: 0 }]),
    JSON.stringify(counts),
  );
  expect(
    "contract: absent requestLog + empty folded counts → explanation owes (rows absent)",
    panelContractPopulated("accountingRows", { terminal: T(), searchCounts: [] }) === "absent" &&
      panelContractPopulated("accountingNote", { terminal: T(), searchCounts: [] }) === "empty",
  );
  expect(
    "contract: absent requestLog + non-empty folded counts → legacy populated",
    panelContractPopulated("accountingRows", { terminal: T(), searchCounts: [{ engine: "g", count: 2 }] }) === "populated",
  );
  expect(
    "contract: neither field derivable → optional (live/unobservable hook)",
    panelContractPopulated("accountingRows", { terminal: T(), searchCounts: null }) === "optional",
  );
}
expect(
  "mappedRequestLog: absent → null; [] → []; non-string-engine entries drop",
  mappedRequestLog(null) === null &&
    mappedRequestLog({}) === null &&
    mappedRequestLog({ requestLog: [] }).length === 0 &&
    mappedRequestLog({ requestLog: [{ engine: "g" }, { engine: 7 }, {}] }).length === 1,
);
// The REAL measure fn, heading-scoped, in a real DOM (jsdom).
{
  const dom = new JSDOM(`<!doctype html><body>
    <div id="ct-panel-analysis"><section aria-label="Analysis">
      <p class="mt-2 text-sm">the Analysis intro paragraph</p>
      <h3>Retrieval accounting</h3>
      <p class="mt-2 text-sm">No retrieval counts were preserved for this investigation.</p>
      <p class="mt-2 text-xs">Per-operation accounting: each row shows attempted/returned/retained.</p>
    </section></div>
    <div id="ct-panel-other"><p class="mt-2 text-sm">No retrieval counts were preserved — FOREIGN panel</p></div>
  </body>`, { runScripts: "outside-only" });
  const w = dom.window;
  const measure = (arg) => w.eval(`(${PANEL_MEASURE_FN})(${JSON.stringify(arg)})`);
  const scoped = measure({
    panelId: "ct-panel-analysis",
    selector: "p.mt-2.text-sm",
    scope: "Retrieval accounting",
    expectText: "No retrieval counts were preserved",
  });
  expect(
    "measure: heading-scoped selector finds the explanation, not the intro",
    scoped.found === true && scoped.textMatched === true && scoped.membership === "ct-panel-analysis",
    JSON.stringify({ found: scoped.found, text: scoped.text, matchCount: scoped.matchCount }),
  );
  const unscoped = measure({
    panelId: "ct-panel-analysis",
    selector: "p.mt-2.text-sm",
    expectText: "No retrieval counts were preserved",
  });
  expect(
    "measure: the same selector UNSCOPED resolves the intro and fails expectText",
    unscoped.found === true && unscoped.textMatched === false,
    `unscoped text=${JSON.stringify(unscoped.text)}`,
  );
  const foreign = measure({
    panelId: "ct-panel-analysis",
    selector: "p.mt-2.text-sm",
    scope: "No such heading",
  });
  expect("measure: a missing scope heading is found:false, never a foreign panel", foreign.found === false);
  const nth = measure({ panelId: "ct-panel-analysis", selector: "p", nth: 1 });
  expect("measure: nth picks the indexed match", nth.found === true && /Analysis intro|retrieval/i.test(nth.text ?? ""));
  void CLIP_FN; // exercised by wrapVerdict record shapes below; jsdom has no layout.
}
// The real accounting-branch probe + verdict over each rendered branch.
{
  const branchOf = (inner) => {
    const dom = new JSDOM(`<div id="ct-panel-analysis"><section aria-label="Analysis">${inner}</section></div>`, { runScripts: "outside-only" });
    return dom.window.eval(ACCOUNTING_BRANCH_FN);
  };
  const req = branchOf(`<h3>Retrieval accounting</h3><ul><li>g · 3/2/1</li><li>h · 1/1/1</li></ul><p>Per-operation accounting — attempted/returned/retained by engine.</p>`);
  const bv1 = accountingBranchVerdict({ requestLog: [{ engine: "g" }, { engine: "h" }] }, null, req);
  expect("accounting: requestLog[2] renders the requestLog branch with 2 rows", req.branch === "requestLog" && bv1.ok, bv1.detail);
  const bvBad = accountingBranchVerdict({ requestLog: [{ engine: "g" }] }, null, req);
  expect("accounting: requestLog[1] vs 2 rendered rows is RED", bvBad.ok === false, bvBad.detail);
  const empty = branchOf(`<h3>Retrieval accounting</h3><p>No retrieval counts were preserved for this investigation.</p>`);
  const bv2 = accountingBranchVerdict({ requestLog: null }, [], empty);
  expect("accounting: no requestLog + empty counts → explanation branch", empty.branch === "empty" && bv2.ok === false, `${bv2.detail} (jsdom renders no geometry — the verdict's visibility clause is what differs offline)`);
  const legacy = branchOf(`<h3>Retrieval accounting</h3><ul><li>g — 5</li></ul><p>Counts are retrieved results totals reported by each engine.</p>`);
  const bv3 = accountingBranchVerdict({}, [{ engine: "g", count: 5 }], legacy);
  expect("accounting: legacy searchCounts → legacy branch, exact row count", legacy.branch === "legacy" && bv3.ok, bv3.detail);
  const none = branchOf(`<h3>Retrieval accounting</h3>`);
  const bv4 = accountingBranchVerdict({}, [], none);
  expect("accounting: a section that rendered NOTHING is RED under any contract", none.branch === "none" && bv4.ok === false, bv4.detail);
}

/* ------------------------- V39-5: clip vs overflow ------------------------- */

const rect = (l, r, t, b) => ({ left: l, right: r, top: t, bottom: b });
const base = {
  found: true,
  rendered: true,
  rangeMeasured: true,
  lineRects: [rect(0, 500, 0, 20)],
  nodeRect: rect(0, 100, 0, 20),
  overflowX: "visible",
  overflowY: "visible",
  clippingAncestors: [],
  documentHorizontalOverflow: false,
};
expect(
  "clip: text outrunning a NON-clipping (overflow:visible) box stays GREEN",
  wrapVerdict(base).pass === true,
  wrapVerdict(base).why,
);
expect(
  "clip: node overflow-x:hidden cutting the range is RED",
  wrapVerdict({ ...base, overflowX: "hidden" }).pass === false,
);
expect(
  "clip: node overflow-y:clip cutting the range is RED",
  wrapVerdict({ ...base, overflowY: "clip", lineRects: [rect(0, 90, 0, 60)] }).pass === false,
);
expect(
  "clip: a clipping ancestor cutting horizontally is RED",
  wrapVerdict({
    ...base,
    clippingAncestors: [{ tag: "DIV", overflowX: "hidden", overflowY: "visible", paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0, rect: rect(0, 200, 0, 100) }],
  }).pass === false,
);
expect(
  "clip: a clipping ancestor cutting vertically is RED",
  wrapVerdict({
    ...base,
    clippingAncestors: [{ tag: "DIV", overflowX: "visible", overflowY: "auto", paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0, rect: rect(0, 900, 0, 10) }],
  }).pass === false,
);
expect("clip: unrendered/no-box node is RED", wrapVerdict({ ...base, rendered: false }).pass === false);
expect("clip: empty text range is RED", wrapVerdict({ ...base, rangeMeasured: false, lineRects: [] }).pass === false);
expect("clip: missing scoped node is RED", wrapVerdict({ found: false, reason: "x" }).pass === false);
expect("clip: document horizontal overflow is RED", wrapVerdict({ ...base, documentHorizontalOverflow: true }).pass === false);
expect(
  "clip: the same record restored to inside-bounds stays GREEN",
  wrapVerdict({ ...base, lineRects: [rect(0, 90, 0, 20)] }).pass === true,
);

/* ----------------- V39-6: excerpt wrapper + attribution -------------------- */

{
  const span = { text: `He said "«yes»" — it's done`, attribution: "Extracted page excerpt" };
  expect(
    "excerpt: the product's outer curly pair is stripped, inner quotes/guillemets survive",
    renderedExcerptVerdict(`“${span.text}”`, span).ok === true,
    renderedExcerptVerdict(`“${span.text}”`, span).why,
  );
  expect(
    "excerpt: without the wrapper the same text still matches exactly",
    renderedExcerptVerdict(span.text, span).ok === true,
  );
  expect(
    "excerpt: a one-character prefix is RED",
    renderedExcerptVerdict(`“${span.text.slice(0, -1)}”`, span).ok === false,
  );
  expect(
    "excerpt: substituted authentic text is RED",
    renderedExcerptVerdict(`“${span.text.replace("yes", "no")}”`, span).ok === false,
  );
  expect(
    "excerpt: fabricated text is RED",
    renderedExcerptVerdict("“a fabricated quote”", span).ok === false,
  );
  // The attribution is the h3 bound to THAT blockquote's figure — a matching
  // phrase elsewhere in the dialog must not authorize it.
  const mk = (inner) => {
    const dom = new JSDOM(`<div role="dialog">${inner}</div>`);
    const el = dom.window.document.querySelector('[role="dialog"]');
    return { evaluate: async (fn) => fn(el) };
  };
  const good = await excerptAttributionHeading(
    mk(`<p>Extracted page excerpt — elsewhere only</p><h3>Extracted page excerpt</h3><figure><blockquote>“q”</blockquote></figure>`),
  );
  expect("excerpt: the bound h3 is read as the attribution", good.found === true && good.text === "Extracted page excerpt");
  const noH3 = await excerptAttributionHeading(mk(`<figure><blockquote>“q”</blockquote></figure><p>Extracted page excerpt</p>`));
  expect("excerpt: the phrase elsewhere without a bound h3 is found:false", noH3.found === false);
  const wrongH3 = await excerptAttributionHeading(
    mk(`<h3>Search snippet</h3><figure><blockquote>“q”</blockquote></figure>`),
  );
  const wantAttr = expectedExcerptAttribution({ excerpt: "x", excerptSource: "page_text", excerptAttribution: "page_text" }, span);
  expect(
    "excerpt: a bound h3 with the WRONG label never satisfies the expected attribution",
    wrongH3.found === true && wrongH3.text !== wantAttr && wantAttr === "Extracted page excerpt",
  );
}

/* ------------------- V39-7: scoped occurrence identity --------------------- */

{
  const mkDialog = (inner) => {
    const dom = new JSDOM(`<div role="dialog">${inner}</div>`);
    const el = dom.window.document.querySelector('[role="dialog"]');
    return { evaluate: async (fn) => fn(el) };
  };
  const TECH = (p) => `<details><summary>Technical details</summary>${p}</details>`;
  const good = await openedOccurrenceId(mkDialog(TECH(`<p>Occurrence ID: ev-real-1</p>`)));
  expect("identity: the real Technical-details field is read", good.ok === true && good.id === "ev-real-1");
  const counterfeit = await openedOccurrenceId(
    mkDialog(`<p>Excerpt: "Occurrence ID: ev-fake-9 is the id"</p><h3>Occurrence ID: ev-fake-9</h3>` + TECH(`<p>Occurrence ID: ev-real-1</p>`)),
  );
  expect(
    "identity: counterfeit ID text elsewhere cannot impersonate the scoped field",
    counterfeit.ok === true && counterfeit.id === "ev-real-1",
    JSON.stringify(counterfeit),
  );
  const missing = await openedOccurrenceId(mkDialog(TECH(`<p>Scheme: https</p>`)));
  expect("identity: no field is a refused read, not a null pass", missing.ok === false, missing.reason);
  const dup = await openedOccurrenceId(mkDialog(TECH(`<p>Occurrence ID: ev-a</p><p>Occurrence ID: ev-b</p>`)));
  expect("identity: two fields are ambiguous → refused", dup.ok === false, dup.reason);
  const legacy = await openedOccurrenceId(mkDialog(TECH(`<p>Evidence ID: ev-old-3</p>`)));
  expect(
    "identity: a legacy 'Evidence ID' label is NOT the field — no supported source renders it",
    legacy.ok === false,
    legacy.reason,
  );
  const noDisclosure = await openedOccurrenceId(mkDialog(`<p>Occurrence ID: ev-x</p>`));
  expect("identity: a field outside Technical details is not the identity", noDisclosure.ok === false);
  // D1: the owning disclosure must be THE exact "Technical details" summary —
  // a misleading prefixed summary can never own the identity field, and a
  // second exact duplicate makes the owner ambiguous.
  const FORGED = (id) =>
    `<details><summary>Not Technical details</summary><p>Occurrence ID: ${id}</p></details>`;
  const forgedFirst = await openedOccurrenceId(
    mkDialog(FORGED("ev-forged-0") + TECH(`<p>Occurrence ID: ev-real-1</p>`)),
  );
  expect(
    "identity: a 'Not Technical details' disclosure before the real one cannot license its forged id",
    forgedFirst.ok === true && forgedFirst.id === "ev-real-1",
    JSON.stringify(forgedFirst),
  );
  const forgedOnly = await openedOccurrenceId(mkDialog(FORGED("ev-forged-0")));
  expect(
    "identity: a forged-prefix disclosure alone is a refused read",
    forgedOnly.ok === false,
    forgedOnly.reason,
  );
  const twoOwners = await openedOccurrenceId(
    mkDialog(TECH(`<p>Occurrence ID: ev-a</p>`) + TECH(`<p>Occurrence ID: ev-b</p>`)),
  );
  expect(
    "identity: two exact Technical-details disclosures are ambiguous → refused",
    twoOwners.ok === false,
    twoOwners.reason,
  );
}

console.log(`\n${results.length} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
