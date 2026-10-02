# Source-linked report

New completed investigations carry an additive `sourceLinkedReport` (`source-linked-report-v1`). Older cached results legitimately omit it; no storage migration or frontend redesign is required. The existing status, thresholds, identity gates, chronology and provider budgets are unchanged.

`captionFindings` explains strong, relevant model-assessed source relations with evidence IDs, source URLs, identity basis, actual displayed excerpts and distinct classification context. A finding on a visual lead is explicitly ineligible for the core identity policy. Neither a model probability nor an institutional-looking domain establishes authority. Excerpts are inspectable context, not separately verified entailment spans. Independent corroboration must be read from the existing deterministic policy gates, not counted from findings. Trace reports have no caption findings.

`provenanceCompleteness` separately records earliest observed occurrence, dated/core pair coverage, unresolved reporting origins and unverified visual leads. Original publication remains unknown. A page date is not the image's creation date. Reporting-origin independence is not original-image authorship.

`sourceRoles` separates model-assessed document-role distributions from historical event roles. A qualifying media identity establishes a media occurrence; it does not establish false-caption circulation, correction publication or original publication. Those event roles remain unresolved until auditable direct evidence exists. The report deliberately does not auto-label a fact-check classifier result as a verified correction event.

`pageReads` records each candidate's selected/not-selected, fetch and extraction outcomes independently. Successful fetch with empty extraction is distinct from transport failure. Failure categories and safe HTTP statuses are allowlisted; raw exceptions are never exported. Audit URLs omit userinfo, query and fragments, and retain candidate IDs for source linkage. Exact reasons within the malformed category remain unavailable rather than guessed. No additional reads or retries occur. Historical exports without this audit retain `pageReadAuditAvailable: false`; do not reconstruct their missing failure URLs or causes.

Recorded real trial exports and videos are immutable evidence of their original source revision. An offline derived report, if produced, must be separate and identify its source revision and input artifact; it is not another real provider run.
