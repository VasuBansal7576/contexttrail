# Session navigation, responsive layout, and accessibility

A completed result survives a refresh only as text, the claim survives
failures, the layout does not overflow at either viewport, and every essential
control is reachable by keyboard with a visible focus ring.

## Sub-features

- session-refresh: cached result is offered explicitly, restored without stage history, or discarded
- session-back: browser Back from `/investigate` lands on a usable `/`
- session-new: New investigation clears claim, image and cache
- session-cancel / session-fatal: failure surfaces keep the claim and image
- layout-responsive: no horizontal overflow at desktop or mobile
- a11y-keyboard: tab order reaches the claim and links; no control is hidden from the tab order
- a11y-contrast: the primary heading meets WCAG AA against its painted background

## Drive commands

```
bin/control-contexttrail drive session --run-id <id> \
  --case refresh|back|new|cancel|fatal-retry
bin/control-contexttrail drive accessibility --run-id <id> --viewport desktop
bin/control-contexttrail drive accessibility --run-id <id> --viewport mobile
```

## Assertions (executable contract)

`--case refresh`:

| ID | What it proves |
| --- | --- |
| `session.storage-single-key` | sessionStorage holds exactly one key after a completed run |
| `session.storage-key-is-latest-result` | that key is `contexttrail.latest-result` |
| `session.storage-has-no-image-bytes` | no `data:image`, `blob:` or base64 image payload is stored |
| `session.storage-has-no-object-url` | no `blob:http` URL is stored |
| `session.restore-action-offered` | after refresh, `[aria-label="Restore previous result"]` renders |
| `session.restore-copy-honest` | the note says refreshing "never keeps your uploaded image" |
| `session.restore-shows-result` | `View last result` brings back the result tablist |
| `session.restore-notice-explains-loss` | the restored view says `Restored after refresh` and `never stored` |
| `session.restore-drops-stage-history` | no live stage list / retrieval counts on a restored result |
| `session.new-investigation-supersedes-cache` | after New investigation + refresh, no restore offer |
| `session.discard-clears-cache` | `Discard` removes the restore offer |
| `session.discard-removes-storage` | sessionStorage is empty after Discard |

`--case back`:

| ID | What it proves |
| --- | --- |
| `session.back-restores-landing` | browser Back from `/investigate` returns to `/` with the first CTA rendered |

`--case new`:

| ID | What it proves |
| --- | --- |
| `session.new-clears-claim` | claim input is empty |
| `session.new-clears-image` | selected-image preview is gone |

`--case cancel` / `--case fatal-retry`: see
[04-failures](./04-failures.md).

`accessibility --viewport desktop|mobile`:

| ID | What it proves |
| --- | --- |
| `a11y.claim-reachable-by-tab` | `#ct-claim` is reached by pressing Tab |
| `a11y.link-reachable-by-tab` | at least one `<a>` is reached by Tab |
| `a11y.no-negative-tabindex-focus` | no element reached by Tab has `tabIndex < 0` |
| `a11y.no-positive-tabindex` | no element in the order has `tabIndex > 0` |
| `a11y.no-control-hidden-from-tab-order` | DOM scan finds no `[tabindex]` with a negative resolved value other than `<body>` |
| `a11y.focus-visible-on-controls` | every tab stop reports a visible focus ring |
| `a11y.no-horizontal-overflow` | `scrollWidth - clientWidth <= 1px` |
| `a11y.submit-target-44px` | submit button height ≥ 44px |
| `a11y.h1-contrast-measured` | a foreground/background pair could be resolved for `h1` |
| `a11y.h1-contrast-wcag-aa` | contrast ratio ≥ 4.5 (or ≥ 3 for large text) |
| `a11y.storage-keys-only` | sessionStorage holds only `contexttrail.latest-result` |
| `a11y.storage-no-image-data` | no image bytes in sessionStorage |
| `a11y.tab-order` (INFO) | tab stops observed and whether the browser wrapped to `<body>` |

## Evidence

`01-session-refresh-restore-offer.png`, `02-session-refresh-restored.png`,
`01-session-cancel.png`, `01-session-fatal.png`, `storage-snapshot.json`,
`focus-sequence.json`, `contrast-h1.json`, `session-refresh-restored.aria.txt`,
`accessibility-initial.aria.txt`, video, `drive.json`.

## Negative controls

| Command | Expected |
| --- | --- |
| `drive session --run-id <id> --case nope` | exit 2, lists the five cases |
| `drive session --run-id <id> --entry x` | exit 2, session declares no `--entry` |
| `drive accessibility --run-id <id> --case refresh` | exit 2, accessibility declares no `--case` |
| `drive accessibility --run-id <id> --live` | exit 2, `--live` is only valid for investigation\|result\|viewer drives |
| `drive accessibility --run-id <id> --fault focus-removed` | **exit 1** — `a11y.claim-reachable-by-tab` fails |
| `drive accessibility --run-id <id> --fault a11y-false-green` | **exit 1** — unfocusable input / invisible heading / controlled console error |

