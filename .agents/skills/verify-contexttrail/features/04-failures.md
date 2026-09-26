# Cancellation, partial evidence, and retry

No silent fallback or retry; failure identifies missing work; retry preserves current inputs; new starts blank; cancellation is truthful about already sent requests.

## Sub-features

- failure-visual: both Lens fail, honest fatal outcome
- failure-exact: empty/malformed/unavailable distinct
- failure-enrichment: Search/News/About nonfatal explicit
- failure-page: retain SERP metadata when page fetch fails
- failure-jev: partial/null/all unavailable conservative
- failure-network: HTTP500/413/truncated stream/watchdog
- cancel: stops UI work and retains input
- retry: Return to upload retains image/claim, New clears

## How to get to it (user POV)

Run controlled provider failures through the normal upload path; cancel while Tracing the web is visible; return or start new.

## Driving it with control-contexttrail

Preconditions: doctor passed for the pinned instance. Normal cases are controlled; live cases require the explicit live gate.

control-contexttrail drive session --case cancel|fatal-retry|new|refresh|back --run-id <id>; control-contexttrail drive investigation --mode claim --case <fixture> [--delay-ms <ms>] --run-id <id>. cancel uses a delayed intercept and asserts the cancelled screen plus preserved input after Return to upload; fatal-retry asserts the interrupted alert and preserved claim/image. Assert the precise stage and limitation, retained evidence, preserved input, source-call abort signal and bounded attempted credits.

Observable proof: No silent fallback or retry; failure identifies missing work; retry preserves current inputs; new starts blank; cancellation is truthful about already sent requests.

## Gotchas

Browser cancellation and fatal/return, HTTP errors, partial unconfigured semantics and truncated stream verified at boundaries. Actual upstream cancellation and90s watchdog timing remain NOT VERIFIED. Failure limitation derivation has gaps.

Keep screenshots, ARIA snapshots, action video, sanitized response/events and invariant results with the feature ID. Cleanup closes owned runtime state and preserves evidence. 

