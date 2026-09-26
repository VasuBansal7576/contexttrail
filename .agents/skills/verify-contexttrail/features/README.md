# ContextTrail verification map

Maintained source for verifying ContextTrail's user-facing behavior. Read this
index before driving the app, then use the matching feature file as the recipe.
Every drive goes through `bin/control-contexttrail` on an isolated instance —
never against the interactive `:3100` server.

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

- [Landing and illustrative example](./01-landing.md)
- [Image selection and optional claim](./02-input.md)
- [Live investigation and progressive evidence](./03-investigation.md)
- [Cancellation, partial evidence, and retry](./04-failures.md)
- [Trace and claim result overview](./05-overview.md)
- [Media timeline, supporting leads, and context changes](./06-timeline.md)
- [Evidence inspection and comparison](./07-viewer.md)
- [Sources, Analysis, and technical evidence](./08-secondary.md)
- [Session navigation, responsive layout, and accessibility](./09-session-layout.md)

## Coverage status

Implemented drives: `landing`, `upload`, `investigation`, `result`, `viewer`,
`session`, `accessibility` (desktop and mobile viewports where the map calls
for it). Unsupported features, entries, cases, views and flag combinations are
rejected with a nonzero exit — they are never silently ignored.

Supported options per drive (see each feature file for recipes):

- `landing` — no extra options.
- `upload --entry browse|keyboard|drop|paste|setinputfiles --case
  valid|unsupported|empty|decode|oversize|replace|remove|claim-limit`.
- `investigation --mode trace|claim [--case <fixture>] [--delay-ms <ms>]` —
  case defaults to `controlled-<mode>`; `--live` is accepted.
- `result [--case <fixture>] [--view overview|timeline|sources|analysis]`
  [--live] — every tab is asserted present; `--view` ends selected.
- `viewer --entry timeline|sources|takeaway --case
  image-load|image-fail|no-excerpt|pair` — `pair` is explicitly
  NOT IMPLEMENTED (no linked-pair entry exists in the product).
- `session --case refresh|back|new|cancel|fatal-retry`.
- `accessibility --viewport desktop|mobile` — keyboard reachability, overflow
  and 44px targets fail closed; contrast/focus-restore are recorded.

Controlled fixtures shipped: `controlled-trace`, `controlled-claim`,
`controlled-viewer` (loadable data-URI thumbnails + a no-snippet item),
`controlled-insufficient` (provider-validated empties → INSUFFICIENT_EVIDENCE).
`--case` accepts any fixture name present in `fixtures/`; unknown names fail.

PLANNED / NOT IMPLEMENTED cases from the recipes: `rich-context-gaps`,
`mixed-evidence`, `delayed-provider-fixture` as fixture names (delay is now a
`--delay-ms` modifier instead), `conflict`, `possible`, `no-conflict` result
variants — these need new generated fixtures in `gen-fixtures.test.ts` before
they can run.

NOT VERIFIED as real-data outcomes: strong Trace with decisive context
divergence; strong CONTEXT_CONFLICT or NO_CONFLICT_FOUND; a complete core dated
timeline; separately evidenced multiple origins; source-image near-match
verification; real provider failure/cancellation accounting; hard 55 s partial
cutoff. NOT VERIFIED as browser paths: 90 s watchdog; non-Chromium engines;
full screen-reader pass.

Browser-controlled exceptional states do not certify provenance accuracy.
Function-level regressions live in `src/lib/investigation/__tests__/` under
vitest; both layers are required before a finding can be called closed.
