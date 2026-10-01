# Local research application service

This service connects the existing inquiry, case, and supplied-source-dependency modules through a persistent HTTP contract. It is ready for a later approved interface. No page, style, control, or visual proposal is added. Existing image investigation routes and result caches are unchanged.

It is a manual, single-user local service. It does not search, fetch a supplied URL, call a provider, analyze a video, transcribe audio, decide truth or entailment, or run monitoring. Supplied image, video and audio records are references. Timed findings preserve a reviewer's supplied millisecond segment; this is not evidence that playback or decoding occurred. Exact image-region and table-cell anchors remain unimplemented.

## Run

Use the repository's existing dependency and build instructions. Do not rebuild inside a checkout with a running Next server.

```sh
npm run build
CONTEXTTRAIL_RESEARCH_LOCAL=1 \
CONTEXTTRAIL_RESEARCH_DATA_DIR=/absolute/path/to/local-case-directory \
  npm start -- -H 127.0.0.1 -p 3119
```

The route is disabled unless `CONTEXTTRAIL_RESEARCH_LOCAL=1`. The data directory defaults to `data/research` under the server's working directory and is already gitignored. The service must be bound to loopback. It rejects non-loopback request hosts and cross-origin browser requests. This is not an authentication or tenant-isolation system. Do not expose it through a public host or reverse proxy, and do not use an ephemeral deployment filesystem as durable storage. Hosted use needs a reviewed account/storage boundary.

No provider variables or credentials are required. Do not add them for this workflow. The existing image-investigation provider gate remains separate.

## HTTP contract

Every response has `Cache-Control: no-store`. POST bodies require `application/json`; the body and saved case each have a 5 MiB limit. Invalid edits leave the last committed document unchanged. Reuse an operation ID only for an exact retry of that operation, including its original expected revision.

- `GET /api/research`: `{ "cases": [{ "caseId", "question", "revision", "createdAt" }] }`
- `GET /api/research?caseId=<URL-encoded-id>`: the saved document plus recomputed findings and dependency report
- `POST /api/research`: create or update as shown below; returns the same review shape as a case GET

The response is:

```ts
{
  document: {
    schemaVersion: 'contexttrail-research-v1',
    revision: number,
    workspace: InquiryWorkspace,
    citations: SuppliedCitation[],
    applied: Array<{ operationId: string; digest: string }>
  },
  findings: ReturnType<typeof findingViews>,
  dependencies: SourceDependencyReport
}
```

`document.revision` is the optimistic-write revision, including citation-only changes. `workspace.revision` and the current CaseRecord's revision retain their existing meanings. Do not substitute either for `document.revision` in an update.

The new outer envelope preserves the existing `contexttrail-inquiry-v1` and `contexttrail-case-v1` contracts unchanged. Questions stay distinct from assertions; creating a question produces an empty claims list. Findings retain their source-statement/operator-inference label, reviewer and rationale. Reports and review status are recomputed from persisted inputs rather than trusted cached display flags.

### Start a case

```json
{
  "kind": "start",
  "operationId": "create-unique-id",
  "question": "What explains this change, and what remains uncertain?",
  "createdAt": "2026-10-01T00:00:00.000Z"
}
```

The response supplies the inquiry ID and case ID. Keep both rather than recreating their representation in a client. A repeated creation operation returns the current saved case without creating a duplicate. Reusing it with a different question or creation time returns a conflict. Creation IDs are reserved against every update kind too.

### Update a case

```json
{
  "kind": "update",
  "caseId": "<returned case ID>",
  "operationId": "edit-unique-id",
  "expectedRevision": 1,
  "change": {
    "kind": "subquestion",
    "value": {
      "kind": "subquestion",
      "id": "question-2",
      "question": "Which explanation would this evidence distinguish?"
    }
  }
}
```

Supported changes use the existing domain types. See the exported `ResearchApplicationRequest` and `ResearchChange` types for the complete application contract.

| Change kind | Value | Behavior |
| --- | --- | --- |
| `subquestion` | `Subquestion` | Upsert by ID; retain research history |
| `hypothesis` | `Hypothesis` | Upsert a candidate explanation bound to the root question or a subquestion |
| `evidence` | `CaseEvidence`, plus `assets: MediaAsset[]` | Add or replace that evidence ID and supplied asset IDs through a new validated case snapshot; retain previous case history |
| `finding` | `Finding` | Preserve the exact anchor and assessment; reject missing or nonmatching evidence |
| `citation` | `SuppliedCitation` | Add or replace a supplied citation ID, save the inputs and recompute dependency flags |

Evidence includes its source URL, retained content or media reference, publication-date observation and provenance. A manual excerpt must keep its actual attribution. Do not relabel a search snippet as a page quote. The service does not fetch any supplied URL. Media bytes are not stored by this endpoint.

A text finding uses the existing anchor `{ "kind": "text", "start": 0, "quote": "Exact retained wording" }`. Offsets count UTF-16 code units and matching is case-sensitive. The quote must exactly match the retained passage at that offset.

A timed finding uses `{ "kind": "time", "startMs": 1200, "durationMs": 500 }`. It must lie inside the retained evidence span and, when supplied, the asset's duration. A whole-media anchor requires a known duration. Image-only evidence cannot acquire a timed finding.

