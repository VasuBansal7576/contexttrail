# Automatic topic and video investigations

## Entry points

- `/investigate`: existing image Trace/Claim-check workflow, unchanged.
- `/questions`: enter one question or topic (5–500 characters), then inspect retrieved source evidence.
- `/video`: supply one self-contained MP4/MOV/WebM/MKV video, at most 32 MB and 120 seconds. Confirm permission to send one sampled frame to the named providers.
- `/casebook`: existing manual research workspace remains available.
- `/compare`: existing explicit supplied-pair comparator remains available.

`POST /api/research/investigate` accepts multipart `kind=topic, topic=...`, or `kind=video, video=<file>, rights=user_provided`, optionally `claim=<caption up to 500 characters>`. Other fields, duplicate fields and mixed inputs are rejected. It streams `research.progress`, then `research.completed` or `research.error` NDJSON events. Cancel/unmount aborts client work and propagates to provider calls and decoder processes. Repeated submit is locked; stale completions cannot replace a newer input's result.

## What actually runs

Topic research performs three bounded searches: Google web, Google News, and a counterevidence query. It deduplicates canonical source URLs, balances the search surfaces, retains at most eight leads, safely fetches at most five source pages, and extracts actual source paragraphs. Search snippets remain labeled snippets when full pages cannot be read. Dates use the existing deterministic date resolver. TypeSafe Jev assesses relevance, relationship to an explicit supplied assertion, and entity/property, time and variant compatibility in one bounded five-question call per source. Missing scope stays unknown. The model does not write an answer or establish truth. Broad questions expose exact source-quoted candidate assertions, without inventing a user claim. A verbatim quote is not proof that its assertion is true. The result retains evidence IDs, source URLs, dates/provenance, attempted/returned/retained search counts and limitations. There are no generated quotations, claim verdicts, government-targeting tools or response/rebuttal recommendations.

Video research locally decodes up to three bounded samples using the existing FFmpeg preparation path, selects the middle decoded sample, and invokes the existing real image Trace pipeline once. With an optional caption, the same frame enters the existing image Claim-check policy instead of Trace, and the caption is sent to SerpApi web/news search and TypeSafe. It searches **one frame**, not the whole video. Frame offsets are not publication timestamps. The original video and decoded frame bytes are not persisted by this workflow; decoder temporary files are cleaned in its existing `finally` block. SerpApi receives one sampled-frame upload. Retrieved text is assessed by TypeSafe. Source evidence can be explored alongside the frame's timestamp and existing image investigation limits. A frame match never becomes a whole-video identity finding.

Results live in the current browser component until explicitly saved. Save to casebook retains the report, exact source references and evidence bindings; it does not retain uploaded media. Reopening does not run a model or refresh evidence. Evidence/material correction invalidates the old report and presents it as historical, with a Needs review warning. Repeated saves preserve intervening edits. Unsaved results are lost on reload.

Source relationships remain model-assessed support, challenge, context or insufficient evidence. Support/challenge require fetched page text and compatible scope; direct repetition alone is insufficient. Opposing source assessments stay unresolved rather than being decided by a vote. Different domains do not establish independent reporting; repeated passages and literal citation references are disclosed only as dependency signals. No global source-credibility score, all-reviews verdict or original-uploader claim is produced.

## Admission and costs

Automatic question page reads use the same conservative resource binding as
image deep reads. Same-host path/query changes, cross-host redirects, HTTPS
downgrades and login/error destinations cannot donate text, titles or publication
dates to the original search lead. A bound page supplies its own quote, title and
date provenance only when a question-overlapping paragraph is retained. Without
that quote, the original snippet/title/search date remain at the requested URL,
including on legitimate URL normalization or HTTPS upgrades.

New case records retain optional `coverage.sourceReads` audit rows with evidence
ID, safe requested/final URLs, resource binding and read outcome. The audit
survives explicit save/reopen; legacy records without it remain valid. Unsafe or
credential-bearing final URLs are recorded as absent with binding unestablished,
rather than copied into saved data. Audit rows are historical retrieval records,
not proof of media identity or a renewed source assessment.

Live use remains **disabled by default**. The route requires the existing single-user loopback research opt-in, existing live-usage configuration/verified allocation and server-only provider keys. Video additionally requires `CONTEXTTRAIL_MEDIA_LOCAL=1` and installed FFmpeg/FFprobe. Hosted/serverless live use remains denied.

The persistent ledger and exclusive lock are shared with image investigations. The full fixed worst-case amount is reserved before any provider dispatch; the reservation is not refunded for an early result, failure or cancellation. Nothing in the implementation resets a period or ledger or queries provider balances.

| Workflow | Search attempts | Upload attempts | Jev requests | Jev questions |
| --- | ---: | ---: | ---: | ---: |
| Topic | 3 | 0 | 8 | 40 |
| One representative video frame, no caption | 4 | 1 | 60 | 113 |
| One representative video frame with caption | 6 | 1 | 60 | 272 |

These are ceilings, not reported actual charges. The interface displays them before submission. The grant utility supports only fixed reviewed shapes, including topic and one-frame Trace; it requires an explicit offline operator action and preserves all past reservations. Changing code does **not** authorize or perform a grant. Any exhausted existing allowance remains exhausted. Historical eight-question topic reservations and grants retain their original charge, but cannot admit the expanded forty-question workflow without sufficient explicitly authorized remaining capacity.

## Verification boundaries

The new tests exercise source extraction, source attribution, empty and failed retrieval, malformed model probabilities, source-date handling, one-frame orchestration, parser rejection, live default-deny, cross-origin/loopback rejection, caps, nonrefundability, stream cancellation and UI stale-result handling. Tests inject offline provider responses only. Negative controls cover suppression versus fabrication, historical settlements versus current/all reviews, mixed customer experiences and refunds, legitimate archival reuse, opposing retrieved relationships, exact claim repetition, and saved-report invalidation. They prove deterministic gates and preservation of model-boundary outputs, not live semantic classification accuracy. Full test/typecheck/build commands remain those in the README.

Before a live demonstration, separately verify remaining provider credit, authorize the precise workflow's worst-case budget and data destinations (including video-frame upload), configure the existing persistent admission store without resetting history, and run one real input through the built UI. Retain the actual returned sources and limitations before making a narrated recording. Offline tests, sample fixtures and builds do not prove live retrieval quality or provenance accuracy.
