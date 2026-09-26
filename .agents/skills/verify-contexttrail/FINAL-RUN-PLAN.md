# Final nine-feature execution and recording plan

**Preparation only.** Nothing here has been executed as final acceptance. The
runner is ready; the *candidate* is not. Execute this only when firstmate
supplies a final accepted candidate revision, and only after the entry gates
below are independently closed (checklist A1–A4 in
`data/ct-astra-review/final-acceptance-checklist.md`).

Everything in this plan is a real `control-contexttrail` invocation with the
options the runner actually implements. Where a required behaviour has **no
command today**, it is listed as a GAP with the assertion that would close it —
never as a command that does not exist, and never as a satisfied check.

---

## 0. Entry gates (before any capture)

| Gate | Requirement | Status |
| --- | --- | --- |
| Candidate | one immutable integrated revision, recorded with its sha and Next `BUILD_ID` | supplied by firstmate; last verified here: `9bef35c1` / `MQQYbrRn7fhZfsN9f3KOw` |
| Verification foundation | checklist A4: C1–C6, pair/focus, model identity, pixel and provenance guards | closed; C7 R1–R4 corrected this stage and awaiting independent acceptance |
| Live permission | `RUN_LIVE_TESTS=1` + `--live` + a readiness manifest per live chapter | **not granted**; the live chapters below are marked LIVE and stay unexecuted until the captain approves bounded calls |
| Browser ledger | checklist A12 | Chrome for Testing 153.0.8010.12 and native Chrome 153.0.8010.53 only. Edge/Firefox/Safari remain NOT_VERIFIED; do not install or enable anything implicitly |
| Theme | **corrected**: there is no theme feature. PRD§4.5 (1178–1190) fixes *per-screen surfaces* — dark landing, light upload, dark investigation, light result/timeline, dark viewer. Contrast must be measured on those surfaces where they are, not on a theme that does not exist | composited contrast is now measured by the runner on the screen it drives; per-screen coverage for the dark landing/investigation and dark viewer surfaces is still to be added |
| Graph authority (A1) | I1/I2/I4 accepted at `d279`; date I3 at `203` | accepted, carried by source — not reopened here |
| Inspection UI (A2) | measured UI, hostile wrapping, valid/invalid opener paths accepted at `9bef` | carried; the runner now measures composited contrast, keyboard-visible focus, the full tablist pattern and reduced motion |
| Location register (A3) | bounded discourse precedence accepted through `d279`; the optional undated-read decision stays recorded | carried, not reopened |
| Deadline (A9) | the **55 s pipeline cutoff is a native-timer acceptance at `ea1b` — do not rerun it to fill video length**. The **client watchdog is 90 000 ms** and was accepted on a virtual-clock tier, not as a native 90 s gate | do not invent a mandatory 90 s native gate; if a 90 s native recording is ever taken, label it 90 s and assert timeout with retained partial evidence, never cancellation |

```bash
# one immutable snapshot, own port, credential-stripped child env
bin/control-contexttrail launch --checkout <abs> --revision <candidate-sha> \
  --run-id final --port 3114
bin/control-contexttrail doctor  --run-id final --expect-revision <candidate-sha>
```

`doctor` must report `healthy: true`, `credentialsStripped: true`,
`buildDependenciesPresent: true`, `envFilesInSnapshot: []`. Record the
`buildDeps` block and `droppedNpmResolutionKeys` in the handover.

---

## 1. Labelling rule (applies to every chapter and every artifact)

| Label | Meaning | May be claimed as |
| --- | --- | --- |
| `CONTROLLED` | the API request was intercepted and a checked-in fixture was served (`tier: public-contract-boundary`) | rendering and behavior at the public contract — never provenance, never a real result |
| `LIVE` | a real provider run under `--live` with an approved readiness manifest | a real retrieval, with its own request/search ids and budgets |
| `REPLAY:f69ba92` | a retained recording from the earlier source pin | evidence **for that pin only**; it establishes nothing about the candidate |
| `UNIT` | `npx vitest` / function probe | the internals it exercises — not a user path |

