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
- Contrast is computed from the resolved `h1` colour against the nearest
  opaque painted ancestor background, with the WCAG large-text exemption
  applied from computed font size and weight.

Keep screenshots, ARIA snapshots, action video, sanitized response/events and
invariant results with the feature ID. Cleanup closes owned runtime state and
preserves evidence.
