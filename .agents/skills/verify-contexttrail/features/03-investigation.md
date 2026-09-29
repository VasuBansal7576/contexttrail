# Live investigation and progressive evidence

The investigation is *streamed*: stages appear and complete before the
terminal result exists, evidence counters move, and no fabricated percentage
is ever shown.

## Sub-features

- investigation-progressive: stage list is visible and completing while the stream is still open
- investigation-evidence: live candidate/domain counter appears mid-stream
- investigation-terminal: the result tablist only renders after the terminal event
- investigation-boundary: with `--live` absent, no provider call is possible

## Drive command

```
bin/control-contexttrail drive investigation --run-id <id> \
  --mode trace|claim [--case <fixture>] [--delay-ms <ms>]
```

`--mode` is validated before `--case`, because the default case name is
derived from the mode (`controlled-<mode>`). Passing a fixture whose terminal
result carries a different `mode` exits 2 naming the disagreement.

## Assertions (executable contract)

| ID | What it proves |
| --- | --- |
| `stream.plan` (INFO) | how the controlled stream was segmented and where it was held |
| `investigation.progressive-before-terminal` | at the first barrier the Cancel control is present and there are no takeaways yet |
| `investigation.stage-list-present` | `section[aria-label="Investigation stages"]` rendered |
| `investigation.stage-completes-progressively` | ≥1 `li[aria-label*=": Completed"]` at the first barrier |
| `investigation.terminal-absent-at-first-barrier` | `[aria-label="Result views"]` tablist is absent while streaming |
| `investigation.evidence-arrives` | `section[aria-label="Evidence arriving live"]` shows `<n> candidates found` |
| `investigation.stream-still-open` | ≥1 stage still reports `: Running` |
| `investigation.terminal-absent-while-streaming` | tablist still absent at the second barrier |
| `investigation.no-progress-percentage` | the page contains no `%` while streaming |
| `investigation.stage-progress-advances` | completed-stage count is non-decreasing across barriers |
| `result.terminal-surface` | tablist + `aria-label="Investigation result"` overview render |
| `result.status-headline` | status headline matches `STATUS_COPY` for the fixture status |
| `result.fixture-status-agrees` | rendered status matches the fixture's terminal `status`/`mode` |
| `result.mode-is-trace` / `result.status-headline` | trace fixtures have no status; claim fixtures do |
| `stream.request-captured` | `POST /api/investigate` was captured with the expected form fields |
| `boundary.zero-provider-attempts` | no provider request was attempted in a non-live run |
| `boundary.provider-blocked` / `boundary.mode-controlled` | boundary monitor armed and mode recorded |
| `console.no-unexpected-errors` | no unexpected console error |

With `--delay-ms > 0` (or `--live`) the barrier block is skipped: the drive
waits for the cancel control, screenshots progress, then waits for the
terminal result with a live-sized timeout.

## Evidence

`01-investigation-progress.png`, `02-investigation-advanced.png`,
`02-investigation-result.png`, `investigation-result.aria.txt`,
`request-capture.json`, `drive.json` (`tier: public-contract-boundary`
without `--live`, `live: true` with it).

## Negative controls

| Command | Expected |
| --- | --- |
| `drive investigation --run-id <id> --mode invalid` | exit 2, lists `trace\|claim` |
| `drive investigation --run-id <id> --mode claim --case controlled-trace` | exit 2, fixture mode disagreement |
| `drive investigation --run-id <id> --delay-ms abc` | exit 2, integer expected |
| `drive investigation --run-id <id> --delay-ms 99999999` | exit 2, range `0..600000` |
| `drive investigation --run-id <id> --expect-revision X` | exit 2, unsupported option |
| `drive investigation --run-id <id> --fault unexpected-request` | **exit 1** — boundary sees the provider-shaped request |

## Gotchas

- The stream is served by an in-process chunked NDJSON server and the browser
  request is redirected to it. `route.fulfill` cannot stream, so a redirect is
  required; `fixtureFulfilled`/`fixtureEvents` in `drive.json` prove the
  fixture actually reached the page.
- Barriers are predicate-based (evidence discovered, completed stages, stream
  still open). Each barrier's assertions run *before* its segment is released
  so the page is observed at that exact point.
- A controlled fixture proves rendering and behaviour at the public contract
  boundary — never provenance truth. Tier is recorded on every drive.
- The client-side watchdog aborts around 90 s; on a disconnect the harness
  resolves every held barrier rather than deadlocking.

Keep screenshots, ARIA snapshots, action video, sanitized response/events and
invariant results with the feature ID. Cleanup closes owned runtime state and
preserves evidence.
