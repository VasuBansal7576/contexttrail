# Consumer notes — `a8-expected-case-map.json`

This file is the **accepted** expected-case map, imported byte-exact from the
producer's `correction-final` set and sha256-pinned in the CLI loader:

- bytes: 177186
- sha256: `6721d89b33f01157baedc7aaf99e8dc3f56c8b9d6b5ea3703d5a4019c9455b48`
- release seal (producer, 19-file fixture subset): `f5435095b89132ea2ce3120b2de42311677267d8f7bbe41e38052a93077600a0`
- accepted app pin: `7b18c16f953aeed397030f51b5239f8d51fee2a5`
- fixture subset pin: `26528b6ee6345c019f016e909d4d17490c3db7eb`
- product authority pin: `9d404cb2e9e4ee35ad3bf0c07ee8f77e739ea2d0`

Any byte drift makes `loadExpectedCaseMap()` fail closed — a substituted or
edited map can never be asserted against silently.

## Independent-review qualifications (must be read with the map)

Per `ct-astra-review/a8-native-map-final-independent-review.md` (PASS for the
C1–C4 expectation data) and the producer's `correction-final/ERRATA.md`:

1. **Stage ownership and receipt.** The actual stage work is by Devin
   (SWE-2 High); the sealed map's `verifier-ack: PENDING` wording is superseded
   by the verifier physical receipt commit `6949ec9` (`fm/ct-verify-proof`),
   which passed independent review. `runnerPin`, `acceptedCommandArgs`,
   `caseId`, `caseImport` were **UNBOUND** at seal time — the bindings this
   harness authors live in `a8-recipe-bindings.json`, not in the sealed map.
2. **Stale `P5` sentence superseded.** The sealed `corrections.P5.evidence[2]`
   wording about "10 shared_origin occurrences collapse to one
   `dup:ev-muiw5ad6-3` group" is superseded: the frozen `controlled-trace`
   terminal has **two** distinct core members (`ev-muiw5ad6-3`,
   `ev-muiw5ad6-4`) sharing resolved group `dup:ev-muiw5ad6-3` with
   `reportingGroupCount` 1. Repeated `shared_origin` mentions across stream
   events are not distinct occurrences (`originSemantics.disprovingFixture`
   already states this correctly).
3. **Stale 95-count superseded.** `acceptedInventory.changedHere`'s retained
   "17/76/95" wording is superseded as a count description. Count authority:
   **147 expectation records = 141 visible + 6 serialized-only**; 76 distinct
   carried evidence IDs, of which 50 dated occurrence ID values are a subset;
   26 distinct compared-pair IDs (subset of 35 declared connector/comparison
   edge keys) are a separate pair-key namespace — `50+26=76` is coincidental,
   **not** a decomposition. The 147 records are consumed as distinct
   assertions; they are never collapsed into one count.
4. **Locator scope.** `locators.occurrenceOpener`'s "DATED TIMELINE
   OCCURRENCES ONLY" scopes **this plan's viewer action** — it is not a
   product-wide restriction. At pin `7b18c16` the shared `OccurrenceCard`
   renders an Inspect control for supporting, contextual and undated section
   cards too. Consequence honoured here: the viewer is opened via the
   **expected section and exact occurrence identity**, never a global
   repeated-name shortcut, and the opened identity is proven by the dialog's
   rendered `Occurrence ID:` line (`Evidence ID:` on pre-7ab28e9 builds; the
   line lives inside the collapsed Technical-details disclosure, so it is read
   via `textContent`) — not by raw visible ID text anywhere in the DOM.

## How the harness consumes it

- One `a8.expect.<record-id>` assertion per `visibleExpectations` record —
  147 records total across the 17 cases; `visible: false` records are checked
  against the **serialized consumed terminal payload** (e.g.
  `doesNotProveClaimTrue`), never against rendered text.
- `null` expectation values are explicit absent/unknown predicates (e.g.
  `analysis-segments` expects the rendered "Unresolved"), never skipped.
- Record → view bucket is by where the product actually renders the contract:
  `overview-headline|overview-support|caveat-visible|caveat-serialized|
  analysis-segments` on Overview (the segment count renders as the "Observed
  contexts" metric); `timeline-ids|timeline-empty-state|
  undated-section-absent|placement|divergence|connectors` on Timeline;
  `analysis-coverage|analysis-origins|analysis-policy-not-applicable|gates`
  on Analysis.
- Identity is always verified through the opened dialog's `Occurrence ID:` line:
  gate "View supporting evidence →" links, reporting-group member links,
  comparison-row Earlier/Later endpoints, divergence-note endpoints, and dated
  timeline Inspect buttons are clicked and the opened ID is compared to the
  expected ID — raw rendered text is never accepted as identity proof.
- Nothing here runs a provider call: every recipe is tier-1 (public-stream
  intercept) or explicitly tier-2 cache restoration; tier-3 is not authorized.
