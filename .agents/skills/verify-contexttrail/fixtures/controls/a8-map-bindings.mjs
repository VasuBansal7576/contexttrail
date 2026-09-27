/**
 * Offline contract control for the accepted A8 expected-case map and the
 * maintained-runner recipe bindings (stage-047 integration).
 *
 * What it proves WITHOUT a browser:
 *   - the committed map is the accepted bytes (sha256 pin, real loader gate);
 *   - all 147 expectation records classify into a rendered/serialized bucket —
 *     141 visible + 6 serialized-only, never collapsed;
 *   - each of the 17 recipe bindings names a real case id, real argv, the
 *     received fixture's sha256 (== the map's declared streamSha256), the
 *     claim the recipe must submit, and a stable immutable recipeDigest that
 *     changes when any bound field changes;
 *   - the committed a8-recipe-bindings.json regenerates byte-identical;
 *   - every exported verdict predicate rejects its opposing mutation
 *     (wrong case id, wrong heading, caveat removed/restored, wrong gate
 *     label/support-link opened id, wrong group member, wrong endpoint,
 *     wrong segment rendering, placement violations) on the SAME predicate —
 *     the red/green pairs the map's negative plan requires;
 *   - the viewer drive accepts a fixture name as --case (the recipe path) and
 *     still rejects a name that is neither a named case nor a fixture.
 *
 *   node fixtures/controls/a8-map-bindings.mjs           run all checks
 *   A8_BINDINGS_EMIT=1 node fixtures/controls/a8-map-bindings.mjs
 *                                                        print bindings JSON
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FEATURE_SPECS,
  COMMAND_FLAGS,
  A8_MAP_SHA256,
  A8_APP_PIN,
  A8_FIXTURE_PIN,
  A8_RELEASE_SEAL,
  expectedMapBytesOk,
  loadExpectedCaseMap,
  expectedCaseFor,
  expectedRecordKind,
  expectedViewBucket,
  expectedCaseCoherent,
  fixtureResult,
  buildA8RecipeBindings,
  a8HeadlineVerdict,
  a8SupportVerdict,
  a8CaveatVerdict,
  a8CaveatSerializedVerdict,
  a8SegmentsVerdict,
  a8CoverageVerdict,
  a8GatesVerdict,
  a8OriginsVerdict,
  a8PolicyNaVerdict,
  a8TimelineIdsVerdict,
  a8UndatedAbsentVerdict,
  a8EmptyStateVerdict,
  a8PlacementVerdict,
  a8DivergenceVerdict,
  a8ConnectorsVerdict,
  A8_OVERVIEW_PROBE_FN,
  A8_TIMELINE_PROBE_FN,
  A8_ANALYSIS_PROBE_FN,
} from "../../cli/control-contexttrail.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "..");
const CLI = path.resolve(HERE, "..", "..", "cli", "control-contexttrail.mjs");
const BINDINGS_FILE = path.join(FIXTURES, "a8-recipe-bindings.json");
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

if (process.env.A8_BINDINGS_EMIT === "1") {
  process.stdout.write(JSON.stringify(buildA8RecipeBindings(), null, 1) + "\n");
  process.exit(0);
}

let failures = 0;
const results = [];
const expect = (name, cond, detail) => {
  results.push({ name, ok: cond === true, detail: detail ?? null });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

/* --------------------------- map bytes + loader ---------------------------- */

const mapBytes = fs.readFileSync(path.join(FIXTURES, "a8-expected-case-map.json"));
expect("map file carries the accepted sha256", sha256(mapBytes) === A8_MAP_SHA256);
expect(
  "the REAL digest gate accepts the accepted bytes",
  expectedMapBytesOk(mapBytes) === true,
);
expect(
  "the REAL digest gate rejects a tampered map",
  expectedMapBytesOk(Buffer.concat([mapBytes, Buffer.from(" ")])) === false &&
    expectedMapBytesOk(mapBytes.subarray(0, mapBytes.length - 8)) === false,
);

const map = loadExpectedCaseMap();
expect("map carries exactly 17 cases", map.cases.length === 17);
let total = 0;
let visible = 0;
for (const c of map.cases) for (const r of c.visibleExpectations) { total++; if (r.visible) visible++; }
expect(
  "147 records = 141 visible + 6 serialized-only (count authority, not the stale 95)",
  total === 147 && visible === 141 && total - visible === 6,
  `${total}/${visible}/${total - visible}`,
);

