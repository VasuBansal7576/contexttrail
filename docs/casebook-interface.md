# Casebook application checkpoint

The application follows the owner’s exact local `Product HTMLs/ContextTrail.html`, titled A Place for the Question. The complete HTML source, embedded assets and interaction handlers were inspected. Browser policy blocked direct interaction with that file URL; source inspection is not an original-browser walkthrough. The rebuilt product is being checked through computer use on loopback. Its fictional Earthrise case is not imported as real research. See [frontend reference](frontend-reference.md).

## Running locally

Build this checkout, then run it on loopback with the existing explicit local-service opt-ins:

```sh
npm run build
CONTEXTTRAIL_RESEARCH_LOCAL=1 \
CONTEXTTRAIL_MEDIA_LOCAL=1 \
CONTEXTTRAIL_RESEARCH_DATA_DIR=/absolute/private/research-directory \
npm start -- -H 127.0.0.1 -p 3110
```

The local research and media routes remain disabled by default and reject non-loopback and cross-origin requests. No account, hosted storage, or public deployment boundary has been added. Media comparison also needs the trusted FFmpeg/FFprobe installation documented in `local-media-application.md`.

The image investigation still uses its existing provider configuration, consent, budget, and server gates. Opening a chapter or creating a manual research case never starts provider work.

## Connected application paths

- `/`: editorial entry and nine chapter links. The project-owned NASA photograph is explicitly illustrative.
- `/investigate`: the existing image upload, public-image options, claim input, stream, cancellation, session restore, result, timeline and evidence viewer. Only the entry screen is restyled here.
- `/casebook`: real saved case list and question creation through `/api/research`.
- Questions: saved subquestions and working hypotheses. Findings show reviewer assessment and exact source support, with changed-source review warnings.
- Evidence: supplied passages, bounded PNG snapshots, and literal tab-separated tables. Findings bind a quote offset, image-pixel rectangle, or table row/column/value to retained source material.
- Sources: supplied citations, retained targets, unresolved targets, exact quote checks, and shared citation targets. No inferred independence or first-publication count.
- Changes: source snapshots and exact retained material versions have separate comparison controls. Image/table pairs use material revision and digest. Source digests exclude timestamps and do not identify a particular material revision. Capture, retrieval and publication dates remain separate.
- `/compare`: actual two-file local video/video or video/still comparison. It displays returned sampled frames, timestamps, approximate compared regions, raw pixel errors, sampling coverage and limitations.
- Watch: automatic local scheduled retrieval with baseline, changed-source history and pause/resume. See automatic-watches.md.
- AI answers: selectable quotations from the retained original report, with the exact passage and source beside each selection. This is a working source reader. Model-generated synthesis remains incomplete.
- Chapter transport: previous/next, keyboard arrows, guided playback, contents and About dialogs. A selected saved case follows chapter navigation; interaction pauses playback. The desktop stage scales from 1440×900 and the mobile layout scrolls.

## State and recovery

Draft IDs remain stable for retries. A lost edit response is reconciled against the server’s accepted operation IDs. If the read also fails, a same-draft retry reuses the pending request. Case creation also reuses its operation and timestamp. Conflicts load the authoritative case without unmounting the draft. Editing dialogs block accidental outside-click/Escape dismissal; Cancel and Discard draft are intentional exits. Busy image intake is locked before the first asynchronous file read.

Source intake and material retention are two separate existing API operations. The UI states when the source reference saved but the snapshot outcome is unresolved. It never binds an old supplied snapshot to a concurrently changed source. Retrying the material stage requires the same source and snapshot draft. A retained image/table correction creates a new material revision before finding re-review. Empty table cells and unedited retained cells containing tabs/newlines are preserved.

## Scope still requiring application/backend work

These are integration gaps, not simulated functionality:

- Hosted accounts, team access, account sync and authenticated non-loopback storage
- Persisting a completed image investigation directly into a casebook inquiry
- Persisting local video candidates/frames as case evidence; current comparison is explicitly temporary
- Proven crop/trim/subtitle video-segment identity and audio comparison. Current automatic media research scans the bounded visual track locally, recognizes speech and searches up to three frames plus usable spoken text; this does not establish whole-recording identity.
- Hosted watch scheduling and notifications. Local scheduled checks already run while the loopback server is active.
- Model-generated research answers
- Editing the main inquiry question through the current application API
- Binding findings to individual hypotheses; the existing contract binds them to questions
- Re-reviewing a multi-support finding in the single-source UI. Such records stay readable and the UI preserves them rather than dropping supports
- Historical time-span media playback. Original audiovisual bytes are not retained; the saved time selection remains inspectable in the finding
- Lossless in-app edits for table cells containing literal tabs/newlines. Unchanged content can be carried into a metadata correction; edited complex cells remain a local-workflow task
- Remaining layout and interaction acceptance for long image-progress/result screens

