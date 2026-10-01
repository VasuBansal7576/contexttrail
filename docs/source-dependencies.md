# Source dependency and citation checks

This local report inspects a supplied CaseRecord v1 plus supplied citation links. It reports shared citation targets, identical retained passages, and exact attributed-quote occurrence. It does not fetch pages, call a model, decide which assertions are true, or count independent sources. All demonstration material is synthetic.

## Run and inspect

```sh
npm run source-dependencies -- scripts/fixtures/source-dependencies/sample.json
```

The command writes a JSON report to stdout. For clean JSON without npm's script preamble, compile once with the command above, then run:

```sh
node .source-dependencies-build/scripts/source-dependencies.js scripts/fixtures/source-dependencies/sample.json > /tmp/contexttrail-source-report.json
```

The CLI reads one local file, capped at 20 MiB, and writes no case state. It does not use credentials, providers or network access. The parser accepts at most 1000 citations, using the case parser's existing evidence bounds. More than 10000 citation-to-target comparisons fails explicitly rather than silently truncating the report.

## Actual sample result

The sample emits these results (the complete report includes stable IDs, citations, retained evidence, evidence bindings, and the checking method):

- `syndicated-a` and `syndicated-b` cite `https://study.example/results`. A shared supplied target is observed; common-source dependence is only inferred as possible. The supplied primary designation remains unverified.
- Those same two items contain an exactly identical retained passage on different domains. The wording match is observed; copying, direction and independence remain unknown.
- Two different paths on `news-a.example` remain two source keys. No inference of dependence follows from their domain.
- `translation` contains Spanish wording. No translation or copying detector is implemented; no matching group does **not** establish independence.
- Citation `syndication-a` supplies `Every seed grew.` at UTF-16 offset 0. The original `study` has `exact_match`; `correction` has `offset_mismatch`.
- Citation `syndication-b` supplies the same quote with no offset. Both retained items have `exact_match`, including offset 55 inside the correction's sentence saying the earlier wording is withdrawn. Both entailment results remain `unknown`.
- The appendix is reference-only: quote check `unknown`. An unavailable citation target has no quote checks and unknown source identity/quote coverage.

This last correction is why a quote occurrence cannot certify claim support. Consumers must show the retained surrounding passage and the unknown entailment status alongside a match.

## Integration API

Import `sourceDependencyReport` from `src/lib/source-dependencies/report.ts` in a local/server consumer. The function validates unknown input and returns a detached, deterministic report:

```ts
const report = sourceDependencyReport({
  caseRecord, // Existing CaseRecord v1; no schema additions
  citations: [{
    id: 'citation-1',
    fromEvidenceId: 'article-evidence',
    targetUrl: 'https://source.example/paper#results',
    targetRole: 'primary', // Caller designation only
    claimId: 'claim-1', // Or null when no specific assertion is assigned
    quote: { text: 'Exact attributed wording.', start: 42 },
    // quote may be null; start may be null to search anywhere in retained text
  }],
});
```

Citation IDs must be unique and evidence/claim references must exist in the supplied case. Invalid inputs throw before a report is returned. A citation is caller-supplied structured data, not proof that a hyperlink exists in the source document. `citationExistence` describes its presence in the supplied input; `documentCitationExistence` stays unknown. Source identity means conservative URL-key equality, not authenticated authorship or original publication.

The inquiry envelope in `src/lib/inquiries/model.ts` remains unchanged. A consumer can pass the inquiry's current case from its collection and maintain citation inputs alongside it. This report does not create findings, modify inquiry state, refresh finding bindings, or certify an existing finding. Citation input persistence and UI integration are not implemented here.

### Report fields

- `retainedEvidence`: full parsed evidence snapshots, including content, attribution, dates and provenance. Display the target passage using the corresponding evidence ID.
- `evidenceBindings`: SHA-256 of each parsed evidence snapshot. A correction changes its binding, even if its evidence ID stays the same. This is change detection, not a signature or authenticity guarantee.
- `sources`: URL keys and matched evidence IDs. Different retained snapshots at the same URL stay individually visible.
- `citationChecks`: original supplied link, optional claim, source identity basis, per-target quote results, and unknown entailment. Search snippets and classification context retain their attribution labels.
- `sharedCitations`: two or more distinct evidence IDs with citations to the same supplied target. Multiple citations from just one item do not create a group.
- `duplicatePassages`: exact equality of the entire retained text field, including whitespace and case. Even short identical passages are observations only; they carry no strength or copying score.
- `independence` and `limits`: unknown independent-source count and the report's explicit boundaries.

Quote results are `exact_match`, `offset_mismatch`, `not_found_in_retained_passage` (an unrestricted exact search failed), or `unknown` (no attributed quote or retained text). A failed check is only about this retained excerpt/offset, never a claim about the complete source. Offsets count UTF-16 code units as JavaScript `slice` does. A missing quote is not contradiction detection.

Every assessment has an observed/inferred/unknown basis. Observed means directly computed from supplied data, not independently verified in the world. Common-source reliance is a possibility, not a proved causal link. Citation links may be incidental, critical, or refer only to an unrelated assertion.

### Stable identifiers and source corrections

Source IDs hash the normalized URL key. Shared-citation IDs hash case ID, URL key and sorted evidence IDs; duplicate IDs also include the exact passage digest. Citation-check IDs bind case ID and the caller's citation ID. These are stable logical IDs, not immutable report revisions. Compare `caseRevision` and evidence bindings when displaying saved results, and recompute after corrections. Input list order does not affect output order or IDs.

URL normalization uses the platform URL parser and removes fragments. Scheme, path and query remain significant; tracking parameters are not stripped. No redirects, aliases, canonical links, ownership, publication order, or source authenticity are resolved. Same URLs can change over time; different URLs can identify the same work. Do not group by domain or promote unmatched items to independent sources.

## Verification and limits

`src/lib/source-dependencies/report.test.ts` runs the actual compiled CLI and compares its output with the API. Synthetic cases exercise shared primary citations, same-domain separate documents, different-domain exact duplicates, translated possible copying, contradictory quote context, corrections, missing text, malformed inputs, stable IDs, binding changes, literal whitespace/case, and a held-out negated snippet with UTF-16 offsets. These tests verify deterministic behavior, not live-source accuracy or a validated semantic entailment model.

No partial-overlap, paraphrase, translation, semantic contradiction, dependency direction, real-world independence, or truth inference is implemented. No automatic responses or rebuttal strategy are generated.

For this local change, typecheck and all 41 ordinary test files passed: 979 tests passed and 17 existing tests were skipped, with `VIDEO_REQUIRE_FFMPEG=1`. The ten source-dependency tests include the compiled consumer CLI. A production-build attempt was blocked because it triggered registry access outside the no-network authorization; it was not retried. Production build success is not claimed.
