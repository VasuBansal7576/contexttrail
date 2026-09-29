/**
 * MUTATION CONTROLS for the Analysis comparison-coverage assertions — not
 * fixtures.
 *
 * Each `write()` produces a NEW, untracked stream beside the checked-in
 * fixtures; no tracked fixture is ever regenerated or edited. Run `clean` to
 * remove them, and keep them removed: `fixtures/gen-fixtures.test.ts` validates
 * every `*.ndjson` in the fixtures directory, so a leftover mutant would be
 * asserted as if it were real evidence. The harness run that uses a mutant is a
 * deliberate red control, never acceptance proof.
 *
 * These streams are NOT fixtures for the harness's own evidence set: they are
 * derived here, in this throwaway file, from a copy of a checked-in controlled
 * stream, so that no tracked fixture is regenerated or edited. Each mutant keeps
 * the terminal event's identity and only changes the coverage numbers, which is
 * what the assertions under test are about.
 *
 * Source attribution: derived from .agents/skills/verify-contexttrail/fixtures/
 * controlled-insufficient.ndjson and controlled-pair.ndjson at the pinned
 * runner. No provider call, no React state setter, no app source touched.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = OUT;
const MUTANTS = [
  "controlled-empty-contrary-count",
  "controlled-empty-summary-contradiction",
  "controlled-pair-availability-mutant",
  "controlled-pair-phantom-performed",
];

const read = (name) =>
  fs
    .readFileSync(path.join(FIXTURES, `${name}.ndjson`), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));

const write = (name, events) => {
  fs.writeFileSync(
    path.join(FIXTURES, `${name}.ndjson`),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
};

/** An empty run whose coverage CLAIMS a performed pair: eligible 0, selected 0,
 *  comparedPairs 2 with two recorded pair ids. A view that trusts the number
 *  renders "2 pairs compared across 0 selected of 0 eligible occurrences" — a
 *  count that contradicts the run. */
function contraryCount() {
  const events = read("controlled-insufficient");
  const last = events[events.length - 1];
  last.result.comparisonCoverage = {
    eligible: 0,
    selected: 0,
    comparedPairs: 2,
    displayedDatedCore: 0,
    // Ids that do not exist in this (empty) result: a phantom performed pair.
    comparedPairIds: ["ev-mutant-a|ev-mutant-b", "ev-mutant-c|ev-mutant-d"],
  };
  write("controlled-empty-contrary-count", events);
}

/** Availability contradiction, in the form the view actually projects: the
 *  result carries a real `comparisons` array (the field the performed list is
 *  built from) while `comparisonCoverage.comparedPairs` says none was compared.
 *  Both fields are present, so the cross-check is meaningful and must be red. */
function availabilityContradiction() {
  const events = read("controlled-pair");
  const last = events[events.length - 1];
  const byId = new Map(
    [...last.result.timeline].map((t) => [t.evidenceId, t]),
  );
  const pairs = last.result.comparisonCoverage.comparedPairIds.map((pair) => {
    const [fromId, toId] = String(pair).split("|");
    const connector = byId.get(toId)?.incomingConnector?.kind ?? "unknown";
    return { pairId: `${fromId}|${toId}`, fromOccurrenceId: fromId, toOccurrenceId: toId, connector };
  });
  last.result.comparisons = pairs;
  last.result.comparisonCoverage.comparedPairs = 0; // the summary will claim none
  write("controlled-pair-availability-mutant", events);
}

/** A performed list that invents a pair the result never recorded. */
function phantomPerformedPair() {
  const events = read("controlled-pair");
  const last = events[events.length - 1];
  last.result.comparisons = [
    {
      pairId: "ev-phantom-a|ev-phantom-b",
      fromOccurrenceId: "ev-phantom-a",
      toOccurrenceId: "ev-phantom-b",
      connector: "same_context",
    },
  ];
  last.result.comparisonCoverage.comparedPairs = 1;
  write("controlled-pair-phantom-performed", events);
}

/** Performed comparisons presented for a run that selected and compared
 *  nothing: the coverage block is the honest empty one, while a `comparisons`
 *  array claims two performed pairs. The view then lists comparisons for an
 *  investigation that says it compared none. */
function summaryContradiction() {
  const events = read("controlled-insufficient");
  const last = events[events.length - 1];
  last.result.comparisons = [
    {
      pairId: "ev-phantom-x|ev-phantom-y",
      fromOccurrenceId: "ev-phantom-x",
      toOccurrenceId: "ev-phantom-y",
      connector: "same_context",
    },
    {
      pairId: "ev-phantom-z|ev-phantom-w",
      fromOccurrenceId: "ev-phantom-z",
      toOccurrenceId: "ev-phantom-w",
      connector: "same_context",
    },
  ];
  write("controlled-empty-summary-contradiction", events);
}

if (process.argv[2] === "clean") {
  for (const name of MUTANTS) {
    const p = path.join(FIXTURES, `${name}.ndjson`);
    if (fs.existsSync(p)) fs.rmSync(p);
  }
  console.log("removed every mutation-control stream");
  process.exit(0);
}

const which = process.argv[2];
if (which === "contrary-count") contraryCount();
else if (which === "summary-contradiction") summaryContradiction();
else if (which === "availability") availabilityContradiction();
else if (which === "phantom-performed") phantomPerformedPair();
else {
  console.error("usage: node tmp-coverage-mutants.mjs contrary-count|summary-contradiction|availability|phantom-performed");
  process.exit(2);
}
console.log(`wrote ${which} mutant stream into the fixtures directory`);
