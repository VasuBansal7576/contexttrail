---
name: verify-contexttrail
description: "Drive the real ContextTrail app the way a user does and prove behavior — isolated launch/doctor/drive/evidence/cleanup via the control-contexttrail CLI plus a nine-feature map. Use for browser verification, UI regressions, stream-contract checks, and pre-release evidence. Normal runs spend zero provider credit."
---

# Verify ContextTrail

Scripted proof for ContextTrail (`contexttrail` Next.js app). A user uploads an
image (optionally with a claim), watches a streamed investigation, and inspects
a result: overview, timeline, sources, analysis, and an evidence viewer. This
skill launches an isolated production build, drives it with Playwright through
real UI selectors, captures artifacts, and tears down only what it created.

## Launch

```
bin/control-contexttrail launch \
  --checkout <absolute-path-to-checkout> \
  --revision <sha|HEAD> \
  --port 3110 \
  --run-id <id>
```

Launch snapshots the pinned revision (`git archive` into
`<checkout>/.verify/<run-id>/checkout`), runs `npm ci` + `npm run build` in the
snapshot, then starts `npm start -- -p <port> -H 127.0.0.1`.

The three child environments are deliberately different, because a production
`NODE_ENV` during install silently drops the TypeScript/build toolchain and the
build that follows cannot run:

| step | environment | dependency set |
| --- | --- | --- |
| install | no `NODE_ENV` at all, plus explicit `npm ci --include=dev` | dev dependencies present |
| build | `NODE_ENV=production` | as installed |
| runtime | `NODE_ENV=production` | as installed |

npm configuration that changes dependency *resolution* (`npm_config_include`,
`_omit`, `_only`, `_production`, `_dev`, `_ignore_scripts`, the peer-dep flags)
is dropped from every child environment instead of being inherited, so the
dependency set is a property of the command and not of the caller's shell. A
launch that finds the toolchain missing after install fails immediately and
says so, and `doctor` re-checks it in the running snapshot. Credential
stripping is unchanged and applies to all three. It never builds or
runs dev against a live server's `.next`, and never against the interactive
`:3100` instance. The run manifest (`.verify/<run-id>/manifest.json`) records
the owned PID, port, source SHA, lockfile SHA, Next BUILD_ID, browser-visible
URL and timestamps. Wait for `{"launched": true}` on stdout.

`--live` additionally symlinks `.env.local` into the snapshot for real provider
runs. It requires `RUN_LIVE_TESTS=1` and refuses otherwise. Never copy secret
values into evidence, logs, or commits.

## Doctor

```
bin/control-contexttrail doctor --run-id <id> [--expect-revision <sha>]
```

Read-only health check: the manifest PID is alive *and* its recorded
signature still matches (PID-reuse guard), the expected port is bound by
that process or one of its descendants, landing returns 200 and contains
the app identity, the referenced stylesheet returns 200, the build id
served in the page matches the manifest's, revision matches, and
env-file presence as a boolean. Run resolution does not need `--checkout`:
it falls back through `CONTEXTTRAIL_CHECKOUT`, the CLI's own repo root,
then cwd. Exit 1 on any failure — run doctor before driving and after
any surprising result; it never consumes provider credit.

## Drive

```
bin/control-contexttrail drive <feature> --run-id <id> [--viewport desktop|mobile]
```

Implemented drives (seven):

- `landing` — loads `/`, asserts 200/title/four `Start investigating` CTAs,
  follows each CTA to `/investigate`, asserts `#how-it-works`, `#example` and
  `#about` resolve (scroll check on desktop), and proves no
  `/api/investigate` request fired from the landing page.
- `upload --entry browse|keyboard|drop|paste|setinputfiles --case
  valid|unsupported|empty|decode|oversize|replace|remove|claim-limit` —
  opens `/investigate` and delivers a generated PNG through the requested
  entry point. `browse` and `keyboard` drive a real file chooser, `drop` and
  `paste` dispatch synthesised events carrying real bytes through a
  `DataTransfer`, `setinputfiles` sets the input directly; the method used is
  recorded as `upload.entry-method` (INFO) so none of them is mistaken for a
  human gesture. Asserts preview, submit enablement, each rejection path and
  the 500-character claim cap.
