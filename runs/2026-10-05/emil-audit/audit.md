# ContextTrail UI repair and browser audit — 5 October 2026

The app was run and operated with computer use against the unchanged authored `/Users/vasu/Desktop/Product HTMLs/ContextTrail.html`. Production preview: http://127.0.0.1:3241/. Reference: port 3240. Development fixtures: http://127.0.0.1:3242/ui-stress. The completed production build uses `/tmp/contexttrail-ui-preview`.

Skills applied: `emil-design-eng`, `break-ui`, `review-animations`, and the read-only audit workflow from `improve-animations`. The HTML supplies the visual design; these skills guide verification and polish rather than replacing that design.

## Changes

| Before | After | Why |
| --- | --- | --- |
| Saved-case hover changed the background to cream but retained cream title, number, revision and caption | Hover and keyboard focus set dark ink, muted caption and a dark focus outline | Makes the complete row readable on the paper highlight in every chapter theme |
| Cover absolute artwork escaped the layout in the split panel; fallback font metrics changed labels and arrow width | The authored 1440×900 stage scales together; exact local font bytes use the reference fallback behavior | Restores the cover composition and text metrics |
| Four research facets squeezed into a three-card reference row; description omitted “the” | Three cards per page, fourth facet reachable through More parts; restored wording and spacing | Matches the authored Questions geometry without dropping actual research |
| Keyboard navigation waited for a page wipe and could ignore consecutive input | Keyboard routing is immediate, two consecutive arrows advance two chapters; pointer transitions can retarget | Keeps navigation responsive |
| Working panels entered over 350–500ms; progress animated width | Working entry uses 200ms, 8px transform and opacity; playing progress uses linear scaleX | Reduces delay and avoids repeated layout animation |
| Caption intent with blank text could silently trace the photograph | Blank caption blocks Start, with a clear label and guidance | Prevents a different investigation from the selected intent |
| Public URL draft accepted credential/query-bearing URLs; arbitrary URL preview showed Earthrise | Immediate format validation; arbitrary URL displays an honest placeholder; server retains DNS/MIME/size validation | Keeps input and represented media consistent |
| Selecting a public image removed the native file input | One persistent input supports replacing the public selection with a local file | Fixes the actual picker workflow |
| Long source titles consumed all passage space and pushed paper actions behind the transport | Full source title and passage share an internal, keyboard-focusable scrolling region | Retains complete evidence and reachable controls |
| Selecting an off-page source left its tab page behind | Dropdown selection moves to the matching tab page; changing anchor type resets the page | Keeps selected data and navigation consistent |
| Source markers after Z became punctuation | AA, AB… spreadsheet-style markers | Keeps large source sets readable |
| Successful watch polling erased an action failure; singular count was pluralized | Separate load/action errors; “1 retained check”; whitespace-only question disabled | Preserves useful feedback |

## Worst-case record tests

Fixtures pass through the real record parser and component props. They never write stored records or invoke providers. They derive from payment research data, use reserved example.org URLs, and respect the real claim-report source cap of 12; the 1000-source fixture is a manual evidence case. Modes: Demo (3), Worst (9), Empty (0), One (1), 1000.

