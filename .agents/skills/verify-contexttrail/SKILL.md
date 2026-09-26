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
snapshot, then starts `npm start -- -p <port> -H 127.0.0.1`. It never builds or
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
  image-load|image-fail|no-excerpt` — opens the evidence dialog from each
  entry point and asserts media load or honest fallback, position
  counter/next/previous, source-link safety (`rel` containing `noopener`),
  technical-details fields, viewport-correct visibility of the image-mode
  group, and focus restoration after Escape. `--case pair` is explicitly
  NOT IMPLEMENTED (exit 2): no controlled fixture emits a paired divergence.
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
focus-removed|drop-timeline-item|group-mislabel` sabotages the page under
test and the drive must exit 1. These prove the assertions are not vacuous;
they are part of the evidence set, and `--fault` is refused with `--live`.

`--delay-ms <ms>` is accepted only by `investigation`, `result` and `viewer`:
it withholds the controlled stub's first byte so the running screen is
observable, and is rejected with exit 2 elsewhere instead of being ignored.

## Evidence

Artifacts land in `<checkout>/.verify/<run-id>/evidence/` — screenshots,
`*.aria.txt` snapshots, browser video, `actions.jsonl` (action → resulting
state with feature ID, entry, case and evidence tier), and
`*-console.json` (page/console errors). Tiers stay distinct: `real-ui`,
`public-contract-boundary`, `live`. `bin/control-contexttrail evidence
--run-id <id>` writes `evidence-manifest.json` listing every artifact with the
revision/build it was captured against. Proof standard: capture the action and
the resulting state; an unreachable path is reported, never silently skipped.

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

## Feature map and live gate

`features/README.md` is the maintained nine-feature map; read it before
driving beyond the basics. Live provider runs need `RUN_LIVE_TESTS=1`,
`--live`, and a configured `.env.local`, run sequentially, and record
attempted/returned/retained counts separately. Boundary fixtures are
test-only: they carry `fixture-*.example.org` domains and `CONTROLLED` titles,
are never wired into production, and are labeled in evidence as
`public-contract-boundary`.

## Helpers

- `fixtures/gen-fixtures.test.ts` has two halves:
  - an **always-on contract suite** that runs on every `npx vitest run` and
    validates every checked-in fixture: terminal `investigation.completed`
    event, mode/status coherence, `requestLog.durationMs`, policy /
    support / identity / date / origin fields with resolvable cross
    references, normalized probability distributions, pinned `jev-*` model
    identity, distinguishable retrieved images, and no real hosts or
    credential material;
  - a **generation block** gated behind `CONTEXTTRAIL_GEN_FIXTURES=1 npx
    vitest run .agents/skills/verify-contexttrail/fixtures/gen-fixtures.test.ts`,
    which re-runs the real orchestrator with controlled provider mocks and
    rewrites the streams. Regenerate after any contract change, then re-run
    the contract suite without the flag.
- `.verify/` is gitignored scratch; evidence inside it survives cleanup by
  design.
- `evidence --run-id <id>` seals the run: after sealing, further `drive`
  calls exit 2 until a new run-id (or `evidence --regenerate`) is used.
