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
  [--case <a8-fixture-name>] \
  --viewport desktop|mobile
```

```
bin/control-contexttrail drive viewer --run-id <id> \
  --focus-fallback hidden|disabled|disconnected|tabindex-negative
```

Defaults: `--entry timeline`, `--case image-load`, `--viewport desktop`.

`--focus-fallback <kind>` is the invalid-opener scenario: while the reopened
dialog is up, the recorded opener is mutated into the named un-restorable
state (the four prerequisites the product's own restore check rejects), then
the close must settle focus on the **selected tab's** recorded element key
instead of the opener's. It is an asserted positive contract, so it cannot be
combined with `--fault` — a second sabotage would make the outcome ambiguous
and the schema refuses it.

`--case pair` replays `controlled-pair`, the fixture whose terminal result
carries a real `firstObservedContextDivergence` whose two endpoints are
occurrences the report actually displays. If no checked-in fixture has one, the
case exits 2 naming the missing fixture rather than skipping silently.

`--case <a8-fixture-name>` (any of the 17 A8 fixture names) replays that
fixture and discharges the expected map's `viewer`-view records as
`a8.expect.<record-id>` assertions — `evidence-inspected`,
`identity-present`, `status-or-date` records verified against the opened
dialog's `Occurrence ID:` line. `--entry timeline` scopes the Inspect opener to
the map's exact occurrence identity rather than the first Inspect button.

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
| `viewer.image-decoded-and-rendered` | `image-load` | the accepted visible-image predicate: complete + decoded + non-transparent pixels + nonzero geometry + in-viewport, with no hiding ancestor (display, visibility, `hidden`, `aria-hidden`, opacity, content-visibility checked on EVERY ancestor) |
| `viewer.image-no-running-animation-at-rest` | `image-load` | the image's own recorded `runningAnimationCount` is 0 on the settled screen — unmeasured is a non-pass |
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
| `viewer.occurrence-attributed-to-fixture` | the rendered `Occurrence ID` resolves to an actual fixture row |
| `viewer.source-link-targets-occurrence` | the source link's `href` equals the fixture row's own `canonicalUrl`/`sourceUrl` — attribution proved against the fixture, not the DOM's claim |
| `viewer.attribution-matches-occurrence` | the fixture row's title renders inside the dialog |
| `viewer.excerpt-matches-occurrence` | the rendered quote is a strict prefix of that row's own excerpt — typographic wrapping/ellipsis still identifies the same excerpt |
| `viewer.excerpt-absent-when-fixture-has-none` | when the fixture row has no excerpt, no quote renders and `no excerpt available` is shown |
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
| `viewer.focus-targets-recorded` | both focus targets carry sampler-assigned per-element keys: the opener (the element that holds focus at the click) and the currently selected tab (the restore fallback) |
| `viewer.opener-holds-focus-at-trigger` | `document.activeElement` is the opener at the instant of the click — the product captures its `triggerRef` synchronously, so an unfocused click would record the wrong element |
| `viewer.escape-closes` | Escape hides the dialog |
| `viewer.focus-inside-dialog-before-close` | focus is on a live in-dialog control before the close, so the assertion measures the product and not the harness's last click |
| `viewer.focus-close-marker-recorded` / `-after-disclosure` | the per-frame log recorded an open dialog before this close — the settle starts at the frame the log actually recorded the dialog leaving the DOM, never a guess |
| `viewer.focus-expectation-computed` | a usable expectation exists (a key-able restorable opener, or a key-able selected tab) |
| `viewer.focus-not-left-in-hidden-dialog` | the final sampled active element is not `<body>`/null after close |
| `viewer.focus-restored-after-close` | the final consecutive identity run (dwell ≥3 frames) holds the recorded opener's element key across EVERY sample — same-label lookalikes cannot satisfy it |
| `viewer.focus-settle-basis-is-recorded-key` | the stable run's identity basis is the recorded element key, not a descriptor-only comparison (weaker proof) |
| `viewer.focus-fallback-opener-made-invalid` (`--focus-fallback`) | the keyed opener mutation landed and the opener is no longer restorable under the product's own prerequisites |
| `viewer.focus-fallback-lands-on-selected-tab` (`--focus-fallback`) | the settle lands on the SELECTED TAB's recorded key with basis `selected-tab-fallback` |
| `viewer.focus-return-after-disclosure-close` | the same return contract holds when the dialog is closed **after** the `Technical details` disclosure was used — an asserted requirement, not an INFO note |

Focus restoration is proven from a **per-frame sampled log** installed before
navigation: `document.activeElement` is sampled every animation frame, every
element that takes focus carries a recorded per-element `data-ctfk` key, and
the close marker is the first frame after the last frame on which the log saw
the dialog open. The settle requires the final consecutive identity run of
≥3 frames to carry the expected element's recorded key in every sample —
descriptor-only identity (label/role/selected) is recorded as weaker proof and
cannot satisfy a keyed assertion. A missing close marker, no post-marker
samples, a short run or the wrong key are all failures, never guesses.

## Evidence

`00-viewer-open-<entry>-<case>.png` (the open dialog, before any close),
`01-viewer-<entry>-<case>.png`, `01/02/03-viewer-pair-*.png` for the pair case,
`viewer-<entry>-<case>.aria.txt`, `focus-targets.json` (the keyed opener and
selected-tab descriptors), `focus-settle-close.json` and
`focus-settle-disclosure-close.json` (the close marker, the expectation and
its basis, and the full settle result per close), `viewer-media.json` (the
visible-image probe record on `image-load`), `fixture-controlled-<n>.ndjson`
(the exact replayed bytes), `video/<name>.webm` (the browser's own uncut
recording, copied after the context closes and hashed), and `drive.json`
(`entry`, `case`, `viewport`, `fixture`, `fixtureSha256`, `input`, `videos`).

## Negative controls

| Command | Expected | Red proof |
| --- | --- | --- |
| `drive viewer --run-id <id> --case pair --fault pair-endpoint-wrong` | exit 1 on `viewer.order-starts-at-first-fixture-occurrence` | `verify5/gen-1` drive 011 |
| `drive viewer --run-id <id> --case pair --fault pair-note-wrong` | exit 1 on `viewer.pair-earlier-note` | `verify5/gen-1` drive 012 |
| `drive viewer --run-id <id> --case image-load --fault focus-return-broken` | exit 1 on `viewer.focus-restored-after-close` | `verify5/gen-1` drive 013 |
| `drive viewer --run-id <id> --focus-fallback bogus` | exit 2, lists `hidden\|disabled\|disconnected\|tabindex-negative` | schema spot-check |
| `drive viewer --run-id <id> --focus-fallback hidden --fault focus-return-broken` | exit 2, the fallback is a positive contract and cannot combine with a sabotage | schema spot-check |
| `drive result --run-id <id> --focus-fallback hidden` | exit 2, the flag is viewer-only | schema spot-check |
| `drive viewer --run-id <id> --entry magic` | exit 2, lists `timeline\|sources\|takeaway` | schema spot-check |
| `drive viewer --run-id <id> --viewport tablet` | exit 2, lists `desktop\|mobile` | schema spot-check |
| `drive viewer --run-id <id> --live` without `RUN_LIVE_TESTS=1` | exit 2, provider credit gate | schema spot-check |
| `drive viewer --run-id <id> --live` without `--image` | exit 2, names the missing explicit input | schema spot-check |
| `drive viewer --run-id <id> --live` without `--live-manifest` | exit 2, explains the readiness manifest | schema spot-check |
| `drive landing --fault bad-selection` | exit 2, fault is not applicable to `landing` | schema spot-check |
| `drive viewer --case image-load --fault pair-note-wrong` | exit 2, that fault only applies to `--case pair` | `verify7` schema spot-check |
| `live-handler --feature viewer` with a declared result that has no occurrences | exit 0: the absence of an entry is explained, no dialog is claimed | `verify7` drive 002 |

## Resolved: the disclosure-close focus finding was a harness race

An earlier run recorded `focusAfterDetails: null` as an INFO and the finding
"closing after the disclosure loses focus" was escalated upstream. With the
bounded settle wait in place, the same baseline returns focus to the entry
control, and the requirement is now asserted
(`viewer.focus-return-after-disclosure-close`) on every viewer drive rather than
noted. The escalation is withdrawn on this evidence; the assertion is not
weakened, and `--fault focus-return-broken` proves it can still fail.

## Live path

`viewer --live` asserts the dialog contract against the response it receives and
never a fixture: the entry control is observed rather than required, media state
is observed (a still-loading image is not a failure at observation time), the
pair affordance is never demanded, technical details are recorded rather than
compared, and a response with nothing to inspect is explained
(`viewer.live-no-evidence-explained`) instead of failing as a missing entry. An
explicit `--case` is refused with `--live`. `live-handler --feature viewer` runs
this production path with the API intercepted and a locally declared result.

## Interruption

A viewer drive that is interrupted (Ctrl-C, SIGTERM) closes its browser, keeps
the partial recording inside its own evidence, and is written as INCOMPLETE with
`interruptedBy` and no pass verdict. The recording is real bytes, not a claim:
`verify12` preserves a 289 041-byte interrupted recording that re-hashes
byte-for-byte after cleanup.

## Gotchas

- The image-mode group is `lg:hidden`, so `count()` is the wrong instrument —
  the drive asserts `isVisible()` on both viewports.
- Console errors during media cases are classified: `example.invalid` /
  `fixture-*` hosts are `controlled-image-failure`, stream-origin failures are
  `blocked-api`, anything else is `unexpected` and fails
  `console.no-unexpected-errors`.
- Focus is proven from the sampled log, not a single post-close read: a
  transient `<body>` frame between unmount and restore is tolerated mid-run,
  but `<body>` as the final identity is lost focus and fails.
- The `--focus-fallback` mutation addresses the opener by its recorded
  `data-ctfk` key, so the element the product actually captured is the one
  invalidated — not a same-labelled lookalike.
- The client normalizes the uploaded multipart part to the name
  `investigation-image` and submits its own preprocessed encoding, so the
  submitted bytes are never the harness file's bytes; the submission is
  verified by part presence, image media type, non-emptiness and the
  normalized name.
- The viewer exposes its open occurrence as `Occurrence ID: <id>` inside the
  collapsed Technical-details disclosure (`Evidence ID:` on pre-7ab28e9
  builds), which is what the pair and order assertions compare against the
  fixture's own ids — read via `textContent`, since `innerText` skips the
  collapsed section.

Keep screenshots, ARIA snapshots, action video, sanitized response/events and
invariant results with the feature ID. Cleanup closes owned runtime state and
preserves evidence.