A controlled strong verdict never establishes a live strong case. Offline
policy re-evaluation is not repaired live retrieval. Each video, screenshot and
ARIA file must carry its label in the chapter index; unlabeled footage is
disclosed, never assumed.

---

## 2. Chapters

Counts are the assertion IDs the chapter is expected to produce; `GAP` lines are
behaviours the current runner does not assert.

### 01 · Landing and illustrative example — `drive landing`
```bash
bin/control-contexttrail drive landing --run-id final
bin/control-contexttrail drive landing --run-id final --fault anchor-broken   # red control
```
Asserts: `landing.http-200`, `landing.title`, three/four CTA destinations, the
`#how-it-works` / `#example` / `#about` anchor set and each section target,
`landing.example-anchor-destination`, `landing.anchor-scrolls-to-section`
(desktop), `boundary.zero-provider-attempts`.
Checklist: A7, A14. Tier: CONTROLLED.
**GAP (A10):** no settled-hero/readability assertion; the map deliberately makes
no font or imagery claim.

### 02 · Image selection, entries and rejections — `drive upload`
```bash
for e in browse keyboard drop paste; do
  bin/control-contexttrail drive upload --run-id final --entry $e --case valid
done
for c in unsupported empty decode oversize replace remove claim-limit; do
  bin/control-contexttrail drive upload --run-id final --entry browse --case $c
done
bin/control-contexttrail drive upload --run-id final --entry browse --case valid --viewport mobile
```
Asserts: `upload.preview-visible`, `upload.preview-matches-file`, real file
chooser for `browse`/`keyboard` (`upload.entry-method`), each rejection path
(`upload.submit-disabled-after-*`, `upload.claim-cap-500`,
`upload.claim-counter-announced`, `upload.claim-survives-remove`),
`upload.submit-disabled-after-remove`. Checklist: A6, A7. Tier: CONTROLLED.
**GAP (A12):** drop/paste are synthesised `DataTransfer` events, not a native
gesture; record `upload.entry-method` for every chapter and do not describe them
as human gestures.

### 03 · Progress, evidence arrival, terminal mode — `drive investigation`
```bash
bin/control-contexttrail drive investigation --run-id final --mode trace --case controlled-trace
bin/control-contexttrail drive investigation --run-id final --mode claim --case controlled-claim
bin/control-contexttrail drive investigation --run-id final --mode claim --case controlled-pair --delay-ms 1500
```
Asserts: `investigation.progressive-before-terminal`,
`investigation.stage-completes-progressively`,
`investigation.evidence-arrives`, `investigation.pacing-observed`,
`result.trace-headline-exact`, `result.trace-fixture-carries-no-claim`,
`stream.submitted-media-*`, `stream.submitted-claim-presence-matches-mode`,
`stream.submitted-claim-matches-intended-text`.
Checklist: A6, A9. Tier: CONTROLLED (live equivalent is Chapter 10).
**GAP (A9):** the 55 s stalled-transport wall-clock gap is not measured by any
command — a stalled/deadline run needs a real delayed response, not a shorter
video.

