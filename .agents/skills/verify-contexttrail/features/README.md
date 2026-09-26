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

Implemented drives: `landing`, `upload`, `investigation`, `result` (desktop and
mobile viewports). Drives not yet implemented report `unknown drive feature`
rather than silently passing — treat missing coverage as NOT VERIFIED.

NOT VERIFIED as real-data outcomes: strong Trace with decisive context
divergence; strong CONTEXT_CONFLICT or NO_CONFLICT_FOUND; a complete core dated
timeline; separately evidenced multiple origins; source-image near-match
verification; real provider failure/cancellation accounting; hard 55 s partial
cutoff. NOT VERIFIED as browser paths: clipboard paste; 90 s watchdog;
non-Chromium engines; full screen-reader pass.

Browser-controlled exceptional states do not certify provenance accuracy.
Function-level regressions live in `src/lib/investigation/__tests__/` under
vitest; both layers are required before a finding can be called closed.
