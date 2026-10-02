# Versioned claim cases

Completed image investigations now include an optional `caseRecord`. Existing result fields, status policy and session-storage format are unchanged. Older results without the field remain usable.

```ts
const projection = readCaseFromResult(completedResult);
if (projection.status === 'available') {
  const caseRecord = projection.caseRecord;
  // Render or export the validated case.
}
```

`readCaseFromResult` returns `absent` for legacy results and `invalid` for a malformed or unsupported case. Neither outcome invalidates the original report. If stricter case validation rejects otherwise usable legacy provider metadata during a new run, the completed image report carries `caseProjectionError: "invalid_source_result"` and no case. The selector reports this as `invalid`; the investigation still completes. `parseCaseRecord` throws a path-specific `CaseValidationError` at an import boundary. It reconstructs accepted fields, dropping unrecognized optional fields; unsupported schema versions fail explicitly.

## Contract

`src/lib/cases/model.ts` owns the `contexttrail-case-v1` contract. `parse.ts` validates imported JSON, IDs, graph references, source URLs, dates and media spans without network access.

- A case has a stable ID, a positive revision, a creation timestamp and explicit partial or unknown coverage
- Text claims remain separate from image, video and audio assets. Trace-only investigations may have no claims
- Assets contain URL references or an explicit `not_retained` location. They never contain media bytes. Video and audio may have an unknown duration
- Timed evidence and occurrences use a start offset plus positive duration in milliseconds. Images accept only whole-asset spans; known media duration bounds every timed span
- Evidence holds source-attributed text, a media span or a reference without a quote. Claims, occurrences and relations refer to actual IDs in the same case
- Relations describe evidence-to-claim, claim-to-claim and occurrence-to-occurrence connections. Assessments are observed, inferred or unknown. Observed and inferred assessments require supporting evidence; inferred assessments also require a rationale
- A similarity relation cannot be an observed transmission link. The image adapter emits no repost, quotation, copying or source-link edges
- Publication dates preserve source, precision and uncertainty. Case creation, source retrieval and capture times remain separate. A reported publication date does not prove the date of an event
- Provenance records method, tool version when known, rights status, retention mode and an optional SHA-256 digest. A public URL does not establish retention permission

The schema validates structure and internal consistency. It cannot verify that source content is accurate or that an operator's `observed` assessment is warranted. Review and source-specific acquisition remain separate work.

## Image adapter

`caseFromImageInvestigation` projects the existing result after the image policy has run. The investigation ID becomes the case ID. It preserves search counts and existing limitation codes, adds a claim only in claim-check mode, and keeps original publication unknown.

Source-linked model findings become inferred claim relations with the model version. A displayed quote remains context, with no new claim that the quote entails the finding. Provider or local-verifier media identity is also marked inferred in this projection; unverified visual leads remain unknown. Contextual pages do not become media occurrences. No legacy policy eligibility or verdict changes.

Date values from page metadata remain reported observations; dates resolved from search metadata remain inferred. A legacy disputed date stays disputed. Historical rejected date candidates lack per-candidate source binding, so the adapter does not invent one; the original result retains those details. Quotes and claims are never silently truncated. Oversized text makes the case projection unavailable while preserving the image report. Unrepresentable source references are omitted with an explicit limitation and `omittedEvidenceCount`; the original report is unchanged. Source retrieval timestamps remain available, while unknown capture times stay null. Audit URLs omit credentials, query and fragment, matching the source-linked report convention. The original source links remain in the legacy report.

The adapter stores no submitted image bytes or provider upload URL. It performs no additional retrieval, processing, model calls or storage writes. Video/audio ingestion, case editing, durable persistence, collaboration and review UI are separate increments.

## Design choice

The first alternative was to replace `InvestigationResult` with a case and migrate every report and cached result. That couples the new domain to an immediate UI and storage migration. This PR instead adds a validated projection after existing policy, keeping the case independent of image-only types and placing the translation in one adapter. Existing report readers can adopt it individually.

## Verification

Run `npm run typecheck`, `npm test` and `npm run build`. `src/lib/cases/cases.test.ts` exercises the multimedia contract, malformed imports, adapter semantics and both old/new session restoration. The real-orchestrator tests also validate emitted cases and unchanged provider-call limits. All inputs are synthetic; these checks establish software behavior, not live evidence accuracy.
