# ContextTrail verification map

Maintained source for verifying ContextTrail's user-facing behavior. Read this
index before driving the app, then use the matching feature file for the exact
commands, assertion IDs and negative controls. Every drive goes through
`bin/control-contexttrail` on an isolated instance — never against the
interactive `:3100` server.

## Preconditions

- Launch a pinned snapshot: `bin/control-contexttrail launch --checkout <abs>
  --revision <sha> --port 3110 --run-id <id>`; manifest records PID/revision/BUILD_ID.
- Run `doctor` before driving and after any surprising result.
- Normal cases use controlled public-contract NDJSON fixtures intercepted at
  `POST /api/investigate` (tier `public-contract-boundary`); real provider
  calls require `RUN_LIVE_TESTS=1` plus `--live` and spend credit.
- Keep tiers distinct: `real-ui`, `public-contract-boundary`, `live`,
  `function-probe` (vitest), `source/unit`.
- Keep uploads and secret values out of persisted evidence; use generated or
  public inputs.

## Feature index

- [Landing and illustrative example](./01-landing.md) — `drive landing`
- [Image selection and optional claim](./02-input.md) — `drive upload`
- [Live investigation and progressive evidence](./03-investigation.md) — `drive investigation`
- [Cancellation, partial evidence, and retry](./04-failures.md) — `drive session --case cancel|fatal-retry`, `--fault unexpected-request`
- [Trace and claim result overview](./05-overview.md) — `drive result --view overview`
- [Media timeline, supporting leads, and context changes](./06-timeline.md) — `drive result --view timeline`
- [Evidence inspection and comparison](./07-viewer.md) — `drive viewer`
- [Sources, Analysis, and technical evidence](./08-secondary.md) — `drive result --view sources|analysis`
- [Session navigation, responsive layout, and accessibility](./09-session-layout.md) — `drive session`, `drive accessibility`

## Coverage status

Implemented drives: `landing`, `upload`, `investigation`, `result`, `viewer`,
`session`, `accessibility` (desktop and mobile viewports where the map calls
for it). Unsupported features, entries, cases, views and flag combinations are
rejected with exit 2 — they are never silently ignored.

Exit codes are the contract:

| Exit | Meaning |
| --- | --- |
| `0` | every assertion in the drive passed |
| `1` | at least one assertion failed (including an injected `--fault`) |
| `2` | schema/boundary rejection: unknown feature, unsupported or malformed option, missing run, sealed evidence, credit gate |

Supported options per drive (see each feature file for commands and
assertion IDs):

- `landing` — no extra options.
- `upload --entry browse|keyboard|drop|paste|setinputfiles --case
  valid|unsupported|empty|decode|oversize|replace|remove|claim-limit`.
- `investigation --mode trace|claim [--case <fixture>] [--delay-ms <ms>]` —
  case defaults to `controlled-<mode>`; `--live` is accepted.
- `result [--case <fixture>] [--view overview|timeline|sources|analysis]`
  [--live] — every tab is asserted present; the selected panel is compared
  against the fixture's own counts; `--view` ends selected.
- `viewer --entry timeline|sources|takeaway --case
  image-load|image-fail|no-excerpt|pair` — `pair` is explicitly
  NOT IMPLEMENTED (no controlled fixture emits a paired divergence endpoint).
- `session --case refresh|back|new|cancel|fatal-retry`.
- `accessibility --viewport desktop|mobile` — keyboard reachability, overflow
  and 44px targets fail closed; contrast and focus handling are asserted.

Every drive also accepts `--viewport desktop|mobile` and `--no-video`;
`--delay-ms <ms>` exists only on `investigation`, `result` and `viewer` and
withholds the controlled stub's first byte for that long (it is rejected
elsewhere rather than silently ignored);
`--fault` accepts `a11y-false-green|bad-selection|unexpected-request|
anchor-broken|focus-removed|drop-timeline-item|group-mislabel`.

Controlled fixtures shipped: `controlled-trace`, `controlled-claim`,
`controlled-viewer` (loadable data-URI thumbnails + a no-snippet item),
`controlled-insufficient` (provider-validated empties → INSUFFICIENT_EVIDENCE).
`--case` accepts any fixture name present in `fixtures/`; unknown names fail.

Each fixture is validated on every `npx vitest run` by an always-on contract
suite in `fixtures/gen-fixtures.test.ts`: terminal event, mode/status
coherence, `requestLog.durationMs`, policy/support/identity/date/origin
fields, normalized probability distributions, pinned model identity,
distinguishable retrieved images, and no real hosts or credential material.
Generation itself is gated behind `CONTEXTTRAIL_GEN_FIXTURES=1`.

## Negative controls

Red runs are part of the evidence, not an afterthought. Each feature file
lists its own; the standing set is:

- 25 schema/boundary rejections → exit 2 (unknown feature, unknown
  `--entry`/`--case`/`--mode`/`--view`, malformed or out-of-range
  `--delay-ms`, `--delay-ms` on a drive that does not honour it,
  per-command unsupported options, missing flag values,
  `--live` credit gate, `--image`/`--claim-text` without `--live`,
  `--fault` outside the supported set).
- 7 fault injections → exit 1:
  `a11y-false-green` (accessibility), `focus-removed` (accessibility),
  `anchor-broken` (landing), `unexpected-request` (landing/result),
  `bad-selection` (result), `drop-timeline-item` (result timeline),
  `group-mislabel` (result analysis — reintroduces the hardcoded
  `Shared group of N occurrences` label that `f69ba92` removed).

PLANNED / NOT IMPLEMENTED: `pair` viewer case (no fixture emits a paired
divergence), `rich-context-gaps` / `mixed-evidence` / `delayed-provider-fixture`
fixture names (delay is a `--delay-ms` modifier instead), and
`conflict` / `possible` / `no-conflict` as standalone fixture names — those
statuses are produced by `controlled-claim` / `controlled-viewer` /
`controlled-insufficient` and asserted through `result.fixture-status-agrees`.

NOT VERIFIED as real-data outcomes: strong Trace with decisive context
divergence; strong CONTEXT_CONFLICT or NO_CONFLICT_FOUND; a complete core dated
timeline; separately evidenced multiple origins; source-image near-match
verification; real provider failure/cancellation accounting; hard 55 s partial
cutoff. NOT VERIFIED as browser paths: non-Chromium engines; a full
screen-reader pass.

Browser-controlled exceptional states do not certify provenance accuracy.
Function-level regressions live in `src/lib/investigation/__tests__/` under
vitest; both layers are required before a finding can be called closed.
