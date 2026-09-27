# Media timeline, supporting leads, and context changes

The timeline shows what the fixture actually shipped: every dated occurrence,
in order, with its year, its source domain, and the connector that explains
the context change — and it never invents an item.

## Sub-features

- timeline-dated: the core dated occurrences render as an ordered list
- timeline-dates: usable dates are shown as years; unknown dates are grouped separately
- timeline-groups: supporting visual leads, contextual web results and unknown-date evidence each render their own section
- timeline-divergence: the first observed context divergence note appears only when the fixture has one

## Drive command

```
bin/control-contexttrail drive result --run-id <id> --view timeline \
  [--case controlled-claim|controlled-trace|controlled-viewer|controlled-insufficient]
bin/control-contexttrail drive viewer --run-id <id> --entry timeline \
  --case image-load|image-fail|no-excerpt --viewport desktop|mobile
```

## Assertions (executable contract)

Rendered-count contract — each is a comparison against the terminal
`investigation.completed` result inside the fixture itself, so a regression
that drops an item turns the drive red:

| ID | What it proves |
| --- | --- |
| `result.timeline-count-matches-fixture` | `#ct-panel-timeline ol > li` count equals the fixture's `timeline.length` |
| `result.timeline-shows-every-fixture-date` | **every** dated occurrence's own year appears in the rendered rows — a missing occurrence's date cannot hide behind a count match |
| `result.timeline-rendered-in-chronological-order` | the dates rendered in the panel are non-decreasing, and the fixture's own order is chronological |
| `result.timeline-connector-different_context` | the fixture has a decisive edge and the view renders `Different context from previous · compared` |
| `result.timeline-connector-same_context` | same for `Same context as previous · compared` |
| `result.timeline-connector-uncertain` | the fixture has a compared-but-unsettled edge and the view renders `Comparison inconclusive — performed but not established` |
| `result.timeline-connector-unexamined` | the fixture has an edge that was never compared and the view renders `Not compared in this investigation` |
| `result.timeline-no-invented-connector-<kind>` | a connector the fixture does **not** contain is never rendered |
| `result.timeline-distinguishes-not-compared-from-inconclusive` | the two different claims are never collapsed into one another |

`controlled-pair` is the fixture that exercises all four connector states in one
chronology: a decisive edge (the divergence pair), a same-day edge that was
never compared, and a compared-but-inconclusive edge. Because an unexamined or
uncertain edge breaks the decisive run, that fixture's `contextSegmentCount` is
`null` and no exact segment count may be claimed.
| `result.timeline-section-nonempty-contextual-web-results` | a labelled section that renders contains ≥1 item |
| `result.timeline-section-nonempty-supporting-visual-leads` | same for supporting leads |
| `result.timeline-section-nonempty-evidence-with-unknown-dates` | same for unknown-date evidence |
| `result.timeline-no-placeholder` | no `undefined`, `null`, `NaN` or `Invalid Date` in the panel text |
| `result.tab-timeline-present` / `result.tab-timeline-selected` | the tab exists and reports `aria-selected=true` |

Selected-panel contrast — each measured node is resolved strictly INSIDE the
selected tab's own `aria-controls` panel, membership is asserted per node, own
and ancestor opacity enter the effective foreground alpha, and any
group-forming ancestor with `opacity < 1` is verdict `UNSUPPORTED` — a
non-pass whose diagnostic ratio is never an accepted contrast number:

|| ID | What it proves |
|| --- | --- |
| `result.selected-panel-aria-controls-resolved` | the selected tab's own `aria-controls` resolves to a real `[role=tabpanel]` whose id matches — the measurement scope itself is asserted |
| `result.timeline-contrast-timeline-panel-heading-inside-selected-panel` / `-body` / `-note` | the real heading, body paragraph and trailing note were measured inside this panel, not a shared header |
| `result.timeline-contrast-<node>-meets-AA` | canvas-resolved effective contrast meets 4.5 (or 3.0 for large text); `UNSUPPORTED` is a non-pass |
| `result.timeline-contrast-surface-measured` | at least one accepted node was measured, or the panel is genuinely empty |

Entering an occurrence from the timeline:

| ID | What it proves |
| --- | --- |
| `viewer.timeline-entry-present` | `Inspect evidence` control exists on a timeline row |
| `viewer.dialog-open` | the evidence dialog opens |
| `viewer.takeaway-entry-present` | (overview) `View evidence →` exists on a takeaway row when takeaways ship |
| `viewer.source-link-*` | see [07-viewer](./07-viewer.md) |

For `--case controlled-insufficient` the timeline is genuinely empty: the
count assertion compares `0 rendered vs 0 fixture` and the empty state must
render instead of a fabricated list.

## Evidence

`01-result-timeline.png`, `result-timeline.aria.txt`, `drive.json`
(`fixture`, `view`), plus the viewer artifacts when entered from a row.

## Negative controls

| Command | Expected |
| --- | --- |
| `drive result --run-id <id> --view timeline --fault drop-timeline-item` | **exit 1** — `result.timeline-count-matches-fixture` fails (`0 rendered vs 2 fixture`) |
| `drive result --run-id <id> --view timeline --case controlled-trace` | exit 0 — trace fixtures carry a timeline with no conflict status |
| `drive result --run-id <id> --view tab` | exit 2, lists the four views |

The `drop-timeline-item` fault removes rendered occurrences every 50 ms; it is
the proof that the count assertions are not vacuous.

## Gotchas

- The labelled sections render only when non-empty, so a section assertion is
  written as "if it renders, it is non-empty" — an absent section is not a
  failure, a hollow one is.
- `motion.li` re-mounts on tab re-selection; any fault or assertion must
  therefore be re-evaluated rather than assumed stable across selections.
- Dates come from the fixture's `dateStatus`/`observedAt` contract, which the
  always-on fixture suite in `fixtures/gen-fixtures.test.ts` validates
  independently of the browser.

Keep screenshots, ARIA snapshots, action video, sanitized response/events and
invariant results with the feature ID. Cleanup closes owned runtime state and
preserves evidence.