- `investigation --mode trace|claim [--case <fixture>] [--delay-ms <ms>]` —
  submits the upload through the normal form. Without `--live`,
  `POST /api/investigate` is redirected to an in-process chunked NDJSON
  server serving `fixtures/` (evidence tier `public-contract-boundary` — it
  proves rendering/behavior, never provenance truth), and barriers hold the
  stream so progressive state can be asserted before the terminal result
  exists. With `--live` the real backend and providers run under the credit
  gate.
- `result [--case <fixture>] [--view overview|timeline|sources|analysis]` —
  runs a controlled investigation, clicks through all four report tabs
  asserting `aria-selected`, then compares the selected panel against the
  fixture's own counts (takeaways, timeline occurrences, source rows) and
  fails on any placeholder token (`undefined`/`null`/`NaN`/`Invalid Date`).
- `viewer --entry timeline|sources|takeaway --case
  image-load|image-fail|no-excerpt|pair
  [--focus-fallback hidden|disabled|disconnected|tabindex-negative]` — opens
  the evidence dialog from each entry point and asserts media load or honest
  fallback, position counter/next/previous, source-link safety (`rel`
  containing `noopener`), fixture-row attribution (the rendered occurrence
  identity line — `Occurrence ID:` at the accepted pin — resolves to a real
  fixture row, the source link and title are that row's
  own, the excerpt is a strict prefix of its own excerpt), technical-details
  **values** against the fixture's own row, viewport-correct visibility of the
  image-mode group, and keyed focus restoration after Escape — including after
  the `Technical details` disclosure was used.
  - Focus is proven from a per-frame `document.activeElement` sample log
    installed before navigation: every element that takes focus carries a
    recorded `data-ctfk` key, the dialog-close marker is the frame the log
    actually recorded the dialog leaving the DOM, and the settle requires the
    final consecutive run of ≥3 frames to carry the expected element's key in
    every sample. `--focus-fallback <kind>` mutates the keyed opener into the
    named un-restorable state while the dialog is open and expects focus on the
    selected tab's key; it cannot combine with `--fault` (exit 2).
  - `--case image-load` additionally attributes the rendered pixels: the
    `src` must equal the image the **fixture** shipped for that occurrence,
    must differ from the submitted image's `src`, and the image must pass the
    visible-image predicate — complete, decoded, non-transparent, rendered, in
    viewport, hidden by no ancestor, with no running animation at rest. Media
    state is read with a bounded, non-waiting DOM read.
  - `--case pair` replays `controlled-pair` and asserts a real paired
    divergence: both endpoints exist and are adjacent, the rendered navigation
    order equals the fixture's flat viewer order, each side shows its own id
    and note, the pair control is keyboard-reachable and activates with Enter,
    and ordinary Next outside the pair clears both the note and the control.
- `accessibility` also maintains the measurements that decide acceptance:
  composited contrast per visible text node (background resolved by climbing
  ancestors, 4.5:1 normal / 3:1 large — no stored constants), keyboard-visible
  focus compared with the same element unfocused, the full result-tablist
  keyboard pattern (ArrowRight ×2, Home, End, ArrowLeft) including the roving
  tabindex and the matching visible panel, a zero running-animation count on
  the settled screen, and a real interactive-control sweep where enabled
  controls under the 44px floor are recorded as secondary inconsistencies —
  and reduced motion emulated with settled content and a 44px primary target.
  `result` runs the tablist pattern, its contrast pass, the selected-panel
  contrast pass and (on mobile) the long-title wrap/clip check on the result
  surface.
- `session --case refresh|back|new|cancel|fatal-retry` — refresh restore
  offer / restore / discard, browser Back, New investigation, cancellation and
  fatal-interruption surfaces, including that the claim and image survive and
  that no image bytes reach sessionStorage.
- `accessibility --viewport desktop|mobile` — keyboard tab-order walk,
  DOM scan for controls hidden from the tab order, focus-ring visibility,
  horizontal-overflow, 44px target floor and WCAG AA heading contrast.