## Gotchas

- **Tab wrap:** Chromium moves focus to `<body>` once the last tabbable has
  been passed. `<body>` carries `tabIndex="-1"` because Next.js uses it as a
  programmatic focus target after a route change — it is not a control and is
  excluded from the negative-tabindex assertions. The walk therefore stops at
  the first `<body>` and records the wrap as `a11y.tab-order`.
- The DOM scan (`a11y.no-control-hidden-from-tab-order`) is the non-vacuous
  half: a control hidden with `tabindex="-1"` is never reached by Tab, so only
  a direct scan can catch it.
- `session.restore-*` asserts that a refresh offers an explicit choice rather
  than silently dropping or silently resurrecting the result, and that the
  restored view is honest about what was lost (stage history, image preview).
- `a11y.h1-contrast-wcag-aa` still checks the resolved `h1` colour, but it is
  now the narrow case: `a11y.contrast-meets-floor` covers every visible text
  node on the screen, with the large-text exemption applied from computed font
  size and weight.

## Maintained measurements (A10)

These are measured in the browser on every `drive accessibility` /
`drive result` run, with a sabotage control for each; none stores a constant.

| Assertion | What it measures | Red control |
| --- | --- | --- |
| `a11y.contrast-meets-floor` | composited contrast per visible text node — background resolved by climbing ancestors, alpha composited, 4.5:1 normal / 3:1 large | `--fault contrast-lowered` |
| `a11y.focus-indicator-visible` | real Tab focus paints an indicator, compared with the same element unfocused | `--fault focus-ring-hidden` |
| `a11y.reduced-motion-emulated` / `-content-settled` / `-primary-target-44px` | the reduced-motion preference is emulated, then settled visibility and a 44px primary target are required | — |
| `result.long-values-no-horizontal-overflow` / `-wrap-not-truncate` | measured geometry on the long-value surfaces: nothing overflows horizontally, long values wrap instead of being cut, no `overflow:hidden` ancestor clips them. `--fault long-value-truncated` is red |
| `result.measurement-surface-is-the-requested-panel` | the requested view is selected and settled, and the measurement is scoped to *that* panel (`requestedView` / `observedTab` / `panelId` / `viewport` all persisted). This exists because the layout was previously collected before the tab was selected, so `--view sources` measured **Overview** and reported it under the Sources name |
| `result.reading-order-matches-dom` | measured visual order against DOM order by coordinate, over rows scoped to the panel that is actually selected. One pure comparator derives the stored verdict from those same rows and rejects missing/non-finite/vacuous data. `--fault reading-order-reversed` reverses `#ct-panel-sources section[aria-label="Sources"] > ul` (CSS only, DOM order untouched) and is red with 8 real inversions; `--fault reading-order-restored` applies then removes it and is green again |
| `result.reading-order-mutation-target-is-the-requested-list` | conditioned on the fault **actually requested**: with a reading fault, the target must be the selected tab's exact `aria-controls` panel's `section[aria-label="Sources"] > ul` with ≥2 direct visible `li`, applied before latching; with no fault the only requirement is that **no** sabotage target exists — the requested panel is already established by `result.measurement-surface-is-the-requested-panel`, so conditioning on Sources here made every other valid `--view` a false red. A control that silently missed cannot pass as a real one |
| `result.reading-order-matches-dom` — count semantics | the reported number is **adjacent decreases** in the visually sorted DOM-index sequence, each position where the next element is an earlier element in the document. It is not a pairwise comparison count and not a count of misordered items |
| `result.tablist-keyboard-<key>-consistent` / `-roving-tabindex` | ArrowRight ×2, Home, End, ArrowLeft move focus, `aria-selected`, the roving tabindex and the matching visible panel together | `--fault tab-map-broken` |

Measured, never read from a collector: the product has no `titleOverflow` or
`textOverflow` helper to call (checked in the pinned source — neither exists, and
wrapping is plain `flex-wrap` layout), so asserting against such a name would be a
false green about something that does not exist.

Not yet maintained here, though accepted private evidence exists for several of
them: per-screen composited contrast on the **dark** surfaces (landing,
investigation, viewer), mobile reading order and long-value wrapping on the
dense inspection content, and the selected-tab fallback for a hidden, disabled,
disconnected or `tabindex="-1"` opener.


Keep screenshots, ARIA snapshots, action video, sanitized response/events and
invariant results with the feature ID. Cleanup closes owned runtime state and
preserves evidence.