### 04 · Cancel, retry, new investigation, refresh recovery — `drive session`
```bash
for c in cancel fatal-retry new back refresh; do
  bin/control-contexttrail drive session --run-id final --case $c
done
bin/control-contexttrail drive session --run-id final --case cancel --viewport mobile
```
Asserts: `session.*` — claim/image retained through cancel,
`fatal-retry` recovery, `new-clears-claim` / `new-clears-image`, back/refresh
restore-and-discard, `session.storage-*` privacy.
Checklist: A9. Tier: CONTROLLED public boundary (the request is redirected into
the fixture stream; upstream billing cancellation is **not** established).
**GAP (A9), still open after this stage:** the two-stream isolation scenario
(stream A early evidence → cancel/reset → stream B with distinct ids → a delayed
A candidate/terminal/error attempt while B is pending, asserting every visible
stage, result and cache stays B's) is **not implemented**. It is unproved
product behaviour, not a source-only defect finding, and no browser claim about a
late event is made. A deterministic hook/reader-level opposing control would have
to be labelled UNIT, never browser, and must actually let stale ownership affect
the assertion.

### 05 · All four result tabs, every claim/trace state — `drive result`
```bash
for v in overview timeline sources analysis; do
  bin/control-contexttrail drive result --run-id final --case controlled-claim   --view $v
  bin/control-contexttrail drive result --run-id final --case controlled-trace   --view $v
  bin/control-contexttrail drive result --run-id final --case controlled-pair    --view $v
  bin/control-contexttrail drive result --run-id final --case controlled-insufficient --view $v
done
```
Asserts per view: `result.tab-<view>-present` / `-selected`,
`result.<view>-no-placeholder`, the fixture-compared counts
(`takeaways-count-matches-fixture`, `timeline-count-matches-fixture`,
`sources-count-matches-fixture`), Overview metrics + `no-fabricated-percentage`,
Timeline dates/order/connectors (`timeline-shows-every-fixture-date`,
`timeline-rendered-in-chronological-order`, the four `timeline-connector-*` and
`timeline-no-invented-connector-*`, `timeline-distinguishes-not-compared-from-inconclusive`),
Sources row counts and `open source` controls, Analysis coverage/group/policy
equality (`analysis-coverage-*`, `analysis-performed-*`,
`analysis-reporting-group-*`, `analysis-policy-gate-*`).
Checklist: A7, A8. Tier: CONTROLLED.
**GAP (A8):** no shipped fixture covers `NO_CONFLICT_FOUND` with its mandatory
caveat, weak/strong Trace variants, unknown/disputed dates outside the dated
line, or >8 dated occurrences with selection/comparison gaps. Those states need
new fixture generation, which this stage is not authorized to do; list them as
uncovered rather than substituting `controlled-claim`.

### 06 · Paired divergence viewer, jump, notes, clearing — `drive viewer --case pair`
```bash
bin/control-contexttrail drive viewer --run-id final --case pair
bin/control-contexttrail drive viewer --run-id final --case pair --viewport mobile
bin/control-contexttrail drive viewer --run-id final --case pair --fault pair-note-wrong       # red
bin/control-contexttrail drive viewer --run-id final --case pair --fault pair-endpoint-wrong   # red
```
Asserts: endpoints exist and are adjacent, `order-matches-fixture`,
`pair-earlier-id` / `pair-earlier-note`, `pair-later-note`,
`pair-entry-keyboard-reachable` (real Tab), `pair-keyboard-jumps-to-later-endpoint`,
`pair-cleared-outside-pair-reachable`, `pair-note-cleared-outside-pair`,
`pair-entry-cleared-outside-pair`, `pair-entry-touch-target` (≥44px).
Checklist: A2, A7. Tier: CONTROLLED with genuinely distinct decoded images
(`viewer.image-matches-fixture-source`).
**GAP:** a *live* paired divergence is not asserted anywhere; `viewer --live`
observes the affordance only. A5's real pair remains unproved.

### 07 · Ordinary viewer entries, image modes, focus, technical detail — `drive viewer`
```bash
for e in timeline sources takeaway; do
  for c in image-load image-fail no-excerpt; do
    bin/control-contexttrail drive viewer --run-id final --entry $e --case $c
    bin/control-contexttrail drive viewer --run-id final --entry $e --case $c --viewport mobile
  done
done
bin/control-contexttrail drive viewer --run-id final --case image-load --fault focus-return-broken  # red
```
Asserts: entry present, dialog open, `00-viewer-open-*.png` captured **before**
any close, `position-counter`, `next-changes-position`, `prev-restores-position`,
`image-load` / `image-matches-fixture-source` /
`image-is-not-the-submitted-image`, `image-fail-shows-fallback`,
`no-excerpt-state`, `mobile-image-toggle` / `desktop-hides-mobile-toggle`,
`source-link-url` / `-noopener`, technical-detail **values**
(`technical-details-model-value`, `-retrieved-at-value`,
`-canonical-url-value`, `-result-position-value`, `-values-non-empty`),
`escape-closes`, `focus-inside-dialog-before-close`, `focus-restored-after-close`,
`focus-return-after-disclosure-close`.
Checklist: A2, A7, A10. Tier: CONTROLLED.
**GAP (A2):** a *disconnected, disabled or removed* opener has no fallback
assertion; focus return is proven for valid openers only, and the product-side
fallback is unverified.

### 08 · Keyboard, focus, contrast, targets, overflow, storage — `drive accessibility`
```bash
bin/control-contexttrail drive accessibility --run-id final --viewport desktop
bin/control-contexttrail drive accessibility --run-id final --viewport mobile
bin/control-contexttrail drive accessibility --run-id final --viewport mobile --fault focus-removed   # red
bin/control-contexttrail drive accessibility --run-id final --viewport desktop --fault a11y-false-green  # red
```
Asserts today: `a11y.claim-reachable-by-tab`, `a11y.link-reachable-by-tab`,
`a11y.tab-order`, `a11y.no-horizontal-overflow`, `a11y.submit-target-44px`,
`a11y.storage-keys-only`, `a11y.storage-no-image-data`, plus
`a11y.h1-contrast-measured` (the measurement is recorded, not gated).
Checklist: A10. Tier: real browser, measured styles/ARIA.
Now implemented in the runner (measured, with sabotage controls):

- `a11y.contrast-meets-floor` — composited contrast for every visible text node
  (4.5:1 normal, 3:1 large), background found by climbing ancestors and alpha
  composited, with `--fault contrast-lowered` red;
- `a11y.focus-indicator-visible` — real Tab focus must paint an indicator
  compared against the same element unfocused, with `--fault focus-ring-hidden`
  red;
- `result.tablist-keyboard-<key>-consistent` and `-roving-tabindex` for
  ArrowRight ×2, Home, End and ArrowLeft, with `--fault tab-map-broken` red;
- `a11y.reduced-motion-emulated` / `-content-settled` /
  `-primary-target-44px` — the media feature is emulated, the screen reloaded,
  and settled visibility with a 44 px primary target is required.

Still open for A10: per-screen composited contrast on the **dark** landing,
investigation and viewer surfaces (the runner measures the screen it drives, which
is the light upload/result surface); mobile reading order and long-value wrapping
on the dense inspection content; the selected-tab fallback for a hidden, disabled,
disconnected or `tabindex="-1"` opener; and media-failure / unavailable-excerpt
attribution. Accepted private 9bef evidence covers several of these inputs, but
they are not yet maintained assertions here.

### 09 · Sessions, responsive layout, privacy, cleanup
```bash
bin/control-contexttrail evidence --run-id final
bin/control-contexttrail cleanup --run-id final
```
Asserts: the seal enumerates every drive, its per-drive app/runner/fixture/map
hashes, `runnerFiles` as each drive read it, `fixtureBytesIntact`, the assertion
verdicts, `videosCollected`, `incompleteDrives`, `unclaimedRecordings` and
`readinessControls`; then `cleanup` prints `evidenceVideosSurviving` and
`orphanRecordingsPreserved` counted from evidence, releases only owned PIDs, and
the handover re-hashes every sealed artifact — including every `.webm` — after
cleanup, rejecting any zero-byte or missing recording as successful proof.
Checklist: A14. Tier: n/a.

### 10 · Live chapters — only with the captain's bounded-call approval
```bash
# zero-credit readiness proof first (no provider call is possible on this path)
bin/control-contexttrail live-ready --run-id final \
  --manifest <readiness.json> --image <public image> \
  --mode claim --claim-text "<the claim under test>"

# the production live handler, with the API intercepted and a declared result
bin/control-contexttrail live-handler --run-id final --feature result \
  --manifest <readiness.json> --image <public image> --claim-text "<claim>"
bin/control-contexttrail live-handler --run-id final --feature viewer \
  --manifest <readiness.json> --image <public image> --claim-text "<claim>"

# only then, and only with RUN_LIVE_TESTS=1 plus a --live run:
RUN_LIVE_TESTS=1 bin/control-contexttrail drive result --live --run-id final \
  --image <public image> --live-manifest <readiness.json> --claim-text "<claim>"
RUN_LIVE_TESTS=1 bin/control-contexttrail drive viewer --live --run-id final \
  --image <public image> --live-manifest <readiness.json> --claim-text "<claim>"
```
The manifest must name a public `imageSource`, the image `sha256`/`bytes`, the
mode, the claim and `acknowledgedProviderCredit`. An explicit `--case` is
refused with `--live`; the live path asserts what the harness controls (the
submitted claim selected the mode; no credential material or provider query URL
in the report) and records the observed status as an observation.
Checklist: A5, A6. Tier: LIVE.
**GAP (A5):** A genuine strong Claim conflict, a decisive live Trace, distinct
evidenced reporting origins and a live pair are all still unproved; the retained
`f69ba92` live clips are labelled `REPLAY:f69ba92` and establish nothing about
the candidate. No new real provider budget is requested by this plan.

---

## 3. Red controls to run alongside (all must exit 1)

```bash
viewer  --case pair    --fault pair-note-wrong        # viewer.pair-earlier-note
viewer  --case pair    --fault pair-endpoint-wrong    # viewer.order-starts-at-first-fixture-occurrence
viewer  --case image-load --fault focus-return-broken  # viewer.focus-restored-after-close
result  --case controlled-pair --view timeline --fault drop-timeline-item  # result.timeline-count-matches-fixture
result  --case controlled-pair --view analysis --fault group-mislabel      # result.analysis-reporting-group-*
landing --fault anchor-broken                          # landing.anchor-target*
accessibility --viewport mobile --fault focus-removed # a11y.claim-reachable-by-tab
```
Each must record `faultFired: true`; a fault that reports no mutation is red by
construction. Plus the fixture-contract reds, run separately:
wrong model pin, phantom classified id, identical decoded pixels, and the four
coverage mutants via `fixtures/controls/coverage-mutants.mjs` (new untracked
streams only; `clean` removes them).

## 4. Chapter index and artifacts

Per chapter keep: the drive id, app revision + `BUILD_ID`, runner revision,
runner `cliSha256`, the per-drive `runnerFiles` map, the fixture name +
`sha256` + retained bytes, the submitted input name/bytes/sha256 and claim
`sha256` (never a claim value), `tier`, the label from §1, the assertion verdict
list, `00-`/`01-`/`02-` screenshots, the ARIA snapshot, the uncut `.webm` with
its sha256 and duration, and any `incompleteDrive`/`unclaimedRecordings` entry.
A secret-value scan runs over everything presented. Original recordings are
preserved; a submission cut under three minutes is a **separate** derivative with
its joins disclosed, made only from actual returned core/date/origin evidence.

## 5. Explicitly pending at handover

- Final integrated candidate revision, and A1 (graph authority), A2 (§34 UI
  readability) and A3 (location decision register) closure.
- The four A10 accessibility assertions in chapter 08 and the chapter-03 stalled
  transport measurement.
- Fixture coverage for the A8 states named as GAP in chapter 05.
- A5's genuine strong live milestones; A11 internal reconciliation, A12 other
  browsers, A13 public release. None is claimed by this plan.
