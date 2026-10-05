# ContextTrail design QA — 5 October 2026

The UI repair and running-app verification are complete for this pass. All nine chapter surfaces were operated against the unchanged authored HTML. Fresh image and question retrieval completed, saved, and reopened. The earlier pending local allowance is resolved.

## Reference and accepted content

Reference: `/Users/vasu/Desktop/Product HTMLs/ContextTrail.html`, served unchanged on loopback port 3240. App: http://127.0.0.1:3241/, built and served from `/tmp/contexttrail-ui-preview`. The user explicitly selected **real investigation data throughout**. The HTML defines typography, texture, colors, artwork, stage geometry, chapter arrangements and interaction timing. Investigation passages, counts, dates, origin relationships and missing-data states come from actual records.

The 1440 × 900 stage scales as one composition at every width and height, with the authored 106px transport. Exact embedded Instrument Serif/Geist font bytes match the local assets. Their automatic fallback metric adjustment is disabled to match the HTML. The cover photograph crop, supplied star polygon, orbital paths and engraved hand use the authored artwork.

## Browser acceptance

| Chapter | Actual actions and observed result |
| --- | --- |
| Cover | Compared settled app/reference at 1280 × 720; matching title and transport bounds. Opened chooser/About, closed with Escape and restored focus; operated Play/Pause and consecutive keyboard arrows. Cover and saved-case navigation survive reload. |
| Image | Tested URL validation, public-image selection, native replacement, blank/max-length captions. Submitted the public NASA image; actual retrieval completed in 11.083s with 13 candidates, 3 searches, 17 successful Jev requests and 5 source-page reads. Saved and reopened the result. Source viewer uses the paper folio, supports Previous/Next and restores opener focus on Escape. |
| Video | Reopened real Delhi investigation; selected 00:10.500, displaying its retained Jasola-demolition passage. Next lead changed the source and reset internal scroll to zero. Cover/reload retained the media route. Unretained original frame bytes are explicitly unavailable. |
| Questions | Operated actual UPI facets and three-card pagination, including the fourth facet. Submitted a fresh Apollo 8 question; 12 sources, 3 inspected passages, 9 remaining leads. Automatic saving persisted the record. Reopened it, selected the second exact passage, and verified its original URL and character span. |
| Evidence | Selected actual NASA passage, navigated retained records, opened source folios. Long titles/passages scroll inside the paper; dropdown selection follows the correct tab page. Earlier UI-created labelled synthetic table control retained a finding, corrected its cell, and reopened the original historical selection. |
| Sources | Matched authored heading/count/map/detail positions against the rendered HTML. Four cards per page; Next reaches source 13 and disables at the end. Unlinked origins remain unresolved. Worst-case long records and 1,000-source pagination stayed within the viewport. Guided selection changes page at the fifth source. |
| Changes | Restored paired papers. First actual snapshot explicitly marks the earlier snapshot unavailable. Version selectors and long content remain reachable; the labelled correction control retains both actual material versions and the affected finding's review warning. |
| Watch | Verified selected-case question prefill, hourly/daily preferences and whitespace validation. Opened the paused UPI watch, expanded its eight-source baseline, then closed with Escape/focus restoration. Existing retained check is singular. No new scheduled watch or paid check was started. |
| AI answers | Selected retained quotations and opened their original anchored passages. Fresh image case exposes actual page quotes even without a claim report. NASA quote and exact characters 0–168 were verified; month abbreviations stay attached to their sentence. Historical assertions remain bound to their original source after a correction. |

Saving a new investigation now immediately retargets Evidence, Sources, Changes, Watch and Answers to its saved ID. Actual browser verification saved the image while another case was remembered and observed the links change before clicking “Open saved case.” A regression also verifies automatic-save behavior and duplicate prevention.

## Fresh retained investigations

- Image: `5d1b0875-3884-42d0-a5a9-5278dfa06dc7`.
- Question: `research-afec2a13-1ba9-44fc-9b70-ceef89fa46ad`.
- Existing research: UPI `research-657a5bab-2a98-4cb1-86a0-d79013dfbcb0`.
- Existing video: Delhi `research-55069ef5-81db-4f94-95fb-9c129582f445`.

The fresh image honestly reports limited media history; exact-image identity and original publication remain unestablished. Page publication dates are not original-photograph dates. The fresh question honestly reports partial source coverage. No fictional attribution chain, fabricated correction, illustrative video or invented AI conclusion was inserted into these records.

The separately labelled UI control `case:start:20c16105-bb87-491e-88b1-08184263e0f1` is synthetic test evidence, excluded from factual demonstrations. Its historical finding remains bound to the original table cell after correction.

## Responsive and geometry checks

