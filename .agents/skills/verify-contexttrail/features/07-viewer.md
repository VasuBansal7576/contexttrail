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

`--case pair` replays `controlled-pair`, the fixture whose terminal result
carries a real `firstObservedContextDivergence` whose two endpoints are
occurrences the report actually displays. If no checked-in fixture has one, the
case exits 2 naming the missing fixture rather than skipping silently.

Media cases are inspected with a **bounded, non-waiting** DOM read: an
auto-waiting locator against a missing `<img>` burns a full timeout per
navigation step, which is how several unavailable predecessors used to exceed
any sane bound.

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
| `viewer.image-matches-fixture-source` | `image-load` | the rendered `src` is byte-identical to the image the **fixture** shipped for that occurrence |
| `viewer.image-is-not-the-submitted-image` | `image-load` | the rendered retrieved `src` differs from the submitted image's `src` — non-substitution, proved rather than assumed |
| `viewer.pair-fixture-has-endpoints` | `pair` | the fixture really declares `fromOccurrenceId`/`toOccurrenceId` |
| `viewer.pair-endpoints-are-shown-occurrences` | `pair` | both endpoints exist in the displayed occurrences |
| `viewer.pair-endpoints-are-adjacent` | `pair` | the pair is two adjacent viewer positions |
| `viewer.order-starts-at-first-fixture-occurrence` | `pair` | navigating to the first position shows the fixture's first occurrence |
| `viewer.order-matches-fixture` | `pair` | every rendered position id equals the fixture's flat viewer order |
| `viewer.pair-earlier-id` / `viewer.pair-earlier-note` | `pair` | the earlier endpoint renders its own id and the *earlier occurrence* note |
| `viewer.pair-entry-present` / `-visible` / `-touch-target` | `pair` | the pair affordance exists, is visible and is ≥44px high |
| `viewer.pair-entry-keyboard-reachable` | `pair` | real sequential Tab navigation reaches the pair control (no programmatic focus) |
| `viewer.pair-keyboard-jumps-to-later-endpoint` | `pair` | Enter on the pair control lands on the later endpoint |
| `viewer.pair-later-note` | `pair` | the later endpoint renders the *first observed divergence* note |
| `viewer.pair-back-entry-present` | `pair` | the later endpoint can jump back |
| `viewer.pair-cleared-outside-pair-reachable` | `pair` | an occurrence outside the pair is reachable by ordinary Next |
| `viewer.pair-note-cleared-outside-pair` / `viewer.pair-entry-cleared-outside-pair` | `pair` | leaving the pair removes both the note and the pair control — no stale pair attribution |

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
| `viewer.technical-details-model-value` | the model field equals the **fixture's** `jevModel` verbatim |
| `viewer.technical-details-retrieved-at-value` | the retrieval timestamp equals the fixture's `retrievedAt` verbatim |
| `viewer.technical-details-canonical-url-value` | the canonical URL equals the fixture's `canonicalUrl` |
| `viewer.technical-details-result-position-value` | the result position equals the fixture's `serpPosition` |
| `viewer.technical-details-values-non-empty` | no rendered field is blank |
| `viewer.technical-details-no-empty-or-undefined-values` | no field renders `undefined`/`null`/`NaN`/`-` as its value |

Focus:

| ID | What it proves |
| --- | --- |
| `viewer.escape-closes` | Escape hides the dialog |
| `viewer.focus-not-left-in-hidden-dialog` | `document.activeElement` is not inside a `[role=dialog]` after close |
| `viewer.focus-inside-dialog-before-close` | focus is on a live in-dialog control before the close, so the assertion measures the product and not the harness's last click |
| `viewer.focus-restored-after-close` | focus is not on `<body>` **and** it is back on the entry control that opened the dialog |
| `viewer.focus-return-after-disclosure-close` | the same return contract holds when the dialog is closed **after** the `Technical details` disclosure was used — an asserted requirement, not an INFO note |

Focus restoration is applied after the dialog leaves the DOM, so the drive
waits (bounded) for focus to leave `<body>` before reading it. Reading it in the
same tick measured a harness race and produced a false "focus lost" INFO.

## Evidence

`00-viewer-open-<entry>-<case>.png` (the open dialog, before any close),
`01-viewer-<entry>-<case>.png`, `01/02/03-viewer-pair-*.png` for the pair case,
`viewer-<entry>-<case>.aria.txt`, `fixture-controlled-<n>.ndjson` (the exact
replayed bytes), `video/<name>.webm` (the browser's own uncut recording, copied
after the context closes and hashed), and `drive.json` (`entry`, `case`,
`viewport`, `fixture`, `fixtureSha256`, `input`, `videos`).

## Negative controls

| Command | Expected | Red proof |
| --- | --- | --- |
| `drive viewer --run-id <id> --case pair --fault pair-endpoint-wrong` | exit 1 on `viewer.order-starts-at-first-fixture-occurrence` | `verify5/gen-1` drive 011 |
| `drive viewer --run-id <id> --case pair --fault pair-note-wrong` | exit 1 on `viewer.pair-earlier-note` | `verify5/gen-1` drive 012 |
| `drive viewer --run-id <id> --case image-load --fault focus-return-broken` | exit 1 on `viewer.focus-restored-after-close` | `verify5/gen-1` drive 013 |
| `drive viewer --run-id <id> --entry magic` | exit 2, lists `timeline\|sources\|takeaway` | schema spot-check |
| `drive viewer --run-id <id> --viewport tablet` | exit 2, lists `desktop\|mobile` | schema spot-check |
| `drive viewer --run-id <id> --live` without `RUN_LIVE_TESTS=1` | exit 2, provider credit gate | schema spot-check |
| `drive viewer --run-id <id> --live` without `--image` | exit 2, names the missing explicit input | schema spot-check |
| `drive viewer --run-id <id> --live` without `--live-manifest` | exit 2, explains the readiness manifest | schema spot-check |
| `drive landing --fault bad-selection` | exit 2, fault is not applicable to `landing` | schema spot-check |

## Resolved: the disclosure-close focus finding was a harness race

An earlier run recorded `focusAfterDetails: null` as an INFO and the finding
"closing after the disclosure loses focus" was escalated upstream. With the
bounded settle wait in place, the same baseline returns focus to the entry
control, and the requirement is now asserted
(`viewer.focus-return-after-disclosure-close`) on every viewer drive rather than
noted. The escalation is withdrawn on this evidence; the assertion is not
weakened, and `--fault focus-return-broken` proves it can still fail.

## Gotchas

- The image-mode group is `lg:hidden`, so `count()` is the wrong instrument —
  the drive asserts `isVisible()` on both viewports.
- Console errors during media cases are classified: `example.invalid` /
  `fixture-*` hosts are `controlled-image-failure`, stream-origin failures are
  `blocked-api`, anything else is `unexpected` and fails
  `console.no-unexpected-errors`.
- Focus is captured with a dedicated `activeElement()` helper that reports
  `null` for `<body>`, so "focus lost to body" and "focus somewhere real" are
  distinguishable. Read it only after the bounded settle wait.
- The client normalizes the uploaded multipart part to the name
  `investigation-image` and submits its own preprocessed encoding, so the
  submitted bytes are never the harness file's bytes; the submission is
  verified by part presence, image media type, non-emptiness and the
  normalized name.
- The viewer exposes its open occurrence as `Evidence ID: <id>`, which is what
  the pair and order assertions compare against the fixture's own ids.

Keep screenshots, ARIA snapshots, action video, sanitized response/events and
invariant results with the feature ID. Cleanup closes owned runtime state and
preserves evidence.