Real selectors are ARIA roles/names: `Start investigating`, `Start
investigation`, the claim textbox, `Overview|Timeline|Sources|Analysis` tabs,
`Inspect evidence`, `Previous|Next evidence`, `Open original source`,
`Restore previous result`, `View last result`, `Discard`. Prefer these over
CSS or coordinates.

### Exit codes

- `0` — every assertion passed.
- `1` — at least one assertion failed, including an injected `--fault`.
- `2` — schema/boundary rejection: unknown feature, unsupported or malformed
  option, missing/ sealed run, `--live` credit gate.

### Fault injection (red runs)

`--fault a11y-false-green|bad-selection|unexpected-request|anchor-broken|
focus-removed|drop-timeline-item|group-mislabel|pair-endpoint-wrong|
pair-note-wrong|focus-return-broken` sabotages the page under test and the
drive must exit 1. These prove the assertions are not vacuous; they are part of
the evidence set, and `--fault` is refused with `--live`.

Each fault declares which drive **and which case/view of it** it can actually
sabotage. A fault outside that scope exits 2 naming the scope it needs: an
accepted fault that cannot fire is a false green. Feature-level scope alone is
not enough — `drop-timeline-item` fires against the Timeline panel and
`group-mislabel` only has an assertion in the Analysis branch, so both are inert
on the wrong `--view`, and the pair faults have no pair note to rewrite outside
`--case pair`.

Beyond scope, two more guards keep a fault from ever being green by accident:

- **knowable empty target** — refused before any side effect. A timeline fault
  needs a fixture with timeline occurrences, a group-label fault needs reporting
  groups, the pair faults need a real paired divergence.
- **self-report** — every fault branch counts the mutations it actually
  performed. The drive reads that count before the browser closes, records
  `fault.sabotage-reported`, and turns the run red if it is zero. The verdict is
  persisted as `faultFired` in `drive.json` and in the seal, so an inert fault is
  distinguishable from a firing one in the evidence itself. The recorder stays
  open until this and every other post-case assertion have been pushed, then
  flushes before the totals are read — `drive.json`'s assertion counts and the
  durable `assertions.jsonl` can never diverge (a push after close throws), and
  the seal fails non-zero if a drive's recorded totals disagree with its file.

| fault | applies to |
| --- | --- |
| `a11y-false-green`, `focus-removed`, `focus-ring-hidden` | `accessibility` |
| `contrast-lowered` | `accessibility`, `result` |
| `tab-map-broken` | `result` |
| `anchor-broken` | `landing` |
| `bad-selection` | `result` (any view) |
| `drop-timeline-item` | `result --view timeline` |
| `group-mislabel` | `result --view analysis` |
| `pair-endpoint-wrong`, `pair-note-wrong` | `viewer --case pair` |
| `focus-return-broken` | `viewer` (any case) |
| `unexpected-request` | any drive |

`--delay-ms <ms>` is accepted only by `investigation`, `result` and `viewer`:
it withholds the controlled stub's first byte so the running screen is
observable, and is rejected with exit 2 elsewhere instead of being ignored.

## Evidence

Artifacts land in `<checkout>/.verify/<run-id>/evidence/drives/<nnn>-<slug>/` —
screenshots, `*.aria.txt` snapshots, `fixture-<name>.ndjson`, `video/*.webm`,
`assertions.jsonl`, `console.json`, `boundary.json`, `request-capture.json` and
`drive.json`. Tiers stay distinct: `real-ui`, `public-contract-boundary`,
`live`. `bin/control-contexttrail evidence --run-id <id>` writes
`evidence-manifest.json` listing every artifact with its sha256 plus both
revisions. Proof standard: capture the action and the resulting state; an
unreachable path is reported, never silently skipped.

Provenance is per drive, not per run:

