# Automatic topic and video investigations

## Entry points

- `/investigate`: existing image Trace/Claim-check workflow, unchanged.
- `/questions`: enter one question or topic (5–500 characters), then inspect retrieved source evidence.
- `/video`: supply one self-contained MP4/MOV/WebM/MKV video, at most 32 MB and 120 seconds. Confirm permission to send one sampled frame to the named providers.
- `/casebook`: existing manual research workspace remains available.
- `/compare`: existing explicit supplied-pair comparator remains available.

`POST /api/research/investigate` accepts multipart `kind=topic, topic=...`, or `kind=video, video=<file>, rights=user_provided`. Other fields, duplicate fields and mixed inputs are rejected. It streams `research.progress`, then `research.completed` or `research.error` NDJSON events. Cancel/unmount aborts client work and propagates to provider calls and decoder processes. Repeated submit is locked; stale completions cannot replace a newer input's result.

## What actually runs

Topic research performs three bounded searches: Google web, Google News, and a primary-source/chronology query. It deduplicates canonical source URLs, balances the search surfaces, retains at most eight leads, safely fetches at most five source pages, and extracts actual source paragraphs. Search snippets remain labeled snippets when full pages cannot be read. Dates use the existing deterministic date resolver. TypeSafe Jev assesses relevance of the supplied topic and retrieved excerpt; it does not write an answer or establish truth. The result retains evidence IDs, source URLs, dates/provenance, attempted/returned/retained search counts and limitations. There are no generated quotations, claim verdicts, government-targeting tools or response/rebuttal recommendations.

Video research locally decodes up to three bounded samples using the existing FFmpeg preparation path, selects the middle decoded sample, and invokes the existing real image Trace pipeline once. It searches **one frame**, not the whole video. Frame offsets are not publication timestamps. The original video and decoded frame bytes are not persisted by this workflow; decoder temporary files are cleaned in its existing `finally` block. SerpApi receives one sampled-frame upload. Retrieved text is assessed by TypeSafe. Source evidence can be explored alongside the frame's timestamp and existing image investigation limits. A frame match never becomes a whole-video identity finding.

Results live in the current browser component, and are not automatically written to the manual casebook. Reloading loses them. This is a read-only investigation result rather than a synthetic or manually populated case.

## Admission and costs

Live use remains **disabled by default**. The route requires the existing single-user loopback research opt-in, existing live-usage configuration/verified allocation and server-only provider keys. Video additionally requires `CONTEXTTRAIL_MEDIA_LOCAL=1` and installed FFmpeg/FFprobe. Hosted/serverless live use remains denied.

The persistent ledger and exclusive lock are shared with image investigations. The full fixed worst-case amount is reserved before any provider dispatch; the reservation is not refunded for an early result, failure or cancellation. Nothing in the implementation resets a period or ledger or queries provider balances.

| Workflow | Search attempts | Upload attempts | Jev requests | Jev questions |
| --- | ---: | ---: | ---: | ---: |
| Topic | 3 | 0 | 8 | 8 |
| One representative video frame | 4 | 1 | 60 | 113 |

These are ceilings, not reported actual charges. The interface displays them before submission. The grant utility supports only fixed reviewed shapes, including topic and one-frame Trace; it requires an explicit offline operator action and preserves all past reservations. Changing code does **not** authorize or perform a grant. Any exhausted existing allowance remains exhausted.

## Verification boundaries

The new tests exercise source extraction, source attribution, empty and failed retrieval, malformed model probabilities, source-date handling, one-frame orchestration, parser rejection, live default-deny, cross-origin/loopback rejection, caps, nonrefundability, stream cancellation and UI stale-result handling. Tests inject offline provider responses only. Full test/typecheck/build commands remain those in the README.

Before a live demonstration, separately verify remaining provider credit, authorize the precise workflow's worst-case budget and data destinations (including video-frame upload), configure the existing persistent admission store without resetting history, and run one real input through the built UI. Retain the actual returned sources and limitations before making a narrated recording. Offline tests, sample fixtures and builds do not prove live retrieval quality or provenance accuracy.
