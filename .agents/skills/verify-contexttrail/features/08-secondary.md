# Sources, Analysis, and technical evidence

Every retrieved occurrence is listed with its origin and identity basis, and
the Analysis panel states the comparison coverage and policy reasons the
verdict actually rests on — with no placeholder text anywhere.

## Sub-features

- sources-list: one row per retrieved occurrence, matching the fixture exactly
- sources-origin: domain, date and reporting-group context on each row
- sources-identity: match basis is stated or explicitly "not reported"
- analysis-coverage: comparison coverage, status basis, policy gates and limitations
- analysis-honesty: no `undefined` / `null` / `NaN` / `Invalid Date` in either panel

## Drive command

```
bin/control-contexttrail drive result --run-id <id> --view sources [--case <fixture>]
bin/control-contexttrail drive result --run-id <id> --view analysis [--case <fixture>]
bin/control-contexttrail drive result --run-id <id> --view sources --viewport mobile
```

On `--view analysis` with an A8 fixture, each map record becomes its own
`a8.expect.<record-id>` assertion: coverage values parsed from the rendered
text, performed-comparison "Earlier"/"Later" buttons clicked to prove the
opened `Occurrence ID:`, gate labels/values/support links, group members, and
unresolved-candidate links — all scoped under
`section[aria-label="Analysis"]` via the first `ul` after each `h3`, with
empty sections gated off so a neighbouring list is never attributed to the
wrong heading.

## Assertions (executable contract)

Sources:

| ID | What it proves |
| --- | --- |
| `result.sources-count-matches-fixture` | `section[aria-label="Sources"] li` count equals `timeline + supportingEvidence + contextualEvidence + undatedEvidence` in the fixture |
| `result.sources-open-controls` | every source row carries an `Open source` link (row count == link count) |
| `result.sources-empty-state` | for an empty fixture, `No sources were retrieved` renders instead of an empty list |
| `result.sources-no-placeholder` | panel text contains no `undefined`, `null`, `NaN` or `Invalid Date` |
| `result.tab-sources-present` / `result.tab-sources-selected` | tab exists and reports `aria-selected=true` |
| `--fault bad-selection` | forces `aria-selected="false"` → **exit 1** |

Analysis:

| ID | What it proves |
| --- | --- |
| `result.analysis-section-present` | `section[aria-label="Analysis"]` rendered |
| `result.analysis-policy-or-coverage` | the panel names its comparison/policy/basis/limitation content |
| `result.analysis-coverage-pair-count` | the coverage sentence carries the fixture's real `comparedPairs` ("2 pairs compared"), with the singular form for 1 |
| `result.analysis-coverage-selection-counts` | it carries the fixture's real `selected`/`eligible` counts, or the explicit empty sentence when `eligible === 0` |
| `result.analysis-reporting-group-<i>-member-count` | each declared group renders `Reporting group of N occurrence(s)` with N equal to the group's real `memberIds.length` |
| `result.analysis-reporting-group-<i>-member-link` | each declared member is listed inside its group |
| `result.analysis-reporting-group-count-matches` | the number of rendered group headlines equals the fixture's `reportingGroups.length` and `reportingGroupCount` |
| `result.analysis-policy-gate-<gate>` | each declared `policyReasons` gate renders with its real pass/fail |
| `result.analysis-performed-list-count` | the "Comparisons performed" list holds one row per entry in the result's `comparisons` field — **direct rows only**, never a comparison's nested probability rows |
| `result.analysis-performed-probability-rows` / `-probabilities-normalized` | every returned distribution renders one option row per label and sums to 1 |
| `result.analysis-performed-probabilities-not-comparison-rows` | a probability row is never counted as a comparison |
| `result.analysis-performed-pairs-are-displayed` / `-list-identity` | every performed pair names two occurrences the result actually displayed, and each row names those same two in order — validated **whether or not** a coverage summary exists |
| `result.analysis-performed-list-not-invented` | with no `comparisons` field the view must say none was performed; an absent field is never read as zero |
| `result.analysis-coverage-count-matches-performed-list` | a **known** `comparedPairs` is cross-checked against the separately supplied list even when the summary used the empty-state sentence |
| `result.analysis-coverage-not-contradictory` | a summary may claim at most `max(0, selected − 1)` adjacent pairs — fewer is valid for imprecise/equal-date gaps — and never a pair with nothing eligible |
| `result.analysis-no-placeholder` | panel text contains no placeholder token |
| `result.reporting-group-not-mislabeled` | no `Shared group of N occurrence(s)` label anywhere (R4 residual — checked first so a regression is the failure that gets named) |
| `result.reporting-group-headline` | a resolved group renders the neutral `Reporting group of N occurrence(s)` |
| `result.reporting-group-empty-state` | when the fixture reports no groups, `No resolved reporting groups were reported` renders instead |
| `result.tab-analysis-present` / `result.tab-analysis-selected` | tab exists and reports `aria-selected=true` |

