# Evidence inspection and comparison

Uploaded imagery is never substituted as retrieved evidence; image boundaries are visible; source text/provenance are accurate; return restores context and keyboard focus.

## Sub-features

- viewer-timeline: inspect row
- viewer-source: inspect source-list entry
- viewer-conclusion: open takeaway or divergence pair
- viewer-images:submitted/retrievedcontain and accessible mobiletoggle
- viewer-navigation:previous/next/count/back/Escape
- viewer-provenance:providerbasis, dateprecision/source, originrelationship
- viewer-excerpt:snippet/page attribution, no excerpt, missing image
- viewer-source-link:real original source, newtab, noopener
- viewer-details:actual technical fields only

## How to get to it (user POV)

Inspect evidence from Timeline; Inspect from Sources; View evidence from a takeaway; both divergence endpoints when implemented.

## Driving it with control-contexttrail

Preconditions: doctor passed for the pinned instance. Normal cases are controlled; live cases require the explicit live gate.

control-contexttrail drive viewer --entry <entry> --case image-load|image-fail|no-excerpt|pair --run-id <id>. Wait for actual image load/error, toggle on mobile, navigate both directions, open the original source, inspect technical details, press Escape and check restored focus.

Observable proof: Uploaded imagery is never substituted as retrieved evidence; image boundaries are visible; source text/provenance are accurate; return restores context and keyboard focus.

## Gotchas

Image load/fail, mobile toggles, next/escape/source link tested. No linked-pair entry exists. Excerpt tokens/composite quotes and dropped provenance impair inspection; focus returns to BODY.

Keep screenshots, ARIA snapshots, action video, sanitized response/events and invariant results with the feature ID. Cleanup closes owned runtime state and preserves evidence. 