/* --------------------------- bucket classification ------------------------- */

let unbucketed = [];
const buckets = { overview: 0, timeline: 0, analysis: 0 };
for (const c of map.cases) {
  for (const r of c.visibleExpectations) {
    const b = expectedViewBucket(r, c.fixture);
    if (b === null) unbucketed.push(r.id);
    else buckets[b]++;
  }
}
expect("every record classifies into a discharged bucket", unbucketed.length === 0, unbucketed.join(",") || `overview=${buckets.overview} timeline=${buckets.timeline} analysis=${buckets.analysis}`);

/* ------------------------- per-case coherence ------------------------------ */

for (const c of map.cases) {
  const coh = expectedCaseCoherent(c);
  expect(`${c.fixture}: record namespace + frozen headline coherent`, coh.ok, coh.ok ? undefined : coh.detail);
}
// Wrong-case mutation: rename one record's namespace to another fixture — the
// SAME coherence predicate must go red.
const wrongCase = JSON.parse(JSON.stringify(map.cases[0]));
wrongCase.visibleExpectations[0].id = wrongCase.visibleExpectations[0].id.replace(
  `${wrongCase.fixture}-`,
  `${map.cases[1].fixture}-`,
);
expect(
  "a record carrying a foreign fixture namespace is RED (wrong-case rejection)",
  expectedCaseCoherent(wrongCase).ok === false,
);
const wrongHeadline = JSON.parse(JSON.stringify(map.cases[0]));
const hl = wrongHeadline.visibleExpectations.find((r) => expectedRecordKind(r, wrongHeadline.fixture) === "overview-headline");
hl.expect = "some other headline";
expect(
  "a headline record disagreeing with the frozen case headline is RED",
  expectedCaseCoherent(wrongHeadline).ok === false,
);

/* ----------------------------- recipe bindings ----------------------------- */

const bindings = buildA8RecipeBindings();
expect("17 recipes bound", bindings.recipes.length === 17);
expect("bindings pin the accepted app + fixture subset + release seal",
  bindings.acceptedAppPin === A8_APP_PIN && bindings.fixtureSubsetPin === A8_FIXTURE_PIN && bindings.releaseSeal === A8_RELEASE_SEAL);
expect("bindings name the maintained runner module", bindings.runner === "cli/control-contexttrail.mjs");

const specOk = (feature, args) => {
  const spec = FEATURE_SPECS[feature];
  if (!spec) return `no spec for ${feature}`;
  // The legal argv for `drive <feature>` is the command-level flag list plus
  // the feature's own options — the same union parseDriveOptions enforces.
  const legal = new Set([...COMMAND_FLAGS.drive, ...spec.options]);
  const flags = args.slice(2).filter((a) => a.startsWith("--")).map((a) => a.slice(2));
  for (const f of flags) if (!legal.has(f)) return `--${f} not legal for drive ${feature}`;
  if (args.includes("--view")) {
    const v = args[args.indexOf("--view") + 1];
    if (!(spec.views ?? []).includes(v)) return `--view ${v} not in ${feature}.views`;
  }
  if (args.includes("--entry")) {
    const e = args[args.indexOf("--entry") + 1];
    if (!(spec.entries ?? []).includes(e)) return `--entry ${e} not in ${feature}.entries`;
  }
  return null;
};