| # | Severity | Field | Worst-case value | Reproduced break | Fix location |
| --- | --- | --- | --- | --- | --- |
| 1 | Broken | Source title and passage | About 800 characters of mixed Hindi/English title and 16,500 characters of text | Paper scrollHeight 1081, title 632px high, passage viewport 0; actions outside paper | [EvidenceWorkbench.tsx](/Users/vasu/Desktop/Cook/contexttrail/src/components/casebook/EvidenceWorkbench.tsx:28): put title inside the reading scroll region. After: paper 610/610, passage scrolls internally |
| 2 | Broken | Source selection | Last source in 1000 records | Selected dropdown source could be outside visible tab page | [EvidenceWorkbench.tsx](/Users/vasu/Desktop/Cook/contexttrail/src/components/casebook/EvidenceWorkbench.tsx:25): synchronize page with selection |
| 3 | Ugly | Map marker | Sources 31–36 | Punctuation after Z | [SourceMap.tsx](/Users/vasu/Desktop/Cook/contexttrail/src/components/casebook/SourceMap.tsx:7): AE–AJ verified through Next controls |
| 4 | Ugly | Caption preview | 500 mixed-script characters, form maximum | Caption spilled out of specimen | [globals.css](/Users/vasu/Desktop/Cook/contexttrail/src/app/globals.css:1149): two-line preview with full title text, original textarea remains editable |
| 5 | Broken | Caption intent | Empty/whitespace caption | Different intent could submit | [UploadForm.tsx](/Users/vasu/Desktop/Cook/contexttrail/src/components/upload/UploadForm.tsx:77): requires nonempty caption for caption mode |
| 6 | Broken | Image replacement | Public NASA selection followed by local file | Missing input blocked replacement | [UploadForm.tsx](/Users/vasu/Desktop/Cook/contexttrail/src/components/upload/UploadForm.tsx:101): stable native input |
| 7 | Fragile | Public URL | Credential/query-bearing HTTPS URL | Invalid draft accepted until server response | [public-images.ts](/Users/vasu/Desktop/Cook/contexttrail/src/lib/media/public-images.ts:17): bounded format error before submission; [useInvestigation.ts](/Users/vasu/Desktop/Cook/contexttrail/src/lib/stream/useInvestigation.ts:286): safe actionable 400 response |
| 8 | Ugly | Watch check count | One retained check | “1 retained checks” | [Watchlists.tsx](/Users/vasu/Desktop/Cook/contexttrail/src/components/casebook/Watchlists.tsx:68): singular label and preserved action feedback |

Full source URLs around 1980 characters wrap and remain inspectable; missing titles use Untitled source. Empty sources/evidence use actual empty-state guidance. In the final toggle pass all five modes reported a 1280px document at a 1280px viewport, and the paper stayed 610px high without overflowing its frame. Large evidence renders eight tabs per page; source map now renders four authored cards per page. Full titles and passages remain accessible through inspection and internal scrolling. No unresolved choice is being presented as a needed redesign approval.

## Running-app verification

- Cover: chooser, About, Escape/focus restoration, walkthrough Play/Pause, two consecutive keyboard arrows. Keyboard reached the saved Video chapter with `instant-navigation` and no turn sheet.
- Image: invalid public URL rejected before submission; public NASA selection followed by unsupported local file displayed an error; replacement with the actual local Earthrise file recovered. Blank caption disabled Start; 500-character caption enabled it and stayed inside its preview. This initial input pass submitted no retrieval; the completed fresh provider runs are recorded below.
- Questions: reopened actual UPI investigation, operated More parts to facet D and Previous parts to A; exact source spans changed. Three-card heading and row match the reference geometry; heading x=117.6, y=130.8, width=324, height=198.356 at 1280×720.
- Evidence/Sources: actual retained sources inspected, long title/passages tested, 1000-source dropdown and map pagination operated, empty states checked. Earlier UI-created synthetic table/finding/correction workflow remains documented in `design-qa.md`.
- Video: opened saved Delhi media investigation through the casebook; 00:10.500 selected the retained Jasola-demolition passage. Return to Cover retains its media navigation. Original frame bytes remain explicitly unavailable.
- Watch: whitespace-only question disabled Start; selected Every hour; opened paused watch and expanded its eight-source starting sample. Resume/Check now were inspected, not executed.
- AI: second quotation selected ACR characters 1322–1503; opened original anchored passage, Escape closed it and restored focus.
- Production `/ui-stress` returns 404. Fixture route is dev-only.

Cover's settled app and reference title bounds at 1280×720: x=116, y=157.2, width=486.4, height=179.5625. Transport bounds both: x=64, y=635.2, width=1152, height=84.8. The final app screenshot was visually inspected. Animated collage phases are independent, so this is not a claim that every animated pixel is equal.

The earlier IAB 320/1090/2560 viewport override attempts did not resize app tabs reliably. `cover-geometry.json` retains both requested and observed sizes to make that failure explicit: observed app size stayed 1280×720. Those earlier attempts are NOT additional mobile/wide passes. The final Chrome viewport checks did apply: 320×800 produced a 320×200 stage at (0,300), and 2560×1440 produced a 2304×1440 stage at (128,0), with no horizontal document overflow. Earlier real viewport checks in `design-qa.md` are historical. Actual 200% browser zoom and OS reduced-motion mode were not exercised in this pass; reduced-motion and keyboard behavior were inspected in code/tests.

## Validation and limits

