# Topic candidate reference audit

Future completed topic investigations optionally retain `coverage.topicCandidateAudit` version `contexttrail-topic-candidate-audit-v1`. Older cases have no audit; their omitted source identities remain unknown. Reading, listing or reopening them does not reconstruct or backfill an omitted pool, modify archive bytes or make provider calls.

The audit covers **unique normalized topic candidates**, after the existing canonical-URL deduplication. It is not the complete provider response, an exhaustive web search, a primary-source registry or an authority assessment. The first search owning a canonical candidate remains its owner; duplicate appearances update existing date handling but do not invent additional audit ownership.

At most 100 safe URL references are retained, with all selected source references first, followed by other safe candidates in the existing deduplication/insertion order. Each row contains only the generated candidate ID, safe source URL, first owning search index, nullable provider rank and retained/not-retained disposition. Provider titles, snippets, raw responses, dates, model judgments and authority flags are excluded. Lexical ranking cannot be replayed from this URL-only capture.

Counts distinguish:

- Per-search normalized result count, malformed/unsupported rows dropped before normalization, and canonical duplicate count. Unavailable search counts remain null; a successful empty response has measured zero counts.
- Global unique normalized candidates = summed normalized candidates minus canonical duplicates.
- Safe references plus unsafe/oversized references withheld = unique normalized candidates. Withheld URLs are never copied into the audit.
- Selected references plus safe candidates not retained as evidence = safe references.
- Captured references plus safe references outside the 100-row capture = safe references. Truncation is separate from evidence omission.

The current `omittedEvidenceCount` continues to mean unique normalized candidates not selected as evidence, including withheld unsafe entries. Requested result count `num=10` is not a guaranteed returned-result cap. Existing provider responses remain capped at 4 MiB; no normalization count cap or selection behavior is changed by this diagnostic capture.

Server capture still uses the existing public-source reference policy. Browser validation separately checks the same bounded HTTP(S), credential, sensitive-parameter, public literal-IP and hostname rules; parity tests compare subnet edges, IPv6, mapped IPv4, normalized numeric aliases, percent hosts and trailing dots. Query-addressed resource identity is preserved. Parsing references performs no DNS lookup or fetch, and the existing DNS/pinning/redirect guards remain unchanged for actual reads. Public reference eligibility does not establish page authority or privacy of its contents.

Retained audit rows bind to the original source-read IDs and requested URLs, including unread selected leads and failed/rejected destinations. They do not bind to a later corrected evidence URL. The original `claimReportCase` snapshot owns saved audit presentation; coverage is historical retrieval metadata, not part of the claim report's evidence-binding digest. Legacy fallback provenance cannot establish original audit ownership. Source correction/removal/revert does not fabricate a replacement past audit.

The audit remains under the existing 8 MiB stream and 5 MiB local request/archive caps. URL-only rows bounded to 4096 characters add at most roughly 420 KiB per case snapshot, before repeated history/snapshot copies; existing size limits still reject oversized state without changing the prior archive. Search/source/page/model limits stay 3/8/5/8 requests and 40 questions. Offline controls establish capture and retention behavior, not improved live primary-source recall. Issue #30 remains open; its earlier omitted pools cannot be recovered from this addition.