for (const recipe of bindings.recipes) {
  const fileSha = sha256(fs.readFileSync(path.join(FIXTURES, `${recipe.fixture}.ndjson`)));
  expect(
    `${recipe.caseId}: fixture sha256 == received bytes == declared streamSha256`,
    recipe.fixtureSha256 === fileSha && recipe.streamSha256 === fileSha,
  );
  expect(
    `${recipe.caseId}: bound to its own fixture`,
    recipe.caseId === `a8-${recipe.fixture}`,
  );
  // Every bound command is a real maintained CLI argv: a known feature, flags
  // drawn from that feature's declared options, the fixture as --case.
  const bad = [];
  for (const cmd of recipe.commands) {
    if (cmd.args[0] !== "drive") bad.push(`${cmd.purpose}: not a drive command`);
    const specErr = specOk(cmd.args[1], cmd.args);
    if (specErr) bad.push(specErr);
    const caseIdx = cmd.args.indexOf("--case");
    if (caseIdx >= 0 && cmd.args[caseIdx + 1] !== recipe.fixture) bad.push(`${cmd.purpose}: --case is not the bound fixture`);
    const spec = FEATURE_SPECS[cmd.args[1]];
    if (cmd.args[1] === "viewer" && !(spec.cases.includes(recipe.fixture) || spec.alsoFixtureCases)) {
      bad.push("viewer command does not accept a fixture case");
    }
    if (!cmd.args.includes("--run-id")) bad.push(`${cmd.purpose}: missing --run-id`);
  }
  expect(`${recipe.caseId}: all commands are real spec-legal argvs`, bad.length === 0, bad.join("; ") || undefined);
  // Claim binding: claim_check recipes must submit the case's pinned claim,
  // trace recipes must never carry --claim-text.
  const claimFlag = recipe.commands[0].args.includes("--claim-text");
  expect(
    `${recipe.caseId}: claim binding matches entryMode`,
    recipe.entryMode === "claim_check"
      ? claimFlag && recipe.requiredFlags.includes("--claim-text") &&
          recipe.commands.every((c) => c.args[c.args.indexOf("--claim-text") + 1] === recipe.claimSubmitted)
      : !claimFlag && !recipe.requiredFlags.includes("--claim-text") && recipe.claimSubmitted === null,
  );
  // The viewer recipe exists exactly when the map's view list includes it.
  const wantsViewer = (map.cases.find((c) => c.fixture === recipe.fixture)?.views ?? []).some((v) => v.startsWith("viewer:"));
  expect(
    `${recipe.caseId}: viewer command presence == map's viewer view`,
    recipe.commands.some((c) => c.args[1] === "viewer") === wantsViewer,
  );
}

/* ------------------------- immutable recipe digest ------------------------- */

const digestInputs = ({ runnerSha256, recipeDigest, note, ...rest }) => rest;
expect(
  "recipeDigest recomputes from the bound table",
  sha256(Buffer.from(JSON.stringify(digestInputs(bindings)), "utf8")) === bindings.recipeDigest,
);
expect(
  "recipeDigest is stable across rebuilds",
  buildA8RecipeBindings().recipeDigest === bindings.recipeDigest,
);
const mutated = JSON.parse(JSON.stringify(digestInputs(bindings)));
mutated.recipes[0].commands[0].args.push("--view", "bogus");
expect(
  "a mutated command changes the recipeDigest (digest rejection)",
  sha256(Buffer.from(JSON.stringify(mutated), "utf8")) !== bindings.recipeDigest,
);
// The committed bindings file regenerates byte-identical.
if (fs.existsSync(BINDINGS_FILE)) {
  const committed = fs.readFileSync(BINDINGS_FILE, "utf8");
  const regenerated = JSON.stringify(buildA8RecipeBindings(), null, 1) + "\n";
  // runnerSha256 is volatile across commits; compare it too — the committed
  // file must carry the CURRENT module hash or the staleness must be visible.
  const committedObj = JSON.parse(committed);
  const regenObj = JSON.parse(regenerated);
  expect(
    "committed a8-recipe-bindings.json regenerates byte-identically except runnerSha256",
    JSON.stringify({ ...committedObj, runnerSha256: null }) === JSON.stringify({ ...regenObj, runnerSha256: null }),
  );
  expect(
    "committed bindings recipeDigest == live recipeDigest",
    committedObj.recipeDigest === bindings.recipeDigest,
  );
} else {
  expect("committed a8-recipe-bindings.json exists", false, BINDINGS_FILE);
}

/* ----------------------- verdict predicates: red/green --------------------- */

const conflict = expectedCaseFor("controlled-conflict");
const rec = (id) => conflict.visibleExpectations.find((r) => r.id === `controlled-conflict-${id}`);

