# Sources, Analysis, and technical evidence

A user can see why evidence did or did not qualify, and distinguish retrieval volume from trustworthy media-history coverage.

## Sub-features

- sources-roles:core/lead/context distinctions
- sources-origin:group/shared/unresolved relationship and source actions
- analysis-search:attemptedrequests/actualreturned/retainedcounts
- analysis-policy:qualifyingIDs and satisfied/failed gates
- analysis-coverage:eligible/selected/compared/failures/omissions
- analysis-model:pinned model and inspected bounded scores

## How to get to it (user POV)

Choose Sources or Analysis in the completed report; open a viewer's Technical details.

## Driving it with control-contexttrail

Preconditions: doctor passed for the pinned instance. Normal cases are controlled; live cases require the explicit live gate.

control-contexttrail drive result --case mixed-evidence --view sources|analysis --run-id <id>. Inspect a source row; compare counts, source roles, origin support, policy reasons and comparison coverage with sanitized final/events data.

Observable proof: A user can see why evidence did or did not qualify, and distinguish retrieval volume from trustworthy media-history coverage.

## Gotchas

Current Sources rows omit stated distinctions; Analysis is mostly stages/counts/limits. Missing data must not be treated as a pass simply because the page renders.

Keep screenshots, ARIA snapshots, action video, sanitized response/events and invariant results with the feature ID. Cleanup closes owned runtime state and preserves evidence. 

