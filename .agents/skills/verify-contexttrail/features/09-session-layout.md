# Session navigation, responsive layout, and accessibility

Every essential action is usable without pointer/hover; focus remains visible and meaningful; result appears before long input on mobile; refresh behavior matches disclosed persistence; uploaded media is not stored.

## Sub-features

- session-refresh:completedresult behavior explicit, no imagepersistence
- session-back:browserback, in-appreturn, newinvestigation
- layout-desktop:1440x900composition
- layout-mobile:390pxreadingorder, nooverflow,44pxtargets
- a11y-keyboard:visiblefocus, tab pattern, modaltrap/return
- a11y-contrast:AAactualcolors
- a11y-motion:reduced motion
- browsers:Chrome/Edge/Safari/Firefox

## How to get to it (user POV)

All screens; refresh completed/active investigation; browser Back; keyboard-only walkthrough; mobile viewport.

## Driving it with control-contexttrail

Preconditions: doctor passed for the pinned instance. Normal cases are controlled; live cases require the explicit live gate.

control-contexttrail drive accessibility --viewport desktop|mobile --run-id <id>; control-contexttrail drive session --case refresh|back|new|cancel|fatal-retry --run-id <id>. Keyboard reachability, horizontal overflow and 44px targets fail closed; contrast/focus-restore/sessionStorage keys are recorded into accessibility-<viewport>.json without image bytes. session refresh records whether the result persisted honestly.

Observable proof: Every essential action is usable without pointer/hover; focus remains visible and meaningful; result appears before long input on mobile; refresh behavior matches disclosed persistence; uploaded media is not stored.

## Gotchas

Chrome desktop/mobile viewport and reduced motion checked. Focus/contrast/order fail; completed cache unused. Other engine/device and full screen-reader passes NOT VERIFIED.

Keep screenshots, ARIA snapshots, action video, sanitized response/events and invariant results with the feature ID. Cleanup closes owned runtime state and preserves evidence. 

