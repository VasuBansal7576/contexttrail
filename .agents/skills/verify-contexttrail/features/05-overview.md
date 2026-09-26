# Trace and claim result overview

The headline reflects actual evidence state, metrics preserve unknowns, limitations are visible, and every conclusion opens its supporting occurrence or pair.

## Sub-features

- overview-trace: reconstructed/limited with no verdict
- overview-claim: all four statuses
- overview-caveat: no-conflict mandatory note
- overview-metrics:≤3 actual core-domain/segments/earliest values
- overview-limits: visible unresolved/failed/unverified coverage
- overview-takeaways:≤3 deterministic supported links
- overview-navigation: primary timeline, secondary sources, new

## How to get to it (user POV)

Complete an investigation; use Overview tab from any result view.

## Driving it with control-contexttrail

Preconditions: doctor passed for the pinned instance. Normal cases are controlled; live cases require the explicit live gate.

control-contexttrail drive result --case <fixture> --view overview --run-id <id>. Implemented fixtures: controlled-claim, controlled-trace, controlled-insufficient (INSUFFICIENT_EVIDENCE), controlled-viewer. conflict|possible|no-conflict variants are PLANNED — add generated fixtures in gen-fixtures.test.ts first. The drive asserts all four tabs exist, clicks each, and ends with --view selected. Assert actual backend support IDs and counts against DOM. Open every takeaway's evidence, then return.

Observable proof: The headline reflects actual evidence state, metrics preserve unknowns, limitations are visible, and every conclusion opens its supporting occurrence or pair.

## Gotchas

All status screens tested; only limited Trace and insufficient Claim observed on real data. Strong outcomes remain live-unverified. Unresolved origins and takeaway links are omitted in real results.

Keep screenshots, ARIA snapshots, action video, sanitized response/events and invariant results with the feature ID. Cleanup closes owned runtime state and preserves evidence. 

