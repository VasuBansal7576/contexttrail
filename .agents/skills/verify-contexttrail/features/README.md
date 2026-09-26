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
  image-load|image-fail|no-excerpt|pair` — `pair` replays `controlled-pair`,
  whose terminal result carries a real `firstObservedContextDivergence` whose
  two endpoints are displayed occurrences; if no fixture has one, the case
  exits 2 naming the missing fixture.
- `session --case refresh|back|new|cancel|fatal-retry`.
- `accessibility --viewport desktop|mobile` — keyboard reachability, overflow
  and 44px targets fail closed; contrast and focus handling are asserted.

Every drive also accepts `--viewport desktop|mobile` and `--no-video`;
`--delay-ms <ms>` exists only on `investigation`, `result` and `viewer` and
withholds the controlled stub's first byte for that long (it is rejected
elsewhere rather than silently ignored);
`--fault` accepts `a11y-false-green|bad-selection|unexpected-request|
anchor-broken|focus-removed|drop-timeline-item|group-mislabel|
pair-endpoint-wrong|pair-note-wrong|focus-return-broken`, and each fault
declares the drive **and case/view** it can sabotage — `drop-timeline-item` needs
`--view timeline`, `group-mislabel` needs `--view analysis`, the pair faults need
`--case pair`. An inapplicable combination exits 2 instead of passing as an inert
fault.

Controlled fixtures shipped: `controlled-trace`, `controlled-claim`,
`controlled-viewer` (per-occurrence loadable thumbnails + a no-snippet item),
`controlled-pair` (four dated core occurrences carrying a real divergence pair,
one never-compared edge and one compared-but-inconclusive edge),
`controlled-insufficient` (provider-validated empties → INSUFFICIENT_EVIDENCE).
`--case` accepts any fixture name present in `fixtures/`; unknown names fail.
`viewer` and `session` cases map to the fixture that actually contains the
evidence under test, and that fixture — with its bytes and hash — is recorded
per drive.

Each fixture is validated on every `npx vitest run` by an always-on contract
suite in `fixtures/gen-fixtures.test.ts`: terminal event, mode/status
coherence, `requestLog.durationMs`, policy/support/identity/date/origin
fields, normalized probability distributions, the exact configured model pin,
event chronology with discovered/classified/published id identity, decodable
and distinguishable retrieved images compared by **decoded pixels** (dimensions
plus a hash of the pixel bytes — two encodings of identical pixels have
different URLs and different bytes), and no real hosts or credential material.
Generation itself is gated behind `CONTEXTTRAIL_GEN_FIXTURES=1`.

`live-ready --run-id <id> --manifest <path> --image <path> [--mode …]` validates
a live input manifest with no browser, no provider request and no credential
read, so live input readiness is provable at zero credit; its record is sealed
with the rest of the evidence and refused after a seal.

`live-handler --run-id <id> --feature result|viewer --manifest <path> --image
<path> [--claim-text <t>] [--declared-result <fixture>]` proves the *handler*:
the production `result`/`viewer` code runs with live semantics while the API
boundary is intercepted and serves a locally declared result. Readiness
manifests alone cannot show that the live path works; this can, at zero credit.

## Negative controls

Red runs are part of the evidence, not an afterthought. Each feature file
lists its own; the standing set is:

- 25 schema/boundary rejections → exit 2 (unknown feature, unknown
  `--entry`/`--case`/`--mode`/`--view`, malformed or out-of-range
  `--delay-ms`, `--delay-ms` on a drive that does not honour it,
  per-command unsupported options, missing flag values,
  `--live` credit gate, `--image`/`--claim-text` without `--live`,
  `--fault` outside the supported set).
- 10 fault injections → exit 1:
  `a11y-false-green` (accessibility), `focus-removed` (accessibility),
  `anchor-broken` (landing), `unexpected-request` (any drive),
  `bad-selection` (result), `drop-timeline-item` (result timeline),
  `group-mislabel` (result analysis — reintroduces the hardcoded
  `Shared group of N occurrences` label that `f69ba92` removed),
  `pair-endpoint-wrong` (viewer pair — renders a wrong evidence id),
  `pair-note-wrong` (viewer pair — rewrites the pair note into a same-context
  claim), `focus-return-broken` (viewer — drops focus to `<body>` on close).
- 3 schema rejections for an out-of-scope fault: `drive landing --fault
  bad-selection`, `drive viewer --case image-load --fault pair-note-wrong` and
  `drive result --view timeline --fault group-mislabel` each exit 2 naming the
  scope the fault needs.
- 2 schema rejections for a fault with an empty target: `drive result --case
  controlled-insufficient --view timeline --fault drop-timeline-item` and the
  same case with `--view analysis --fault group-mislabel` exit 2, because that
  fixture has no timeline occurrence and no reporting group to alter. An inert
  fault can therefore never be reported green — and if one is accepted anyway,
  the page's own mutation count turns the drive red (`fault.sabotage-reported`).
- 8 live-readiness controls (exit 0/1, zero provider calls): valid claim and
  valid trace manifests pass 11 rules; wrong image hash, a loopback
  `imageSource`, a provider URL carrying a key, a claim that disagrees with the
  submitted text, a missing credit acknowledgement, a non-decodable "image", and
  a claim supplied for a trace run each fail the specific rule they break.
- 3 intercepted live-handler controls (exit 0, zero provider calls): the
  production `result` handler and the production `viewer` handler — once against
  a declared result with no occurrences, once against one with evidence — each
  assert zero provider attempts, a redirected submission and an honest tier, and
  never compare against a controlled fixture. They run through the **real**
  `parseDriveOptions`, so the live option allow-list, entry/view defaults and
  input contract under test are the ones a `drive --live` invocation meets.
- 4 live invocation controls on the actual `drive` command (zero provider calls):
  `drive result --live` with **no** `--case` passes the parser and the readiness
  boundary and stops only at the run-state gate; the same invocation with an
  explicit `--case`, without the credit gate, and with a manifest that fails its
  hash rule are each still rejected at their own boundary.

PLANNED / NOT IMPLEMENTED: `rich-context-gaps` / `mixed-evidence` /
`delayed-provider-fixture` fixture names (delay is a `--delay-ms` modifier
instead), and
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
