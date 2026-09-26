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
| `result.analysis-no-placeholder` | panel text contains no placeholder token |
| `result.reporting-group-not-mislabeled` | no `Shared group of N occurrence(s)` label anywhere (R4 residual — checked first so a regression is the failure that gets named) |
| `result.reporting-group-headline` | a resolved group renders the neutral `Reporting group of N occurrence(s)` |
| `result.reporting-group-empty-state` | when the fixture reports no groups, `No resolved reporting groups were reported` renders instead |
| `result.tab-analysis-present` / `result.tab-analysis-selected` | tab exists and reports `aria-selected=true` |

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
