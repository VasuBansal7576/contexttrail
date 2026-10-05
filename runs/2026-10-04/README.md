# ContextTrail verification, 4 October 2026

Runs used the actual product through Chrome computer use, followed by production-build verification. No agents were delegated. Automatic provider outputs were not replaced with fixtures. Synthetic controls are identified separately.

Initial source baseline: local `main` matched fresh GitHub `origin/main` at `d881a58df26a96b3932725402311353297c293e6`, tree `b1c87a94ce15bce851ac5faf263d21432ee30d92`.

## Actual cases

| Input | Observed outcome |
| --- | --- |
| Why did UPI adoption grow so quickly in India, and what evidence shows how its use changed from 2016 to 2025? | Baseline had 42 unique candidates, eight retained sources and three page passages, with no retained RBI/NPCI page. Final production case `research-c592b691-35ce-4e66-8096-09dcc71e2bd7` had 46 candidates, eight retained sources and four page passages, including RBI publication 23127 and the PIB factsheet. Source read 2 failed; its snippet stayed a lead. |
| Claim: UPI processed more than 24 billion transactions in August 2026. | Retained Times of India page reports 24.51 billion for August. Initial case `research-f5ec3f9b-1ee4-4b37-8c85-9eb78b25cd0c` assessed support. Case `research-b43abdf7-37c2-4115-89a7-d2f2411e6a55` left scope unresolved on a rerun. This model variation is retained, not explained away as a source change. |
| Supplied 60.163-second clip, captioned as the Satya Niketan collapse on 6 September 2026 | Case `research-d5086404-7826-47a3-aaa4-0ef7689e82c8` searched distinct offsets 0, 20.067 and 40.133 seconds. 67 source records include older Jasola demolition reporting. Exact media identity is unresolved; all three caption comparisons are insufficient. Audio and unsampled intervals were not searched. |
| Daily UPI watch | A genuine scheduled first check created case `research-7a2d5f70-0e88-4f33-905b-325cc6acd81a`, with four page passages including a selectable-text PDF. Paused through the UI. Production reopen preserves the baseline and source history. |
| Synthetic correction-history control | Case `case:start:6b290255-6bc8-4f87-b715-5187e30d2e06`, explicitly labelled as UI verification, retains original and corrected classification-context text in source snapshots 2 and 3. No provider calls or factual verdict. Excluded from the launch. |

The RBI URL was selected from the product’s provider results. Reading its source link separately was verification, not a seeded input. Search metadata had only “Annual Report,” without a snippet. The selector now spends one bounded read on a metadata-poor document returned by the investigation, then binds and assesses its real page text.

## Reproduced bugs

- [#53](https://github.com/VasuBansal7576/contexttrail/issues/53): saved automatic research opened into a manual workspace without its reading account. Fixed; real UPI and three-frame reports reopen in production.
- [#54](https://github.com/VasuBansal7576/contexttrail/issues/54): saved cases were reversed in hash-filename order. Fixed with chronological ordering and a real-storage rendering regression; final production UI shows the latest claim first, the correction control second and the earlier RBI investigation third.

[#30](https://github.com/VasuBansal7576/contexttrail/issues/30) remains a broader primary-source research acceptance goal. [#10](https://github.com/VasuBansal7576/contexttrail/issues/10) remains historical-media identity/retrieval acceptance. A successful source read and passing tests do not close either goal.

## Checks and captures

- `tests-final-authorized.log`: 100 files, 1,646 passed, 17 skipped before the final claim-intake/recency repairs.
- `intake-and-recency-tests.log`: four affected UI/account suites, 45 passed, including the two new regressions.
- `tests-complete.log`: final complete suite, 100 files, 1,652 passed and 17 skipped. Includes duplicate-frame spending, partial-frame failure, cancellation and concurrent watch-pause regressions.
- `typecheck-complete.log`: final source and test type checking passed. `audit-complete.json`: zero npm vulnerabilities.
- `typecheck-final.log`, `build-final.log`: final type checking and production compilation.
- `upi-rbi-source.jpg`, `production-rbi-saved.jpg`: real RBI passage, dates and saved report.
- `upi-claim-source.jpg`, `upi-claim-rerun.jpg`: actual news passage and retained rerun uncertainty.
- `video-three-frame.jpg`, `saved-video.jpg`: real video results and reopened saved report.
- `production-watch-phone.jpg`: 390px production viewport; document width also 390px.
- `interactive-launch.jpg`: actual chapter-player/evidence interaction.
- `production-case-recency.jpg`, `production-claim-intake.jpg`, `production-publication-trail.jpg`: final production repair checks.
- `production-watch-phone-final.jpg`, `launch-phone.jpg`: 390px product and launch review views; both document widths equal 390px.

The final explicit “Check a claim” UI run accepted plain text without a protocol prefix and saved `research-ae451005-7eb0-4b03-b86b-6d87c035b041`. It retained three page passages and five leads, but missed the previously retrieved Times of India article and left the claim unresolved. Save/reopen worked. This is evidence of remaining source-coverage variability, not acceptance of consistent claim checking.

Provider authentication and model listing were verified. Account balances, usage, authentication responses and billing records remain local and are excluded from the public repository. No security challenge was bypassed.

The portable launch export is 8,722,681 bytes with zero unresolved local assets. Direct file-URL browser inspection was blocked by the browser's protocol policy. The local review page's H.264 video reached readyState 4, duration 77.013 seconds, and chapter seeking, playback, evidence switching and transcript expansion were verified through computer use. No claim of standalone browser verification is made.

Provider keys remain in an ignored mode-0600 `.env.local`, excluded from Git and screenshots. The existing durable usage ledger retains all previous reservations. Previously authorised finite allowances were used; no quota reset, purchase, account creation or billing change.

The film is a local 1920×1080 H.264/AAC render, 77 seconds. Its source project and verification are in `videos/contexttrail`. The interactive player uses the same product fonts, illustration and palette. Public hosting is not enabled by the local single-host storage/budget boundary.
