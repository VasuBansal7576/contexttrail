# Media timeline, supporting leads, and context changes

Timeline is an inspectable partial media history, with actual relationships and gaps; supporting material cannot imply a verified image appearance.

## Sub-features

- timeline-core: dated verified occurrences only
- timeline-supporting: separate dated leads/contextual pages
- timeline-unknown: unknown/disputed with visible reasons
- timeline-precision: day/month/year without invented day
- timeline-connectors: same/different/uncertain/not compared
- timeline-sample:allvisible,≤8compared, unresolvedexactcount
- timeline-divergence:laterpoint, twoIDs, earlieruncertainty
- timeline-position: inspect and return preserves location

## How to get to it (user POV)

View evidence timeline CTA, Timeline tab, a conclusion's linked evidence, or viewer return.

## Driving it with control-contexttrail

Preconditions: doctor passed for the pinned instance. Normal cases are controlled; live cases require the explicit live gate.

control-contexttrail drive result --case <fixture> --view timeline --run-id <id>. rich-context-gaps is PLANNED (no such fixture yet — generate it in gen-fixtures.test.ts); use controlled-claim until it lands. Compare every rendered node to core-identity predicates; test unknown/disputed and imprecise dates; open divergence endpoints; inspect a lower row and close. Repeat mobile.

Observable proof: Timeline is an inspectable partial media history, with actual relationships and gaps; supporting material cannot imply a verified image appearance.

## Gotchas

Live noncore nodes contaminate core line. UI ignores connectors and divergence endpoints. Sampled exact segment count fails. Sorting is automatic; no filter/sort controls exist or are required by the PRD.

Keep screenshots, ARIA snapshots, action video, sanitized response/events and invariant results with the feature ID. Cleanup closes owned runtime state and preserves evidence. 