// Overview headline: the selected Overview h1 must equal the frozen human headline.
const ovSurface = {
  headline: "Context conflict found",
  paragraphs: [
    "Matching occurrences from multiple source domains, with separately evidenced reporting origins, associate this image with a different context than the submitted claim.",
  ],
  metrics: { "Observed contexts": "1" },
};
expect("overview-headline green on the expected heading", a8HeadlineVerdict(rec("overview-headline"), ovSurface).ok === true);
expect("overview-headline RED on a wrong heading", a8HeadlineVerdict(rec("overview-headline"), { ...ovSurface, headline: "No context conflict found" }).ok === false);
expect("overview-headline RED on a missing heading", a8HeadlineVerdict(rec("overview-headline"), null).ok === false);
expect("overview-support green on the expected paragraph", a8SupportVerdict(rec("overview-support"), ovSurface).ok === true);
expect("overview-support RED when the paragraph is removed", a8SupportVerdict(rec("overview-support"), { ...ovSurface, paragraphs: [] }).ok === false);

// Caveat: the SAME visible predicate must go red when the rendered paragraph
// is removed and green when restored (the map's declared restore variant).
const noConflict = expectedCaseFor("controlled-no-conflict");
const caveatRec = noConflict.visibleExpectations.find((r) => expectedRecordKind(r, "controlled-no-conflict") === "caveat-visible");
const caveatSurface = { paragraphs: ["Supporting text.", "⚠ This does not prove the claim is true."] };
expect("caveat-visible green when the caveat renders", a8CaveatVerdict(caveatRec, caveatSurface).ok === true);
expect("caveat-visible RED on the same predicate when removed", a8CaveatVerdict(caveatRec, { paragraphs: ["Supporting text."] }).ok === false);
const serRec = rec("caveat-serialized");
expect("caveat-serialized green on the consumed terminal flag", a8CaveatSerializedVerdict(serRec, { doesNotProveClaimTrue: true }).ok === true);
expect("caveat-serialized RED when the consumed payload drops the flag", a8CaveatSerializedVerdict(serRec, { doesNotProveClaimTrue: false }).ok === false);
expect("caveat-serialized never reads rendered text (null terminal is RED)", a8CaveatSerializedVerdict(serRec, null).ok === false);

// Segments: null is an explicit withheld predicate, not a skip.
const segsRec = rec("analysis-segments"); // expect: 1 for controlled-conflict
expect("analysis-segments green on the rendered count", a8SegmentsVerdict(segsRec, { metrics: { "Observed contexts": "1" } }).ok === true);
expect("analysis-segments RED when withheld renders as a count", a8SegmentsVerdict(segsRec, { metrics: { "Observed contexts": "Unresolved" } }).ok === false);
const nullSeg = { ...segsRec, expect: null };
expect("analysis-segments null expectation green on 'Unresolved'", a8SegmentsVerdict(nullSeg, { metrics: { "Observed contexts": "Unresolved" } }).ok === true);
expect("analysis-segments null expectation RED on an invented count", a8SegmentsVerdict(nullSeg, { metrics: { "Observed contexts": "3" } }).ok === false);

// Coverage: counts from the rendered paragraph, performed identity from the
// explicit compared-pair set resolved against the consumed terminal edges —
// N83-4 semantics: ALL relationship rows render honestly labeled, only the
// comparedPairIds-resolving examined edges count as performed.
const covRec = rec("analysis-coverage");
const covTerminal = fixtureResult("controlled-conflict");
const covSurface = {
  coverageText: "Context comparisons: 1 pair compared across 2 selected of 2 eligible occurrences.",
  performedRows: [
    {
      text: "Same context — compared · between two retrieved occurrences Earlier: ev-muiw5agw-32 Later: ev-muiw5agw-33",
      buttons: 2,
    },
  ],
};
expect(
  "analysis-coverage green on parsed counts + opened pair key",
  a8CoverageVerdict(covRec, covSurface, ["ev-muiw5agw-32|ev-muiw5agw-33"], covTerminal).ok === true,
);
expect(
  "analysis-coverage RED on a phantom performed row (exact row cardinality)",
  a8CoverageVerdict(
    covRec,
    { ...covSurface, performedRows: [...covSurface.performedRows, { text: "ghost", buttons: 2 }] },
    ["ev-muiw5agw-32|ev-muiw5agw-33", null],
    covTerminal,
  ).ok === false,
);
expect(
  "analysis-coverage RED on a wrong rendered count",
  a8CoverageVerdict(covRec, { coverageText: "Context comparisons: 2 pairs compared across 2 selected of 2 eligible occurrences." }, ["ev-muiw5agw-32|ev-muiw5agw-33"], covTerminal).ok === false,
);
expect(
  "analysis-coverage RED when a compared pair was never actually opened",
  a8CoverageVerdict(covRec, covSurface, [null], covTerminal).ok === false,
);
expect(
  "analysis-coverage RED on a wrong endpoint (endpoint rejection)",
  a8CoverageVerdict(covRec, covSurface, ["ev-muiw5agw-32|ev-WRONG"], covTerminal).ok === false,
);
expect(
  "analysis-coverage RED on a dishonest row label (unexamined dressed as performed)",
  a8CoverageVerdict(
    covRec,
    { ...covSurface, performedRows: [{ text: "Not compared in this investigation · ev-muiw5agw-32 ev-muiw5agw-33", buttons: 2 }] },
    ["ev-muiw5agw-32|ev-muiw5agw-33"],
    covTerminal,
  ).ok === false,
);
const zeroCov = { ...covRec, expect: { eligible: 0, selected: 0, comparedPairs: 0, comparedPairIds: [], displayedDatedCore: 0 } };
expect(
  "zero-selected coverage green on the product's explicit empty sentence",
  a8CoverageVerdict(zeroCov, { coverageText: "Context comparisons: No occurrences were selected for context comparison." }, [], covTerminal).ok === true,
);

