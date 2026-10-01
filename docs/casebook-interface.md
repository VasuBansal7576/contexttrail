# Casebook application checkpoint

The application uses the updated nine-chapter reference, “A Place for the Question,” inspected on 1 October 2026. The reference Site is unchanged. Its fictional Earthrise case was not imported as real research.

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
- Changes: retained source snapshots side by side, capture and publication dates separated, and research revision counts.
- `/compare`: actual two-file local video/video or video/still comparison. It displays returned sampled frames, timestamps, approximate compared regions, raw pixel errors, sampling coverage and limitations.
- Watch and AI answers: explicit planned-connection chapters. They perform no scheduling or model calls.

## State and recovery

Draft IDs remain stable for retries. A lost edit response is reconciled against the server’s accepted operation IDs. If the read also fails, a same-draft retry reuses the pending request. Case creation also reuses its operation and timestamp. Conflicts load the authoritative case without unmounting the draft. Editing dialogs block accidental outside-click/Escape dismissal; Cancel and Discard draft are intentional exits. Busy image intake is locked before the first asynchronous file read.

Source intake and material retention are two separate existing API operations. The UI states when the source reference saved but the snapshot outcome is unresolved. It never binds an old supplied snapshot to a concurrently changed source. Retrying the material stage requires the same source and snapshot draft. A retained image/table correction creates a new material revision before finding re-review. Empty table cells and unedited retained cells containing tabs/newlines are preserved.

## Scope still requiring application/backend work

These are integration gaps, not simulated functionality:

- Hosted accounts, team access, account sync and authenticated non-loopback storage
- Persisting a completed image investigation directly into a casebook inquiry
- Persisting local video candidates/frames as case evidence; current comparison is explicitly temporary
- Broad web video search, audio comparison, continuous/full-video analysis
- Scheduled watch execution and notifications
- Model-generated research answers
- Editing the main inquiry question through the current application API
- Binding findings to individual hypotheses; the existing contract binds them to questions
- Re-reviewing a multi-support finding in the single-source UI. Such records stay readable and the UI preserves them rather than dropping supports
- Resolving the exact old text-source digest in the viewer. Stale text findings show their saved quote separately from the current source and direct the reader to Changes; they do not guess a historical match
- Lossless in-app edits for table cells containing literal tabs/newlines. Unchanged content can be carried into a metadata correction; edited complex cells remain a local-workflow task
- Broader visual reskin of the existing image-progress/result screens

## Verification and its limit

`src/components/casebook/casebook-flow.test.ts` mounts actual React components in jsdom against the real disk-backed local research service. This checks persistence, exact binding, correction/re-review, table cells, cancellation before creation, response-loss idempotency, and conflict draft recovery. It is not rendered-browser proof.

`src/lib/research/client.test.ts` and `src/lib/video/matching/client.test.ts` validate browser boundaries, source/material identities, unsupported responses, cancellation, preview cleanup, repeated submit prevention and late-response suppression. The existing research and native media HTTP scripts verify the production routes separately.

`scripts/verify-casebook-ui.mjs` is the real-browser follow-on. It launches its own isolated production server, uses synthetic inputs, blocks remote requests, captures desktop/mobile screenshots, and exercises Back, reload, focus, exact evidence, source corrections, and retained table/image paths. It must be run where Chromium may launch. `CONTEXTTRAIL_TEST_CHROMIUM` can name an available supported binary.

Rendered verification is blocked in this execution environment. Playwright's bundled browser is absent. Installed Chromium fails before a page opens with `socket() failed: Operation not permitted`, including the one approved outside-sandbox attempt. No local screenshot or visual acceptance is claimed, and the blocked browser route was not bypassed.