Selected-panel contrast and host clipping — every measured node is resolved
strictly INSIDE the selected tab's own `aria-controls` panel (asserted via
`result.selected-panel-aria-controls-resolved`), membership is re-checked per
node, and the effective-contrast helper marks every group-forming ancestor
with `opacity < 1` as `UNSUPPORTED` — a non-pass whose diagnostic ratio is
never an accepted number:

|| ID | What it proves |
|| --- | --- |
| `result.sources-contrast-sources-item-title-inside-selected-panel` / `-metadata` | the real Sources item title and metadata nodes were measured inside this panel — never the shared `ContextTrail` header or an `Open source` action link; when the fixture ships no occurrences the `No sources were retrieved.` explanation is the measured node instead (`-populated-absent` + `-empty-explanation-rendered`) |
| `result.sources-contrast-<node>-meets-AA` | effective contrast ≥ 4.5 (3.0 for large text); `UNSUPPORTED` is a non-pass, and an unrendered node never reaches the ratio at all |
| `result.analysis-contrast-<node>-inside-selected-panel` / `-meets-AA` | the real intro paragraph plus the **Retrieval accounting** row and trailing note (the pin's `requestLog`/`searchCounts` surface), measured inside the Analysis panel; when the fixture ships no accounting the `No retrieval counts were preserved…` explanation is the measured node |
| `result.sources-long-title-wraps-not-clipped` / `-empty-explanation-not-clipped` (mobile) | the longest Sources item title — or the rendered empty-state explanation when the contract is empty — lays out its FULL text on the node's own measured range: range beyond the node box or a clipping ancestor in either axis, and document horizontal overflow, are all red, not just "multiple lines" |

Shared with every result drive:

| ID | What it proves |
| --- | --- |
| `result.terminal-surface` | tablist + overview section present |
| `result.fixture-status-agrees` | rendered status equals the fixture terminal status |
| `result.no-fabricated-percentage` | overview carries no `\b\d{1,3}%\b` |
| `boundary.*`, `console.no-unexpected-errors` | boundary armed, no unexpected console error |

## Evidence

`01-result-sources.png` / `01-result-analysis.png`,
`result-sources.aria.txt` / `result-analysis.aria.txt`, `drive.json`
(`fixture`, `view`, `viewport`).

## Negative controls

| Command | Expected |
| --- | --- |
| `drive result --run-id <id> --view sources --fault bad-selection` | **exit 1** — `result.tab-sources-selected` fails |
| `drive result --run-id <id> --case controlled-insufficient --view sources` | exit 0 — empty-state branch (`result.sources-empty-state`) |
| `drive result --run-id <id> --case controlled-insufficient --view analysis` | exit 0 — empty reporting-group branch (`result.reporting-group-empty-state`) |
| `drive result --run-id <id> --view analysis --fault group-mislabel` | **exit 1** — `result.reporting-group-not-mislabeled` fails |
| `drive result --run-id <id> --view tab` | exit 2 |

## Gotchas

- The Sources row count is derived from the fixture's four evidence
  collections, which is exactly how `ResultView` builds its viewer list
  (`dated + unknownDate + supporting + contextual`). If the app's grouping
  changes, this assertion is the first thing to notice.
- `Open source` links must exist for every row: a row without a link would
  mean the source URL was dropped, which the count alone would not catch.
- The Analysis panel is asserted on *presence of its own vocabulary*
  (comparison/coverage/policy/basis/limitation), not on specific numbers —
  the numbers themselves are contract-validated by the fixture suite.
- Reporting-group headlines are a regression guard, not decoration: the
  backend group includes every resolved origin, so a hardcoded `Shared`
  label misdescribes separately-evidenced groups. The neutral headline is
  proven in the browser with `--fault group-mislabel` as its red run.
- Source-level date provenance (rejected root JSON-LD dates never reaching
  the timeline) is a `function-probe` tier check, not a browser one: the page
  fetch path is not exercised at the controlled boundary. See
  `npx vitest run src/lib/investigation/__tests__/supplemental.test.ts`.

Keep screenshots, ARIA snapshots, action video, sanitized response/events and
invariant results with the feature ID. Cleanup closes owned runtime state and
preserves evidence.
