# Landing and illustrative example

The correct destination is visible, the product is explained with repeated
imagery, the illustration is labeled, and no provider request runs.

## Sub-features

- landing-primary: every Start investigating entry opens upload
- landing-nav: How it works, Example and About land on real sections
- landing-example: visibly illustrative, no simulated provider activity
- landing-responsive: readable repeated-image composition on desktop/mobile

## Drive command

```
bin/control-contexttrail drive landing --run-id <id> --viewport desktop
bin/control-contexttrail drive landing --run-id <id> --viewport mobile
```

No extra options exist for this drive; `--case`, `--entry`, `--view`,
`--port`, `--revision` and `--expect-revision` are rejected with exit 2.

## Assertions (executable contract)

Every ID below is emitted by `drive landing`; a map entry that has no ID is
not verified.

| ID | What it proves |
| --- | --- |
| `landing.http-200` | `/` returns 200 |
| `landing.title` | document title carries the app identity |
| `landing.start-cta-count` | four `Start investigating` CTAs are present |
| `landing.cta-0-destination` … `landing.cta-2-destination` | each hero/header/lower CTA navigates to `/investigate` |
| `landing.example-cta-present` | the `See an example` secondary CTA exists |
| `landing.example-anchor-destination` | `See an example` reaches `#example` |
| `landing.anchor-set` | `#how-it-works`, `#example`, `#about` all resolve |
| `landing.anchor-target_how_it_works` | `#how-it-works` target element exists |
| `landing.anchor-target_example` | `#example` target element exists |
| `landing.anchor-target_about` | `#about` target element exists |
| `landing.anchor-scrolls-to-section` | clicking `#how-it-works` scrolls the section into view (**desktop only**) |
| `landing.viewport` (INFO) | which viewport the drive ran at |
| `landing.anchor-hrefs` (INFO) | the anchor hrefs actually observed |
| `boundary.zero-provider-attempts` | no provider call was attempted from landing |
| `boundary.provider-blocked` | the boundary monitor saw nothing to block |
| `boundary.mode-controlled` | run is a controlled (non-live) run |
| `console.no-unexpected-errors` | no unexpected console error during load |

## Evidence

`01-landing-<viewport>.png`, `landing-<viewport>.aria.txt`,
`focus-sequence` is not captured here (see
[09-session-layout](./09-session-layout.md)), `drive.json` with
`tier: real-ui`, `console.json`.

## Negative controls

| Command | Expected |
| --- | --- |
| `drive landing --run-id <id> --case valid` | exit 2, unsupported option |
| `drive landing --run-id <id> --port 3110` | exit 2, unsupported option |
| `drive landing --run-id <id> --live` | exit 2, `--live` is only valid for investigation\|result\|viewer |
| `drive landing --run-id <id> --fault anchor-broken` | **exit 1** — `landing.anchor-target_how_it_works` fails |
| `drive landing --run-id <id> --fault unexpected-request` | exit 1 — boundary sees a provider-shaped request |

The `anchor-broken` fault removes `#how-it-works` after load; the drive must
turn red rather than report green.

## Gotchas

- The three nav anchors are `hidden sm:inline`, so on mobile they are absent
  from the rendered layout. The `landing.anchor-set` / `landing.anchor-target_*`
  assertions read the DOM, which is the honest contract for "the anchors
  exist"; the visual reflow is covered by `landing.anchor-scrolls-to-section`
  on desktop only.
- `landing.anchor-scrolls-to-section` is skipped under `--fault`, because a
  faulted document is not a fair subject for a scroll assertion.
- Initial animation frames are not evidence of the final composition: this map
  asserts rendered copy, anchors and CTAs, not the loading state. Web-font
  loading and hero imagery are a design-review question, not an assertion this
  map makes — the previously recorded "requested fonts are not loaded" note is
  withdrawn, because nothing in this map tests fonts and the claim was never
  measured.
- The demo example is driven through its own CTA and asserted for destination
  and selection; whether the example image is a real sourced photograph is not
  something this map asserts.
- Landing never posts to `/api/investigate` — that is asserted, not assumed.

Keep screenshots, ARIA snapshots, action video, sanitized response/events and
invariant results with the feature ID. Cleanup closes owned runtime state and
preserves evidence.
