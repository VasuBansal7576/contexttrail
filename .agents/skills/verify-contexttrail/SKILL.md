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

Implemented drives:

- `landing` — loads `/`, captures hero + ARIA snapshot, follows the first
  "Start investigating" CTA, asserts `/investigate` is reached and no
  `/api/investigate` request fired from the landing page.
- `upload` — opens `/investigate` and loads a generated 1x1 PNG through
  `setInputFiles` on the hidden `#ct-image-input` (recorded as
  `entry: "setInputFiles"` in actions.jsonl — this exercises the real
  onChange path but is NOT a native file-chooser/drop/paste interaction;
  those entry points are not yet implemented), captures the selected
  state and submit-button enablement.
- `investigation --mode trace|claim [--case <fixture>]` — submits the upload
  through the normal form. Without `--live`, `POST /api/investigate` is
  intercepted and fulfilled with a controlled public-contract NDJSON stream
  from `fixtures/` (evidence tier `public-contract-boundary` — it proves
  rendering/behavior, never provenance truth). With `--live` the real backend
  and providers run under the credit gate.
- `result [--case <fixture>] [--view overview|timeline|sources|analysis]` —
  runs a controlled claim investigation, then clicks through the four report
  tabs capturing each settled view.

Real selectors are ARIA roles/names: `Start investigating`, `Start
investigation`, the claim textbox, `Overview|Timeline|Sources|Analysis` tabs,
`Inspect evidence`, `Previous|Next evidence`, `Open original source`. Prefer
these over CSS or coordinates.

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

- `fixtures/gen-fixtures.test.ts` regenerates the controlled NDJSON streams
  through the real orchestrator with controlled provider mocks:
  `CONTEXTTRAIL_GEN_FIXTURES=1 npx vitest run .agents/skills/verify-contexttrail/fixtures/gen-fixtures.test.ts`.
  It is skipped in normal `vitest run`.
- `.verify/` is gitignored scratch; evidence inside it survives cleanup by
  design.
