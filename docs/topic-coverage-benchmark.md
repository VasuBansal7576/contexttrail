# Bounded topic coverage benchmark

Issue #30 concerns retrieval utility. The completed live trial did not retain the relevant ISRO account. Its captured response does not contain the omitted search pool, so it cannot establish whether that document was available to selection. This benchmark never substitutes its injected candidates for that unknown live pool.

Run `npm run research:coverage` to execute eight controlled offline cases through the actual topic orchestrator, extraction, resource binding, date resolution, claim projection and injected Jev adapter. The command writes a JSON comparison to stdout and makes no provider requests. Use `npm run research:coverage --silent > .verify/topic-coverage.json` after creating `.verify` to retain an artifact.

The reference registry is separate from production selection. On October 2, 2026 these first-party documents were independently inspected:

| Research question | Reference document | Recorded date meaning |
| --- | --- | --- |
| ISRO privatisation and institutional reform | [ISRO clarification](https://www.isro.gov.in/Clarification_regarding_media_reports.html) | Publication: September 6, 2026 |
| NASA commercial lunar delivery services | [NASA CLPS overview](https://www.nasa.gov/commercial-lunar-payload-services/) | Last updated: July 6, 2026; publication unknown |
| Bank of England monetary policy tools | [Monetary policy account](https://www.bankofengland.co.uk/monetary-policy) | Publication unknown |

The registry records relevance and date meanings, not an authority or truth determination. Candidate lists, page HTML, passages and model relevance responses are explicitly synthetic. The registry's actual URLs are injected at a low candidate rank to test selection; the supplied HTML is not an observed publisher response. Synthetic quotations are marked in both their text and measurement metadata. No observed live quotation is fabricated or replayed.

The JSON compares the former surface-only round robin with actual retained reference coverage, page quotes, dates, failures, unresolved coverage and physical operation counts. The former comparison is selection-only. It does not claim an executed historical provider run. Three institution cases expose the low-ranked reference; additional controls cover secondary-only results, unsafe references, failed primary reads, rejected different-resource redirects and pages without readable quotations. An unrelated institutional holiday-policy page tests realistic name/boilerplate overlap. The updated-date control never promotes a modified date to publication.

Selection filters unsafe references before slots are allocated. At most one lead per search surface, and at most two in total, receives document-cue priority; other slots retain surface round robin. A title/snippet must contain a generic statement/clarification/overview cue and match at least two and three quarters of the meaningful question terms. Hostnames, reference URLs, institution names and answers are not special-cased in production. Selected priority leads enter the same five page-read slots; searches remain three, sources eight, Jev requests eight and questions forty. Failures retain original lead ownership and do not trigger replacement provider work.

This lexical screen cannot establish that a source is primary or relevant. Secondary reporting can repeat statement wording, boilerplate can overlap, and paraphrases or languages without matching terms may be missed. Date/question words are filtered and simple term prefixes approximate inflections. The production limitation therefore keeps primary-source coverage unestablished even when document leads are retained. Model relevance never supplies authority, truth, independence or media identity.

A future live utility benchmark remains open under #30 and needs separate finite approval. This offline change cannot establish provider recall, identify the old omitted pool, or prove that a future search will retrieve every primary document.