- `drive.json` records the app revision/BUILD_ID, the runner revision, the
  runner's `runnerFiles` hash map **as read by that drive** (generator, feature
  maps and SKILL included — a seal-time file list cannot describe what an
  earlier drive read), the CLI sha256, the **exact** command and options, the
  replayed `fixture` with its `fixtureSha256`/`fixtureBytes`, the resolved
  `input` (image name, bytes, sha256, declared public source, claim presence and
  claim sha256 — never a claim value), the `--live-manifest` sha256, and the
  collected videos with their own hashes. The in-progress record carries the same
  provenance.
- The exact fixture bytes are copied into the drive directory, so a mid-run
  regeneration cannot re-attribute a drive to different bytes. `evidence`
  re-hashes that retained copy and reports `fixtureBytesIntact`.
- Video is the browser's own uncut recording. It is finalized asynchronously
  after the context closes, so it is snapshotted before the drive and copied
  into the drive directory afterwards, hashed, and indexed. `cleanup` removes
  only the generation-level staging directory and prints how many recordings
  survive inside evidence.
- A recording left in staging by a hard-interrupted attempt belongs to no drive
  record. Listing its hash is not preserving it, so the seal **copies it into
  `evidence/orphan-video/`** with a sidecar that labels it `INCOMPLETE` and says
  in plain words that it is not completed proof. It is hashed like every other
  artifact and survives cleanup.
- A drive writes an `outcome: "INCOMPLETE"` record the moment its directory
  exists, and finalizes it on completion. `SIGINT`/`SIGTERM` are handled rather
  than ignored: the browser is closed (which flushes the recording encoder), the
  partial recording is collected into the drive's own evidence, the record is
  written as INCOMPLETE with `interruptedBy` and **no pass verdict**, and the
  run exits 1. An interrupted attempt therefore hands back real bytes and claims
  nothing it did not finish. `evidence` lists unfinished attempts
  (`incompleteDrives`) and any recording that belongs to no finalized drive
  (`unclaimedRecordings`) instead of counting only what succeeded.
- A `stream-ownership` drive writes `ownership-plan.json` **before any effect**
  (the streams it plans to serve and the retained files it plans to keep), then
  persists its observed records through a failure-safe finalizer:
  `delivery-ledger.json` (every request the transport actually saw),
  `request-inputs.json` (each PLANNED request projected against observation —
  a request never sent is `UNOBSERVED` with null fields, never fabricated), and
  `retained-streams.json` (per-request integrity of the retained source bytes).
  These are written even when an assertion aborts the case, with
  `finalizedUnder` naming the exit that produced them. `evidence` expects every
  stream the plan declared — sourced from the plan, not the end ledger — and a
  missing plan, missing ledger, divergence between them, or a lost/corrupted
  retained file fails the seal non-zero.
- The drive record itself is fail-closed (`driveOutcomeOk`): PASS requires a
  complete record with integer pass/fail/info totals, zero failed assertions
  and a positive assertion count. `evidence` records a `recordVerdict` per
  drive, and a drive that CLAIMS `outcome: "PASS"` on a malformed record
  (`malformedPassRecords`) fails the seal non-zero.

## Live input contract

A live run submits the operator's own input, never a generated fixture, and
names it in a readiness manifest:

```
bin/control-contexttrail live-ready --run-id <id> \
  --manifest <readiness.json> --image <public image> \
  [--mode trace|claim --claim-text "<text>"]
```

The manifest declares `schema`, a public `imageSource` (an `http(s)` URL that is
not a provider endpoint), `imageSha256`, `imageBytes`, `mode`, `claim` and
`acknowledgedProviderCredit`. `live-ready` validates that contract with **no
browser, no provider request and no credential read**, so live readiness is
provable at zero credit; its record is kept in `evidence/readiness/` and
counted in the seal. `drive --live` requires the same manifest and refuses
before any side effect when a rule fails. A live drive asserts only what the
harness controls — that the submitted claim is what selected the mode, and that
the report carries no credential material or provider query URL; the observed
status is recorded as an observation, never compared with a fixture.

`--delay-ms`, `--fault` and an **explicitly supplied** `--case` are refused with
`--live`. A case the caller did not supply is not a case: the parser injects
fixture defaults for controlled runs, and `drive result --live` with no `--case`
is a legitimate live invocation that must pass the parser and the readiness
boundary on its way to the run-state gate.