## Verification and its limit

`src/components/casebook/casebook-flow.test.ts` mounts actual React components in jsdom against the real disk-backed local research service. This checks persistence, exact binding, correction/re-review, table cells, cancellation before creation, response-loss idempotency, and conflict draft recovery. It is not rendered-browser proof.

`src/lib/research/client.test.ts` and `src/lib/video/matching/client.test.ts` validate browser boundaries, source/material identities, unsupported responses, cancellation, preview cleanup, repeated submit prevention and late-response suppression. The existing research and native media HTTP scripts verify the production routes separately.

`scripts/verify-casebook-ui.mjs` is the real-browser follow-on. It launches its own isolated production server, uses synthetic inputs, blocks remote requests, captures desktop/mobile screenshots, and exercises Back, reload, focus, exact evidence, source corrections, and retained table/image paths. It must be run where Chromium may launch. `CONTEXTTRAIL_TEST_CHROMIUM` can name an available supported binary.

The original broad casebook browser attempt was blocked in its execution environment. The focused `scripts/verify-historical-evidence.mjs` now verifies the built UI through real loopback HTTP and disk-backed source snapshots for missing-current text/image/table evidence, changed sources and withdrawn materials. It captures desktop/mobile screenshots, blocks external requests and confirms that inspection makes no mutation or retrieval calls. This is synthetic workflow evidence, not source authenticity or retrieval-quality proof.

## Inspecting original evidence

Findings with changed or unavailable support offer **Inspect original evidence** when the exact original source and selection are retained. The read-only viewer highlights the saved text quote, image region or table cell and preserves the historical source URL, source revision, retrieval/capture provenance and material digest/revision. It never rebinds the finding, renews its review status or starts retrieval. Missing current evidence, changed sources/materials, explicit material withdrawal and absent matching history are labeled separately. Similar text or the current material is never substituted for the bound historical record. Source digest matches exclude capture/retrieval timestamps, so the displayed timestamps describe the retained snapshot rather than prove the original review time.

## Saved investigation coverage

Saved grounded topic reports display the investigation-wide limitations from the case snapshot retained alongside the report. This includes primary-source coverage uncertainty, failed reads, rejected destinations and unavailable assessments. The view also shows partial/unknown coverage, omitted candidates, original-publication uncertainty and recorded source-read outcomes. Empty limitation text or absent/empty read audits are labeled unavailable rather than treated as complete coverage or successful reads. Technical limitation values remain inspectable without changing the archive or claim report.

Coverage is outside the claim report's evidence binding and may change in the current workspace without invalidating excerpt assessments. The saved view therefore uses the original retained case snapshot for coverage even when the report is current. For a stale report, historical coverage remains visible outside its collapsed assessment and is explicitly distinguished from the corrected case. The displayed creation timestamp is case-record creation, not save, retrieval or report time.

The additive `claimReportCaseOrigin` metadata distinguishes a stored `retained_snapshot` from a `legacy_fallback`. Older saves without an original snapshot, including historical null values, keep a fallback evidence snapshot so corrections, material changes, retries and reverts remain safe. Their original coverage stays unavailable. That origin remains sticky through later edits; current workspace warnings are never substituted as original investigation coverage. Existing snapshots without an origin field are treated as retained alongside the report. Read/list operations do not rewrite stored files. No claim-report bytes, evidence binding, relationships or verdict rules are changed.

`node scripts/verify-saved-topic-limits.mjs` exercises the production Chrome UI with an existing synthetic source adapted into a completed topic result. It makes three real local saves and checks 24 open/reload scenarios at 1440px, 390px and 320px across current, stale, legacy and corrected legacy reports. Exact report archives, source-assertion semantics, unchanged insufficient relationships, no overflow, no archive rewriting and no retrieval or mutations on reopen are checked. Providers are never called. Screenshots and captured text are written to `.verify/saved-topic-limits`.

The separately retained issue #36 real-response capture was also replayed read-only against a production build: all ten original warnings are visible on desktop and mobile open/reload, with unchanged eight insufficient relationships. The capture remains an ignored local artifact rather than part of the synthetic fixture or repository.