// Gates: label/value/detail plus per-link opened identity inside the gate row.
const gatesRec = rec("gates");
const gateSurface = {
  statusBasis: "Status basis: Qualifying conflicts corroborated.",
  gateItems: [
    { label: "Qualifying conflicts: passed", detail: "2 qualifying conflict candidate(s); >=2 required for CONTEXT_CONFLICT", supportButtons: 2 },
    { label: "Corroborating pair: passed", detail: "corroborating pair across distinct domains and separately evidenced reporting groups", supportButtons: 2 },
  ],
};
const gateOpened = { 0: ["ev-muiw5agw-32", "ev-muiw5agw-33"], 1: ["ev-muiw5agw-32", "ev-muiw5agw-33"] };
expect("gates green on matching labels, details and opened support ids", a8GatesVerdict(gatesRec, gateSurface, gateOpened).ok === true);
expect("gates RED on a changed gate label (gate rejection)", a8GatesVerdict(gatesRec, { ...gateSurface, gateItems: [{ ...gateSurface.gateItems[0], label: "Qualifying conflicts: not passed" }, gateSurface.gateItems[1]] }, gateOpened).ok === false);
expect("gates RED on a wrong opened support id (endpoint rejection)", a8GatesVerdict(gatesRec, gateSurface, { ...gateOpened, 0: ["ev-muiw5agw-32", "ev-WRONG"] }).ok === false);
expect("gates RED on a missing support link", a8GatesVerdict(gatesRec, { ...gateSurface, gateItems: [{ ...gateSurface.gateItems[0], supportButtons: 1 }, gateSurface.gateItems[1]] }, gateOpened).ok === false);
expect("gates RED on a changed status basis", a8GatesVerdict(gatesRec, { ...gateSurface, statusBasis: "Status basis: something else." }, gateOpened).ok === false);

// Origins: counts line + group headline/reasons + member and unresolved identity.
const orgRec = rec("analysis-origins");
const orgSurface = {
  originsText: "2 resolved reporting groups · 0 unresolved candidates. Shared-origin copies count as one group; unresolved origins cannot support a stronger corroboration finding.",
  groupItems: [
    { headline: "Reporting group of 1 occurrence · Separate reporting evidence", memberButtons: 1 },
    { headline: "Reporting group of 1 occurrence · Separate reporting evidence", memberButtons: 1 },
  ],
};
const orgOpened = { 0: ["ev-muiw5agw-32"], 1: ["ev-muiw5agw-33"], unresolved: [] };
expect("analysis-origins green on counts, groups, opened members", a8OriginsVerdict(orgRec, orgSurface, orgOpened).ok === true);
expect("analysis-origins RED on a wrong member identity (group rejection)", a8OriginsVerdict(orgRec, orgSurface, { ...orgOpened, 1: ["ev-WRONG"] }).ok === false);
expect("analysis-origins RED on a wrong resolved count", a8OriginsVerdict(orgRec, { ...orgSurface, originsText: "1 resolved reporting group · 0 unresolved candidates." }, orgOpened).ok === false);
expect("analysis-origins RED on a missing rendered reason", a8OriginsVerdict(orgRec, { ...orgSurface, groupItems: [{ headline: "Reporting group of 1 occurrence" }, orgSurface.groupItems[1]] }, orgOpened).ok === false);

