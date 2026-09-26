# Trace and claim result overview

The terminal result states a status the fixtures actually earned, shows real
counts instead of a fabricated score, and its four report tabs all work.

## Sub-features

- result-surface: tablist + overview section render only after the terminal event
- result-status: headline text matches the status the fixture produced
- result-metrics: earliest observation, source domains and observed contexts are shown as counts
- result-tabs: Overview / Timeline / Sources / Analysis are present, selectable and leave `aria-selected=true`
- result-honesty: no invented percentage anywhere in the overview

## Drive command

```
bin/control-contexttrail drive result --run-id <id> \
  [--case <fixture>] [--view overview|timeline|sources|analysis] [--delay-ms <ms>]
```

Defaults: `--case controlled-claim`, `--view overview`. `--case` accepts any
fixture present in `fixtures/`; `--view` ends with that tab selected, after
every tab has been visited and asserted.

## Assertions (executable contract)

| ID | What it proves |
| --- | --- |
| `result.progressive-observed` | stage list is visible before the terminal result is released |
| `result.terminal-absent-before-release` | `[aria-label="Result views"]` is absent while the stream is held |
| `result.terminal-surface` | tablist + `aria-label="Investigation result"` overview render |
| `result.status-headline` | headline matches `STATUS_COPY` (`Possible context conflict`, `Context conflict found`, `No conflict found in retrieved evidence`, `Insufficient evidence`, or the trace headlines) |
| `result.fixture-status-agrees` | rendered status equals the fixture terminal `status` and `mode` |
| `result.mode-is-trace` | trace fixtures render a mode, not a conflict status |
| `result.metrics-present` | overview names source domains / observed contexts / earliest observation |
| `result.no-fabricated-percentage` | overview contains no `\b\d{1,3}%\b` |
| `result.tab-overview-present` / `-selected` | Overview tab exists and reports `aria-selected=true` when chosen |
| `result.tab-timeline-present` / `-selected` | Timeline tab |
| `result.tab-sources-present` / `-selected` | Sources tab |
| `result.tab-analysis-present` / `-selected` | Analysis tab |
| `boundary.*`, `console.no-unexpected-errors` | boundary armed, no unexpected console error |

`--fault bad-selection` forces the Sources tab back to
`aria-selected="false"` after selection: `result.tab-sources-selected` fails
and the drive exits 1.

## Evidence

`01-result-<view>.png`, `result-<view>.aria.txt`, `request-capture.json`,
`drive.json` (`fixture`, `generator: contexttrail-fixtures`, `view`).

## Negative controls

| Command | Expected |
| --- | --- |
| `drive result --run-id <id> --view` | exit 2, `--view` requires a value |
| `drive result --run-id <id> --view tab` | exit 2, lists the four views |
| `drive result --run-id <id> --mode claim` | exit 2, result declares no `--mode` |
| `drive result --run-id <id> --case pair` | exit 2 (no such fixture) |
| `drive result --run-id <id> --claim-text hi` | exit 2, `--claim-text` is only valid with `--live` |
| `drive result --run-id <id> --fault bad-selection` | **exit 1** — `result.tab-sources-selected` fails |

## Gotchas

- Metrics are read while Overview is the selected tab, then the drive
  finishes on the requested `--view`, so metric assertions are never taken
  from the wrong panel.
- `STATUS_COPY` is the single source of headline text; the fixture and the
  page must agree or `result.fixture-status-agrees` fails — a fixture cannot
  smuggle in a status the product would not render.
- A restored result (see [09-session-layout](./09-session-layout.md)) is a
  different surface: it has no live stage history and carries the
  "Restored after refresh" notice.

Keep screenshots, ARIA snapshots, action video, sanitized response/events and
invariant results with the feature ID. Cleanup closes owned runtime state and
preserves evidence.