At the observed 1280 × 720 panel, both cover titles are x=116, y=157.2, width=486.4, height=179.5625. Both transports are x=64, y=635.2, width=1152, height=84.8. Final Sources positions also match: heading (117.6,90.4), count (881.6,86.4), map (102.4,251.2), detail (860.8,242.4). Text-dependent heights and real pagination differ from the fictional example.

Final Chrome checks applied actual viewports: 320 × 800 rendered a 320 × 200 stage at (0,300); 2560 × 1440 rendered a 2304 × 1440 stage at (128,0). Neither produced horizontal document overflow. Overrides were reset. Earlier unreliable IAB overrides are recorded as failed attempts, not passes. Actual 200% browser zoom and OS reduced-motion mode were not exercised; reduced-motion and immediate keyboard routing were inspected and tested. Animated collage phases are independent, so pixel identity between arbitrary animation frames is not asserted.

## Providers and validation

Read-only account/model checks authenticated both providers and verified available free usage. The new account's automatically generated key is configured in `.env.local` and `data/private-credentials/provider-keys.env`; both are private, mode 0600 and Git-ignored. Keys were never printed or included in captures.

The existing provider allowance was checked privately. No payment or recharge settings changed. Bounded grants were appended using the existing allowance tool under the user's instruction to complete live acceptance. All historic reservations remain intact. Current local allowance remaining: 6 searches, 1 upload, 76 Jev requests, 324 questions. This is a bounded allowance, not unlimited retrieval.

Final production build, lint/type validity passed. Full suite: **109 files, 1,734 passed, 17 intentional skips**. The suite's synthetic loopback server needed the authorized unsandboxed run; it passed. `git diff --check` passed. Production `/ui-stress` visibly returns 404. Development fixtures are parsed prop-level records and never stored or sent to providers.

The completed build/browser preview uses the isolated directory. Build commands accidentally started in the shared checkout were stopped; no existing app server was stopped. No commit, pull request or deployment was requested.

## Evidence

The [Emil audit](runs/2026-10-05/emil-audit/audit.md) includes the Before/After/Why table and worst-case reproductions. Final artifacts include [cover](runs/2026-10-05/emil-audit/00-cover-production-final.jpg), [unchanged reference cover](runs/2026-10-05/emil-audit/00-cover-reference-final.jpg), [Sources](runs/2026-10-05/emil-audit/05-sources-production-final.jpg), [fresh persisted question](runs/2026-10-05/emil-audit/03-fresh-question-persisted-final.jpg), [source geometry](runs/2026-10-05/emil-audit/source-geometry-final.json), and [remaining allowance](runs/2026-10-05/emil-audit/allowance-final.json).

Screenshots supplement the actual interactions above. Some older captures contain entrance-animation frames; use the final settled captures for comparison. Missing external evidence and unretained bytes are visible data limitations, not pending UI fixes or allowance blockers.

## Owner-reported hover contrast follow-up

The saved-case list had an omitted interaction state: on the Answers chapter, a cream hover background retained cream text. The shared row now uses dark title, number and revision text, a readable muted caption, and a dark keyboard-focus outline. Reproduced and verified in the actual browser for independent hover and keyboard focus. The production preview was rebuilt with this CSS-only repair.

## Public Sites acceptance, 5 October 2026

The isolated hosted Worker test passed 16 checks against actual D1/R2 bindings, including private account isolation, idempotent creation, concurrent revision conflicts, busy/daily/global admission, nonrefundable allocations and readable source extraction. A real Chrome run found the Worker's unsupported `redirect: error` mode; the hosted lease now uses manual redirects and rejects 3xx responses without forwarding credentials. The failed reservation was preserved.

The corrected real question run retained 12 source leads and three inspected page passages. The saved report was reopened from D1/R2 and reloaded, then its NHPR passage, observed publication date, retrieval timestamp and source URL were inspected in the actual UI. This is bounded evidence, not a verified original-publication conclusion. Native video/audio, PDFs and scheduled background watches remain unavailable in the Worker edition; its UI states those limitations. Private credentials, provider-account financial details and unrelated social-account activity are excluded from release source.

A real uploaded NASA/Bill Anders Earthrise image also completed in the hosted Worker. The result reported six confirmed image domains, one observed context and an earliest retrieved dated appearance of 2018-12-21. Those are sample observations, not original-publication claims. The image investigation was saved to the private casebook; original uploaded bytes were excluded. Both topic and image provider flows were exercised through the actual browser.

Two additional isolated Worker checks verified that native-media forms return 503 before provider reservation and question requests above 64 KiB return 413 before parsing. The hosted boundary suite now passes 18 checks. The cover account strip was verified after fresh stylesheet compilation.