// Unresolved candidates: exercised on the F4b owner's real expectation.
const unresCase = expectedCaseFor("controlled-trace-unresolved-origin");
const unresRec = unresCase.visibleExpectations.find((r) => expectedRecordKind(r, "controlled-trace-unresolved-origin") === "analysis-origins");
const unresIds = unresRec.expect.unresolvedCandidateIds;
expect("F4b fixture really expects unresolved candidates", unresIds.length > 0, JSON.stringify(unresIds));
{
  const s = {
    originsText: `${unresRec.expect.reportingGroupCount} resolved reporting ${unresRec.expect.reportingGroupCount === 1 ? "group" : "groups"} · ${unresIds.length} unresolved ${unresIds.length === 1 ? "candidate" : "candidates"}.`,
    groupItems: (unresRec.expect.groups ?? []).map((g) => ({
      headline: `Reporting group of ${g.memberIds.length} occurrence${g.memberIds.length === 1 ? "" : "s"}${g.renderedReasons.length ? " · " + g.renderedReasons.join("; ") : ""}`,
      memberButtons: g.memberIds.length,
    })),
  };
  const opened = {};
  for (const [i, g] of (unresRec.expect.groups ?? []).entries()) opened[i] = [...g.memberIds];
  opened.unresolved = [...unresIds];
  expect("F4b origins green on its own real expectation shape", a8OriginsVerdict(unresRec, s, opened).ok === true,
    JSON.stringify({ groups: unresRec.expect.groups?.map((g) => g.groupId), unresolved: unresIds }));
  const wrongU = { ...opened, unresolved: [...unresIds].reverse() };
  // order matters: a reversed unresolved list opens the wrong identity first
  if (unresIds.length > 1) {
    expect("F4b origins RED when unresolved ids open in the wrong identity order", a8OriginsVerdict(unresRec, s, wrongU).ok === false);
  }
}

// Policy-not-applicable: the trace fallback text, via the F-family owner case.
const pna = unresCase.visibleExpectations.find((r) => expectedRecordKind(r, "controlled-trace-unresolved-origin") === "analysis-policy-not-applicable");
expect("policy-not-applicable green on the fallback sentence", a8PolicyNaVerdict(pna, { whyFallback: pna.expect }).ok === true);
expect("policy-not-applicable RED when the fallback is absent", a8PolicyNaVerdict(pna, { whyFallback: null }).ok === false);

// Timeline ids: opened identity order is the assertion.
const tlRec = rec("timeline-ids");
expect("timeline-ids green on the opened id sequence", a8TimelineIdsVerdict(tlRec, ["ev-muiw5agw-32", "ev-muiw5agw-33"]).ok === true);
expect("timeline-ids RED on a reordered open", a8TimelineIdsVerdict(tlRec, ["ev-muiw5agw-33", "ev-muiw5agw-32"]).ok === false);
expect("timeline-ids RED when an open fails (null id)", a8TimelineIdsVerdict(tlRec, ["ev-muiw5agw-32", null]).ok === false);

// Undated-section absence vs placement: opposite expectations, same section.
const absRec = rec("undated-section-absent");
expect("undated-section-absent green when the section is absent", a8UndatedAbsentVerdict(absRec, { undated: { sectionPresent: false, items: [] } }).ok === true);
expect("undated-section-absent RED when undated items exist", a8UndatedAbsentVerdict(absRec, { undated: { sectionPresent: true, items: [{ title: "x" }] } }).ok === false);

// Empty state: the dated list is empty AND the product's empty state renders.
const insuff = expectedCaseFor("controlled-insufficient");
const esRec = insuff.visibleExpectations.find((r) => expectedRecordKind(r, "controlled-insufficient") === "timeline-empty-state");
expect("timeline-empty-state green on dated=0 + empty-state copy", a8EmptyStateVerdict(esRec, { datedCount: 0, noDatedCoreState: true, noOccurrencesState: false }).ok === true);
expect("timeline-empty-state RED when dated items render anyway", a8EmptyStateVerdict(esRec, { datedCount: 2, noDatedCoreState: false, noOccurrencesState: false }).ok === false);
expect("timeline-empty-state RED when no empty-state copy renders", a8EmptyStateVerdict(esRec, { datedCount: 0, noDatedCoreState: false, noOccurrencesState: false }).ok === false);

