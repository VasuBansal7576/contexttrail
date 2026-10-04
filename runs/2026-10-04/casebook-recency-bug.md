The saved-case list reverses the filesystem's hash-name order, so it is not ordered by creation time. This makes a freshly saved investigation harder to find among repeated questions.

Observed in the real production UI on 4 October 2026:

1. Save several automatic investigations.
2. Open `/casebook`.
3. The first entry is the earlier UPI watch case `research-7a2d5f70-0e88-4f33-905b-325cc6acd81a`.
4. The most recent UPI case `research-c592b691-35ce-4e66-8096-09dcc71e2bd7`, created at 07:08:43 UTC, is entry 08.

Expected: order investigations by retained creation time, with a stable tie-breaker. The list should not imply recency from hash filenames.

Before screenshot: `runs/2026-10-04/casebook-before-recency.jpg`. A regression test creates cases with different dates and verifies the actual rendered first link. Production verification will follow the fix.