Production build, lint/type validity: passed. Full suite: 109 files, 1,734 tests passed, 17 intentional skips. The first sandboxed full run could not bind its synthetic loopback server; the authorized loopback run passed. `git diff --check`: passed. Removed one obsolete CSS-string test that required the rejected responsive font size; contrast and full-text wrapping checks remain. One build accidentally began in the shared checkout and was stopped; the final completed build and browser run use the isolated preview. No existing server was stopped.

Read-only provider checks authenticated SerpApi and TypeSafe and verified a bounded available allowance. Credentials remain in private, Git-ignored files. No billing or recharge settings changed.

The user's explicit instruction to complete live acceptance authorized the bounded trial. The public-image trace completed in 11.083 seconds: 3 actual searches, 13 retrieved candidates, 17 successful Jev requests and 5 successful source-page reads. Investigation `5d1b0875-3884-42d0-a5a9-5278dfa06dc7` was saved through the UI and reopened. NASA's exact retained Earthrise passage and its 2019 page date were checked in the viewer and the saved Evidence chapter. Limited media history is the honest result: exact-image identity and the original publication remain unestablished. It is no longer a local-allowance failure.

Additional bounded grants were appended through the existing allowance tool for the authorized real-run verification. All historic reservations remain intact; no ledger reset or refund was applied.

The accepted content requirement is **real investigation data throughout**. The HTML supplies typography, paper, colors, stage and chapter arrangements. Its fictional source records, confident origin chain, correction and AI statements are not inserted into real investigations. Missing earlier snapshots, unverified source origins and unretained recording bytes are explicit real-data states. Experimental fictional-walkthrough files were removed before the final production build.

The final fixes include the actual image-result toolbar height, paper source viewer with Escape/opener focus, contrast of the refresh notice, correct confirmed-domain label, four-paper source map with pagination, paired Changes papers with an explicit unavailable earlier snapshot, image-trace page quotes in the Answer chapter, preserved month abbreviations and keyboard-scrollable video source panels that reset on selection.

## Final acceptance follow-through

Fresh question `research-afec2a13-1ba9-44fc-9b70-ceef89fa46ad` completed through the actual UI, retaining 12 sources and 3 inspected passages; 9 leads remain uninspected. It saved automatically and reopened from persistent storage. Passage selection changed the exact original URL/span, and chapter links retained this saved case. Both fresh provider runs are complete; the former pending allowance is resolved.

The automatic-save navigation defect is fixed: after saving a different case, all research chapter links immediately follow the returned saved ID. Actual browser verification observed that change before clicking Open saved case. Source tour selection now changes to page two for the fifth source; the regression suite verifies both directions.

Final production Sources positions match the rendered HTML at 1280×720: heading (117.6,90.4), count (881.6,86.4), map (102.4,251.2), detail (860.8,242.4). Real text heights/pagination vary. All 13 sources are reachable; Worst and 1000-source checks remain at 1280px document width. Final production fixtures return 404.

Remaining local bounded allocation is 6 searches, 1 upload, 76 Jev requests and 324 questions, with historic reservations intact. Final production build and full 109-file suite pass: 1,734 tests, 17 intentional skips. Final screenshots and source geometry were refreshed after the last build.

## Evidence

[Final Cover](00-cover-production.jpg), [reference Cover](00-cover-reference.jpg), [Questions](03-questions-production.jpg), [reference Questions](03-questions-reference.jpg), [long title before](evidence-long-title-before.jpg), [after](evidence-long-title-after.jpg), [caption maximum](image-long-caption.jpg), [saved video](02-video-production.jpg), [fixture metrics](stress-final.json).

Some earlier chapter pairs capture entrance animation and are visual supplements, not settled geometry proof. `cover-reference-1280.jpg` was captured at the narrower user panel despite its filename; do not use it for matched-size comparisons. The named `00-cover-reference.jpg` comparison was captured at the observed 1280×720 size.

## Owner-reported case-list contrast follow-up

The owner supplied the missing saved-case hover state. It reproduced in the running app at `/casebook?chapter=answers`: background rgb(234,225,202), title rgb(242,236,217), caption rgb(243,223,198). The shared case-row rule now sets title/number/metadata to rgb(36,44,43) and caption to rgb(96,98,89) on both hover and focus-visible. Actual browser input verified independent pointer hover on the first row and keyboard focus on the second. Production was rebuilt after this CSS-only repair; the prior full suite count is unchanged.