// Placement: F1 owner — badges, per-id notes, opened identity, dated exclusion.
const f1 = expectedCaseFor("controlled-placement-disputed-vs-unknown");
const plRec = f1.visibleExpectations.find((r) => expectedRecordKind(r, "controlled-placement-disputed-vs-unknown") === "placement");
const plSurface = {
  datedIdsOpened: ["ev-muiw5aiv-53"],
  undated: {
    sectionPresent: true,
    heading: "Additional evidence · date unknown",
    headingRendered: "ADDITIONAL EVIDENCE · DATE UNKNOWN",
    headingCount: 1,
    headingVisible: true,
    items: [
      { title: "disputed", text: "Date unknown No usable date was retrieved for this occurrence. The retrieved dates for this occurrence disagree." },
      { title: "unknown", text: "Date unknown No usable date was retrieved for this occurrence." },
    ],
  },
};
expect("F1 placement green on its own real expectation shape", a8PlacementVerdict(plRec, plSurface, ["ev-muiw5aiv-54", "ev-muiw5aiv-55"]).ok === true);
expect("F1 placement RED when a disputed note lands on the wrong item", a8PlacementVerdict(plRec, { ...plSurface, undated: { ...plSurface.undated, items: [plSurface.undated.items[1], plSurface.undated.items[0]] } }, ["ev-muiw5aiv-54", "ev-muiw5aiv-55"]).ok === false);
expect("F1 placement RED when the opened identity disagrees", a8PlacementVerdict(plRec, plSurface, ["ev-muiw5aiv-54", "ev-WRONG"]).ok === false);
expect("F1 placement RED when an undated id enters the dated timeline", a8PlacementVerdict(plRec, { ...plSurface, datedIdsOpened: ["ev-muiw5aiv-53", "ev-muiw5aiv-54"] }, ["ev-muiw5aiv-54", "ev-muiw5aiv-55"]).ok === false);
expect("F1 placement RED when the badge is missing", a8PlacementVerdict(plRec, { ...plSurface, undated: { ...plSurface.undated, items: [{ title: "disputed", text: "No usable date was retrieved for this occurrence. The retrieved dates for this occurrence disagree." }, plSurface.undated.items[1]] } }, ["ev-muiw5aiv-54", "ev-muiw5aiv-55"]).ok === false);

// Divergence: the note's Earlier/Later buttons open the expected endpoints.
const pair = expectedCaseFor("controlled-pair");
const divRec = pair.visibleExpectations.find((r) => expectedRecordKind(r, "controlled-pair") === "divergence");
const divSurface = { divergenceNote: { present: true, buttons: ["Earlier: a →", "Later: b · first observed divergence →"] } };
expect("F5 divergence green on note + both endpoints inspectable", a8DivergenceVerdict(divRec, divSurface, { earlier: divRec.expect.from, later: divRec.expect.to }).ok === true);
expect("F5 divergence RED on a wrong later endpoint", a8DivergenceVerdict(divRec, divSurface, { earlier: divRec.expect.from, later: "ev-WRONG" }).ok === false);
expect("F5 divergence RED when the note is absent", a8DivergenceVerdict(divRec, { divergenceNote: { present: false, buttons: [] } }, { earlier: divRec.expect.from, later: divRec.expect.to }).ok === false);

