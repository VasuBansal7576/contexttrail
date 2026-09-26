# Cancellation, partial evidence, and retry

A user can stop an investigation, is told plainly what happened, keeps what
they typed, and can try again — and an unexpected provider-shaped request is
never allowed to pass silently.

## Sub-features

- failure-cancel: Cancel shows a cancellation screen and returns to the upload with the claim intact
- failure-fatal: an interrupted stream shows a fatal message, then returns to upload with the claim intact
- failure-boundary: any provider-shaped request from the page is counted and fails the drive
- failure-delay: `--delay-ms` makes the stream slow without changing the assertions that must hold

## Drive commands

```
bin/control-contexttrail drive session --run-id <id> --case cancel
bin/control-contexttrail drive session --run-id <id> --case fatal-retry
bin/control-contexttrail drive result --run-id <id> --delay-ms <ms>
bin/control-contexttrail drive result --run-id <id> --fault unexpected-request
```

## Assertions (executable contract)

`--case cancel`:

| ID | What it proves |
| --- | --- |
| `session.cancel-shown` | `investigation cancelled` surface appears after Cancel |
| `session.cancel-preserves-claim` | returning to upload keeps the typed claim |
| `upload.preview-visible` / `upload.preview-matches-file` | the selected image is still selected after returning |
| `boundary.*` / `console.no-unexpected-errors` | nothing escaped the boundary during cancel |

`--case fatal-retry`:

| ID | What it proves |
| --- | --- |
| `session.fatal-shown` | `investigation interrupted` error surface appears |
| `session.fatal-preserves-claim` | the claim survives the failure |
| `upload.preview-visible` / `upload.preview-matches-file` | the image survives the failure |
| `boundary.*` / `console.no-unexpected-errors` | no provider call was made while failing |

`--fault unexpected-request` (any drive):

| ID | What it proves |
| --- | --- |
| `boundary.provider-blocked` | the injected `serpapi.com` fetch was counted and stopped |
| `boundary.zero-provider-attempts` | fails — an attempt was observed |
| `drive.completed` (FAIL) | the run exits nonzero rather than reporting green |

## Evidence

`01-session-cancel.png`, `01-session-fatal.png`, `boundary.json`,
`console.json`, `drive.json` (`outcome`, `failure`, `failureStack`).

## Negative controls

| Command | Expected |
| --- | --- |
| `drive session --run-id <id> --case nope` | exit 2, lists `refresh\|back\|new\|cancel\|fatal-retry` |
| `drive session --run-id <id> --entry x` | exit 2, session declares no `--entry` |
| `drive session --run-id <id> --fault unexpected-request` | **exit 1** with `boundary.providerBlocked: 1` |
| `drive result --run-id <id> --delay-ms abc` | exit 2 |
| `drive result --run-id <id> --delay-ms -1` | exit 2 |

## Gotchas

- Cancel releases the held stream segments *after* the cancellation surface is
  asserted, so the harness never races the UI it is checking.
- The fatal path is driven by an aborted stream, not by a stubbed error
  component — the page must reach the interrupted state through the real
  `useInvestigation` error handling.
- Console errors observed during these runs are classified; only
  `unexpected` ones fail `console.no-unexpected-errors`. Controlled
  `example.invalid` / `fixture-*` image failures and blocked-API noise are
  recognised and recorded instead.

Keep screenshots, ARIA snapshots, action video, sanitized response/events and
invariant results with the feature ID. Cleanup closes owned runtime state and
preserves evidence.