**Proving the live handler, not just the helper.** A manifest that validates
says nothing about whether the live *handler* works — that is what the C2
review demonstrated. `live-handler` runs the production `result`/`viewer`
handler with live semantics while the API boundary is intercepted and serves a
**locally declared** result:

```
bin/control-contexttrail live-handler --run-id <id> \
  --feature result|viewer --manifest <readiness.json> --image <public image> \
  [--claim-text <text>] [--declared-result <fixture>]
```

The handler code is unmodified and asserts only the response it receives:
`result` records the observed takeaways/metrics/timeline/sources/analysis values
instead of comparing them with a controlled fixture, and `viewer` takes its
observed media/pair/technical-detail paths. It asserts zero provider attempts, a
redirected submission and an honest tier label
(`handler: production live path · result: locally declared, NOT provider truth`).
It is exempt from the credit gate by construction — its boundary blocks every
provider-shaped request — and it is refused after a seal.

## Cleanup

```
bin/control-contexttrail cleanup --run-id <id>
```

Refuses to signal anything unless the manifest PID's recorded signature
still matches (PID-reuse guard). Terminates the owned process *tree* —
descendants first, then the npm parent — and waits for the port to be
released, exiting nonzero if it is not. Removes the snapshot checkout and
scratch state — never kills by process name, never touches the
interactive `:3100` server or sibling worktrees. Evidence, logs, and the
manifest are preserved; the command prints surviving artifact counts.
Run cleanup after every failed iteration too.

## Final acceptance run

`FINAL-RUN-PLAN.md` is the concrete nine-feature execution and recording plan
for a final accepted candidate: the real command for every chapter, the
assertion IDs each one produces, the CONTROLLED / LIVE / REPLAY labelling rule,
the red controls to run alongside, and — explicitly — the behaviours that have no
command today and are marked GAP rather than quietly assumed. It is preparation
only: the runner is ready, the candidate is not.

## Feature map and live gate

`features/README.md` is the maintained nine-feature map; read it before
driving beyond the basics. Live provider runs need `RUN_LIVE_TESTS=1`,
`--live`, and a configured `.env.local`, run sequentially, and record
attempted/returned/retained counts separately. Boundary fixtures are
test-only: they carry `fixture-*.example.org` domains and `CONTROLLED` titles,
are never wired into production, and are labeled in evidence as
`public-contract-boundary`.

### A8 expected-case map and recipe bindings

`fixtures/a8-expected-case-map.json` is the accepted A8 expected-case map,
imported byte-exact and sha256-pinned (`6721d89b…`); a drifted file fails the
drive closed at load. `fixtures/a8-expected-case-map.CONSUMER-NOTES.md`
carries the independent-review qualifications that govern how the map is read
(superseded counts/locator scope — read it before touching the map consumer).

`fixtures/a8-recipe-bindings.json` binds the map's 17 recipe templates —
`runnerPin`/`acceptedCommandArgs`/`caseId`/`caseImport` were UNBOUND at seal
time — to this CLI's real command surface: per case, `a8-<fixture>` case IDs,
the actual `drive result|viewer` argvs (including the case's pinned
`--claim-text` for claim_check entries), the received fixture sha256 (equal to
the map's declared `streamSha256`), and an immutable `recipeDigest` over the
whole bound table. Regenerate after contract changes with
`A8_BINDINGS_EMIT=1 node fixtures/controls/a8-map-bindings.mjs >
fixtures/a8-recipe-bindings.json` — the offline control proves the committed
file regenerates identically and that any bound-field mutation changes the
digest.

Whenever a `drive result --case <a8-fixture>` or `drive viewer --entry
timeline --case <a8-fixture>` invocation runs, the drive discharges every map
record bound to that view as its own `a8.expect.<record-id>` assertion — the
147 records (141 visible + 6 serialized-only) are distinct observations, never
one aggregate count, and `null` expectations are explicit absent/unknown
predicates (`Unresolved`, empty sections), never skips. Identity is proven by
the opened dialog's `Occurrence ID:` line (inside Technical details, read via
textContent): gate "View supporting evidence →"
links, reporting-group members, unresolved candidates, performed-comparison
endpoints, divergence-note endpoints and dated-timeline Inspect controls are
each clicked and the opened ID compared with the expected one. The serialized
caveat flag is asserted on the consumed terminal payload, never on rendered
text; the visible caveat renders only for `NO_CONFLICT_FOUND` and is checked
as a rendered paragraph. Native execution of the 17 recipes is a later,
separately-authorized stage — the bindings assert readiness, not rendered
proof.