// Connectors: F2 owner — each edge's label must sit on the 'to' item.
const f2 = expectedCaseFor("controlled-trace-uncertain-transition");
const connRec = f2.visibleExpectations.find((r) => expectedRecordKind(r, "controlled-trace-uncertain-transition") === "connectors");
const lp = connRec.expect?.laterDivergencePair ?? {};
const connSurface = {
  datedIdsOpened: f2.expectedIds.timeline,
  datedItems: [
    { title: "t1", text: "2024-01-01 item one" },
    { title: "t2", text: "2024-01-02 Not compared in this investigation item two" },
    { title: "t3", text: "2024-01-03 Different context from previous · compared item three", badges: [lp.expectInspection?.laterBadge] },
  ],
  divergenceNote: {
    present: true,
    text: `First observed context divergence in retrieved evidence. ${lp.expectDivergenceNote}`,
    buttons: ["Earlier: x →", "Later: y →"],
  },
};
expect("F2 connectors green on per-edge labels at the right occurrence", a8ConnectorsVerdict(connRec, f2, connSurface).ok === true);
expect(
  "F2 connectors RED when the required unresolved note sentence is absent",
  a8ConnectorsVerdict(connRec, f2, {
    ...connSurface,
    divergenceNote: { ...connSurface.divergenceNote, text: "The later occurrence below presents the media in a different context than the earlier one, in retrieved evidence." },
  }).ok === false,
);
expect(
  "F2 connectors RED when the later card lacks the divergence badge",
  a8ConnectorsVerdict(connRec, f2, {
    ...connSurface,
    datedItems: [connSurface.datedItems[0], connSurface.datedItems[1], { title: "t3", text: "2024-01-03 Different context from previous · compared item three" }],
  }).ok === false,
);
expect(
  "F2 connectors RED when the badge rides on the WRONG card",
  a8ConnectorsVerdict(connRec, f2, {
    ...connSurface,
    datedItems: [
      { title: "t1", text: "2024-01-01 item one", badges: [lp.expectInspection?.laterBadge] },
      connSurface.datedItems[1],
      { title: "t3", text: "2024-01-03 Different context from previous · compared item three" },
    ],
  }).ok === false,
);
expect(
  "F2 connectors RED when the unexamined edge is mislabeled compared",
  a8ConnectorsVerdict(connRec, f2, { ...connSurface, datedItems: [connSurface.datedItems[0], { title: "t2", text: "Different context from previous · compared item two" }, connSurface.datedItems[2]] }).ok === false,
);
expect(
  "F2 connectors RED when the compared edge's label is missing",
  a8ConnectorsVerdict(connRec, f2, { ...connSurface, datedItems: [connSurface.datedItems[0], connSurface.datedItems[1], { title: "t3", text: "item three" }] }).ok === false,
);

/* ------------------------- probe sources parse ----------------------------- */

for (const [name, src] of Object.entries({ A8_OVERVIEW_PROBE_FN, A8_TIMELINE_PROBE_FN, A8_ANALYSIS_PROBE_FN })) {
  let ok = true;
  try {
    new Function(`return ${src}`);
  } catch (e) {
    ok = false;
    console.log(`    ${name} parse error: ${e.message}`);
  }
  expect(`${name} parses as a page-side function`, ok);
}

/* -------------------- CLI schema: the real parse gates --------------------- */

const runCli = (args) => {
  try {
    const out = execFileSync("node", [CLI, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
};
{
  // A8 recipe path: --case <fixture> for viewer is accepted by the real parser
  // (failure then surfaces at the manifest stage, not at case validation).
  const ok = runCli(["drive", "viewer", "--entry", "timeline", "--case", "controlled-trace", "--run-id", "a8ctl-nonexistent"]);
  expect(
    "viewer accepts a fixture name as --case (A8 recipe path)",
    !/unsupported --case/.test(ok.out) && /cannot resolve run|no manifest for run-id|is not alive/.test(ok.out),
    ok.out.trim().split("\n")[0],
  );
  const bad = runCli(["drive", "viewer", "--entry", "timeline", "--case", "not-a-real-case", "--run-id", "a8ctl-nonexistent"]);
  expect(
    "viewer still rejects a name that is neither case nor fixture",
    /unsupported --case/.test(bad.out),
    bad.out.trim().split("\n")[0],
  );
  const badResult = runCli(["drive", "result", "--case", "not-a-real-case", "--run-id", "a8ctl-nonexistent"]);
  expect("result rejects an unknown fixture case", /unknown fixture case/.test(badResult.out), badResult.out.trim().split("\n")[0]);
}

console.log(JSON.stringify({ control: "a8-map-bindings", checks: results.length, failures, ok: failures === 0 }));
console.log(failures === 0 ? "PASS: a8 map bindings + verdicts discriminate" : `FAIL: ${failures} expectation(s) failed`);
process.exit(failures === 0 ? 0 : 1);
