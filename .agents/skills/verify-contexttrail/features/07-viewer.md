# Evidence inspection and comparison

From any evidence entry point the dialog opens, shows a real retrieved image
or an honest fallback, walks forward and backward, links the original source
safely, and hands focus back when it closes.

## Sub-features

- viewer-entry: timeline, sources and takeaway rows all open the same dialog
- viewer-media: a loadable image loads; an unreachable one shows the fallback rather than a broken `<img>`
- viewer-content: position counter, next/previous, technical details and source link
- viewer-focus: Escape closes, focus is not left inside the hidden dialog, focus returns to the entry control
- viewer-responsive: the mobile image-mode group is visible on mobile and hidden on desktop

## Drive command

```
bin/control-contexttrail drive viewer --run-id <id> \
  --entry timeline|sources|takeaway \
  --case image-load|image-fail|no-excerpt|pair \
  --viewport desktop|mobile
```

Defaults: `--entry timeline`, `--case image-load`, `--viewport desktop`.

`--case pair` is **NOT IMPLEMENTED** and exits 2 with that explanation: the
product exposes a paired-divergence viewer entry, but no controlled fixture
emits a paired divergence endpoint, so the case cannot be driven honestly.

## Assertions (executable contract)

Entry and dialog:

| ID | What it proves |
| --- | --- |
| `viewer.timeline-entry-present` / `viewer.sources-entry-present` / `viewer.takeaway-entry-present` | the chosen entry point exists |
| `viewer.dialog-open` | `role="dialog"` rendered |
| `viewer.back-to-timeline` | the close control is present |

Media (per `--case`):

| ID | Case | What it proves |
| --- | --- | --- |
| `viewer.image-load` | `image-load` | an `img[alt^="Retrieved image"]` reaches `complete && naturalWidth > 0` |
| `viewer.image-fail-shows-fallback` | `image-fail` | the `retrieved image unavailable` fallback renders and no broken `<img>` remains |
| `viewer.no-excerpt-state` | `no-excerpt` | `No excerpt available` renders |
| `viewer.pair-entry-present` | `pair` | not reachable — see above |

Navigation and content:

| ID | What it proves |
| --- | --- |
| `viewer.position-counter` | `<n> of <m>` renders |
| `viewer.next-changes-position` | Next evidence advances the counter |
| `viewer.prev-restores-position` | Previous evidence returns to the exact prior value |
| `viewer.mobile-image-toggle` (mobile) | `[aria-label="Choose image to inspect"]` is **visible** |
| `viewer.mobile-toggle-pressed-state` (mobile) | `aria-pressed` is reported on the submitted-image button |
| `viewer.desktop-hides-mobile-toggle` (desktop) | the same group is attached but **not visible** (`lg:hidden`) |
| `viewer.source-link-present` / `-url` / `-noopener` | `Open original source` is an `https?` link with `target="_blank"` and `rel` containing `noopener` |
| `viewer.technical-details-fields` | expanding `Technical details` yields ≥1 `<dd>` |
| `viewer.technical-details-real-fields` | no `<dt>` label contains `undefined`, `null` or `NaN` |

Focus:

| ID | What it proves |
| --- | --- |
| `viewer.escape-closes` | Escape hides the dialog |
| `viewer.focus-not-left-in-hidden-dialog` | `document.activeElement` is not inside a `[role=dialog]` after close |
| `viewer.focus-restored-after-close` | focus is not on `<body>` **and** it is back on the entry control that opened the dialog |
| `viewer.focus-after-details-close` (INFO) | where focus lands when the dialog is closed *after* the disclosure was used |

## Evidence

`01-viewer-<entry>-<case>.png`, `viewer-<entry>-<case>.aria.txt`, video,
`drive.json` (`entry`, `case`, `viewport`).

## Negative controls

| Command | Expected |
| --- | --- |
| `drive viewer --run-id <id> --case pair` | exit 2, explicit `NOT IMPLEMENTED` message |
| `drive viewer --run-id <id> --entry magic` | exit 2, lists `timeline\|sources\|takeaway` |
| `drive viewer --run-id <id> --viewport tablet` | exit 2, lists `desktop\|mobile` |
| `drive viewer --run-id <id> --live` without `RUN_LIVE_TESTS=1` | exit 2, provider credit gate |

## Known product finding (recorded, not hidden)

Closing the dialog **after** using the `Technical details` disclosure leaves
focus on `<body>` (`viewer.focus-after-details-close` INFO shows
`focusAfterDetails: null`), whereas a plain close restores focus to the entry
control. The plain-close path is the asserted contract; the disclosure path is
recorded as an INFO observation for upstream rather than being asserted green
or silently dropped.

## Gotchas

- The image-mode group is `lg:hidden`, so `count()` is the wrong instrument —
  the drive asserts `isVisible()` on both viewports.
- Console errors during media cases are classified: `example.invalid` /
  `fixture-*` hosts are `controlled-image-failure`, stream-origin failures are
  `blocked-api`, anything else is `unexpected` and fails
  `console.no-unexpected-errors`.
- Focus is captured with a dedicated `activeElement()` helper that reports
  `null` for `<body>`, so "focus lost to body" and "focus somewhere real" are
  distinguishable.

Keep screenshots, ARIA snapshots, action video, sanitized response/events and
invariant results with the feature ID. Cleanup closes owned runtime state and
preserves evidence.