Findings require at least one support entry and a valid root/subquestion ID. They do not bind directly to hypothesis IDs. Example:

```json
{
  "kind": "finding",
  "value": {
    "kind": "finding",
    "id": "finding-1",
    "questionId": "<root or subquestion ID>",
    "text": "The supplied source reports this date.",
    "assessment": {
      "kind": "source_statement",
      "reviewer": "Reviewer name",
      "rationale": "Exact wording retained; the event date remains unverified."
    },
    "support": [{
      "evidenceId": "evidence-1",
      "relationship": "context",
      "anchor": { "kind": "text", "start": 0, "quote": "Exact retained wording" }
    }]
  }
}
```

### Supplied dependencies and quote checks

Citations are supplied records, not verified hyperlinks in a retrieved document. The complete shape remains `SuppliedCitation` in `src/lib/source-dependencies/report.ts`, including `fromEvidenceId`, `targetUrl`, caller-supplied `targetRole`, optional `claimId`, and optional exact quote with an optional offset.

The response exposes common supplied citation targets, identical retained passages, quote matches or mismatches, retained target context, and the observed/inferred/unknown basis. Citation inputs survive reopen and server restart. Every report is bound to the current case revision and evidence snapshots.

Show these limits next to any future interface display:

- Distinct URLs or domains do not establish independent corroboration
- Shared citations indicate possible common-source reliance; the source document's actual links were not inspected
- Exact quote occurrence does not establish entailment or truth
- A missing quote is a result about the retained passage, not the whole source
- A caller-supplied primary designation remains unverified

### Corrections and history

To correct retained evidence, submit `evidence` with the same evidence ID and corrected content/provenance. The original case snapshot is preserved in `workspace.collection.caseHistory`. Prior finding anchors remain unchanged. A changed content binding yields `needs_review`, and citation quote checks recompute against the new passage.

Resending an identical finding cannot erase its stale-source warning. A revised finding needs a changed review rationale and an exact anchor in the current evidence. Changes to asset locations, durations or content hashes can also invalidate affected bindings. This service has no delete operation, root-question editor or additional correction-note schema; it preserves the existing contracts rather than inventing those features.

## Save, retry and interruption behavior

Each case has its own lock and storage file. IDs are hashed into filenames; callers cannot select a path through case IDs. The service reads and checks the current revision while holding an exclusive writer lock, writes a same-directory temporary file, flushes it, renames it atomically, then flushes the directory. Saved files are created with mode 0600 and the directory with 0700, subject to the local filesystem's semantics.

Concurrent updates cannot silently overwrite each other. One may receive `CASE_BUSY`; a stale writer receives `REVISION_CONFLICT`. The client should reopen and reconcile. It must not automatically change its expected revision and resend an unreviewed edit.

If a response is lost after commit, repeat the exact operation ID and payload. The saved operation digest makes that retry a no-op, including after newer operations. GET returns the latest committed case without acquiring a writer lock.

A leftover `.lock` or `.tmp` file blocks writes rather than being silently removed. Preserve both, stop and verify the original process, then inspect the committed JSON through GET and the temporary file before any deliberate recovery. This implementation does not automatically recover stale locks, repair corrupt files, provide backups, or promise durability on network/ephemeral filesystems. Existing incompatible saved versions are reported without rewriting them.

Errors have `{ "error": "human-readable detail", "code": "machine-readable code" }`:

- 400 `INVALID_INPUT`: malformed or incompatible input, bad exact anchor, unsupported version
- 403 `LOCAL_ONLY` / `ORIGIN_REJECTED`: host/origin not permitted
- 404 `NOT_FOUND`: missing case
- 409 `REVISION_CONFLICT` / `OPERATION_CONFLICT` / `CASE_BUSY` / `RECOVERY_REQUIRED`: reconcile or inspect before retrying
- 413 `REQUEST_TOO_LARGE` / `STATE_TOO_LARGE`: preserve the original case and shorten the operation
- 415 `CONTENT_TYPE`: JSON required
- 500 `STORAGE_ERROR`: reopen to establish whether a write committed before retrying
- 503 `LOCAL_SERVICE_DISABLED`: opt-in local service is off

## Reproduce the real HTTP/disk verification

```sh
npm run typecheck
VIDEO_REQUIRE_FFMPEG=1 npm test
npm run build
npm run research:verify
```

The last command starts and stops its own loopback production servers, supplies synthetic evidence, makes real HTTP requests, compares the actual saved JSON, and restarts the server to establish persistence. It runs with a minimal environment that omits provider credentials. It retains its reports, synthetic case data and server log under `.verify/research-http-<timestamp>/`. It never touches a separately running interactive server.

The check covers exact text and time bindings, rejected invalid anchors, retries after a discarded response, dependency flags and citation persistence, corrections and stale review status, conflicting and concurrent updates, restart/reopen, and explicitly synthetic interrupted-writer markers. It labels the evidence as local supplied-data behavior. It does not prove live-source accuracy, provider-backed research, production multi-user storage, or an approved frontend journey. No screenshots are needed because this change has no UI.
