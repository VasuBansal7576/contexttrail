# Local open-question investigations

The inquiry workspace adds an open question and a reviewed evidence ledger around existing version-1 cases. It does not convert a question into a factual assertion or choose a true/false verdict. Every supplied fixture is synthetic and independently authored. No website retrieval, model analysis, scheduling, response advice, or provider call occurs.

The [local research application service](research-application-service.md) connects this same domain workflow to validated HTTP routes, persistent case files and supplied source-dependency reports. It adds no interface or automatic retrieval.

## Run the complete journey

Use the existing dependencies and Node 20 or newer. Choose a new state filename.

```sh
npm run inquiries -- /tmp/contexttrail-inquiry.json scripts/fixtures/inquiries/start.json
npm run inquiries -- /tmp/contexttrail-inquiry.json scripts/fixtures/inquiries/evidence.json
npm run inquiries -- /tmp/contexttrail-inquiry.json scripts/fixtures/inquiries/correction.json
npm run inquiries -- /tmp/contexttrail-inquiry.json scripts/fixtures/inquiries/correction.json
npm run inquiries -- /tmp/contexttrail-inquiry.json --show
```

1. The start request saves a question and an empty CaseRecord v1. Its assertions list is empty.
2. The evidence request supplies two distinct source assertions, a subquestion, a tentative hypothesis, and an operator-entered finding. The finding cites the exact retained phrase `Harbor Bridge reopened on Monday` at offset zero. The complete source excerpt, URL, dates, and provenance remain accessible alongside that anchor.
3. The correction supplies a new case snapshot. The change report shows the previous and corrected evidence. The old finding stays visible with `needs_review`; its evidence anchor stays unchanged so the earlier assessment is inspectable.
4. Replaying the same operation produces no new notices or revisions. A different payload using the same operation ID fails.
5. `--show` reloads and validates the saved workspace and recomputes finding review status. It does not rely on a cached display flag.

The fictional bridge example illustrates an open-ended inquiry. Topics are not limited to news, brands, infrastructure, or claim checking. No government-customer targeting is part of this implementation.

## Consumer contract

`src/lib/inquiries/model.ts` owns the new `contexttrail-inquiry-v1` envelope. `CaseRecord`, its parser, existing image report, and image cache schema remain unchanged. Older CaseRecord v1 files still use the existing collection import path. Do not add inquiry fields directly to CaseRecord v1 because its parser deliberately drops unknown optional fields.

- `Inquiry` identifies the root question and its saved case
- `Subquestion` asks another question within that inquiry
- `Hypothesis` is a tentative explanation attached to a question, with no claim of evidentiary support
- `Finding` records a source statement or operator inference, attached to an existing question. Its reviewer and rationale are mandatory
- `FindingSupport` binds an evidence ID, a supports/challenges/context relationship, and an exact retained text or timed-media anchor
- `SavedFinding` also stores the evidence digest from the assessment. Digest agreement means the content is unchanged, not that the evidence entails the finding
- Existing case `claims` continue to represent assertions, including competing assertions. An inquiry, hypothesis, or finding is never silently inserted there

Text anchors use UTF-16 offsets, as JavaScript `slice` does. Their quote must exactly match the retained text, which may be a partial excerpt. Timed anchors use start plus positive duration in milliseconds and must fit the evidence span and known parent duration. A whole-media reference with unknown duration cannot establish a bounded timed finding. URL-only citations are insufficient for a finding. The separate [v2 retained-material extension](precise-evidence-anchors.md) adds PNG image regions and table-cell coordinates while preserving v1 files and CaseRecord v1.

The reusable server/local API is `applyInquiry(workspaceOrNull, request)` in `workspace.ts`. It validates unknown inputs and returns detached state, change notices, retrieval failures, and finding views. `parseWorkspace` validates restoration. `findingViews` provides current evidence and its source metadata next to the original anchor. Consumers must show its `current`, `changed`, or `unavailable` support status and `needs_review` finding status. They can navigate backward by filtering finding supports for an evidence ID in the inquiry's case.

An update accepts the existing `UpdateRequest` under `caseUpdates` plus upsert arrays for subquestions, hypotheses, and findings. Empty arrays leave those entities unchanged. Expected workspace revision prevents stale writers. Operation IDs are immutable idempotency keys. Replaying an old operation after later updates is still a no-op and displays the current workspace, never rewinds it. Changing an existing finding requires a changed review rationale; submitting it unchanged cannot refresh its content bindings. Explicit entity removal and root-question editing are not implemented yet.

Case snapshots retain their own revisions and evidence history. Research revisions retain the previous questions, hypotheses and bound findings. A failed retrieval preserves the prior evidence; missing evidence needs a confirmed removal declaration through the existing collection contract. A confirmed removal leaves a finding's original anchor visible and marks its support unavailable. History and operation arrays are bounded to 1000 entries; exceeding a bound fails before persistence instead of pruning history silently.

## Persistence and limits

State and the latest report share one JSON file. The CLI holds an exclusive adjacent writer lock, validates before writing, flushes a same-directory temporary file, then renames it atomically. A failed validation leaves prior state unchanged. A stale lock or temporary file blocks another write; preserve the files and confirm the original writer stopped before manual recovery. This is a single-user local file workflow, not a hosted database. Directory-level power-loss durability and backups remain outside this implementation.

The latest report is replaced on every successful call, including a replay. Case and research history remain in the workspace. Use `--show` after interruption to inspect what committed. Raw imported JSON can be edited by its owner; the schema is not an authenticity signature.

Automated research remains an explicit future integration. A provider adapter must return candidate evidence and proposed assessments for review, enforce authorized source and cost boundaries, preserve exact evidence spans, and obtain the permissions needed for retrieval or transmission. No provider implementation is registered here. Manual hypotheses do not claim an LLM-generated plan, and content matching is not automatic truth assessment.

## Verification

`npm run typecheck`, `VIDEO_REQUIRE_FFMPEG=1 npm test`, and `npm run build` cover the integrated code. Functional tests exercise actual CLI compilation and independent processes, saved-state reload, corrections, idempotency, rejected conflicting writes, exact-text checks, bounded timed spans, missing sources, and unchanged finding resubmission. Existing image/cache regression tests and real synthetic MP4/WebM extraction remain in the suite. No live-source accuracy, production decoder isolation, or legal launch clearance is established by these checks.

The repository's current `npm run lint` opens the first-time ESLint configuration prompt and exits without linting in a noninteractive run. No lint configuration or dependencies were installed for this change. Typechecking, tests, and the production build are separate checks and do not substitute for lint.