## Helpers

- `fixtures/gen-fixtures.test.ts` has two halves:
  - an **always-on contract suite** that runs on every `npx vitest run` and
    validates every checked-in fixture: terminal `investigation.completed`
    event, mode/status coherence, `requestLog.durationMs`, policy /
    support / identity / date / origin fields with resolvable cross
    references, normalized probability distributions, the **exact** configured
    model pin (not any `jev-*` lookalike), event chronology with discovered /
    classified / published id identity in both directions, and distinguishable
    decodable retrieved images compared by **decoded pixels** — dimensions plus a
    hash of the pixel bytes, because two encodings of the same pixels have
    different URLs and different bytes while rendering identically (data URIs
    included, since identical 1×1 pixels make attribution unrecoverable) — plus
    no real hosts or credential material.
    Nullable unknown fields stay valid; a re-classification is only allowed
    during `REFINED_CLASSIFY`, and the terminal `COMPLETE` stage is the single
    stage allowed to complete without a start;
  - a **generation block** gated behind `CONTEXTTRAIL_GEN_FIXTURES=1 npx
    vitest run .agents/skills/verify-contexttrail/fixtures/gen-fixtures.test.ts`,
    which re-runs the real orchestrator with controlled provider mocks and
    rewrites the streams. Regenerate after any contract change, then re-run
    the contract suite without the flag.
- `fixtures/controls/*.mjs` are the offline predicate controls. Each imports
  the REAL exported predicates from `cli/control-contexttrail.mjs` — never a
  copy that can drift — and runs positive plus opposing isolated negatives with
  no browser, server or provider: `focus-settle.mjs` (keyed settle, close
  marker, dwell, descriptor-only weakness, the four invalid-opener fallbacks,
  fail-closed drive records), `contrast-panel.mjs` (aria-controls panel scope,
  AA thresholds, UNSUPPORTED as a non-pass despite diagnostic ratios),
  `media-predicates.mjs` (visible image, wrap/clipping, interactive targets,
  at-rest motion), `stream-buffer-provenance.mjs`, `request-projection.mjs`,
  `retained-integrity.mjs`, `reading-order-target.mjs`,
  `assertions-durable.mjs` and `a8-map-bindings.mjs` (the map digest gate, all
  17 recipe bindings vs the real spec table, digest stability, and every
  expected-record verdict red/green pair). Run them after any predicate
  change; they exit non-zero on the first unexpected verdict.
- The selected-panel contrast pass (`result.<view>-contrast-*`) measures named
  content nodes strictly inside the selected tab's own `aria-controls` panel:
  membership is asserted per node, canvas resolves whatever color format the
  browser reports (including `oklab`/`oklch`), own opacity and the ancestor
  opacity product enter the effective foreground alpha, and every
  group-forming ancestor with `opacity < 1` is verdict `UNSUPPORTED` — a
  non-pass whose diagnostic `contrastRatio` is never an accepted number.
  These predicates prove behavior on the controlled fixtures; they do not
  establish global accessibility coverage or release acceptance.
- `.verify/` is gitignored scratch; evidence inside it survives cleanup by
  design.
- `evidence --run-id <id>` seals the run: after sealing, further `drive`
  calls exit 2 until a new run-id (or `evidence --regenerate`) is used.
- Every command validates its own flags and positional arity **before** any
  side effect, so `evidence --nonsense 1`, `cleanup --nonsense 1` and
  `doctor extra-positional` exit 2 instead of doing their work.
