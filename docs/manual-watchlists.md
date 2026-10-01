# Manual cases, watchlists and claim families

This local CLI imports complete saved case snapshots. It does not search websites, schedule monitoring, call providers, send notifications, judge truth, or suggest a response. The supplied examples are synthetic, independently authored fixtures.

## Try a correction

Use Node 20 or newer and the repository's existing dependencies. From the repository root:

```sh
npm run watchlists -- /tmp/contexttrail-demo.json scripts/fixtures/watchlists/initial.json
npm run watchlists -- /tmp/contexttrail-demo.json scripts/fixtures/watchlists/correction.json
npm run watchlists -- /tmp/contexttrail-demo.json scripts/fixtures/watchlists/correction.json
npm run watchlists -- /tmp/contexttrail-demo.json --show
```

Use a fresh state filename if a prior demo already exists. The first call reports supplied evidence. The second exposes the source's initial reopening statement alongside its correction, the changed support assessment, and a family link requiring review. The third returns no notices. Output is JSON so a reviewer can inspect the exact text, provenance and uncertainty or another local application can render them. The reusable application entry point is `applyUpdates(collection, request)` in `src/lib/watchlists/collection.ts`; it parses both unknown inputs and returns detached state.

## Input contract

Requests contain `watchlists`, `familyLinks` and `updates` arrays. See the two runnable fixture files for complete valid inputs. Every collection and request is bounded to 1000 items per array. A collection has a version, current cases, prior case snapshots, watchlists, and evidence-bound family links. Unsupported versions fail explicitly.

Watchlists require an ID, a public-topic, public-organization, product, incident, or research-question scope with a label and description, literal phrases, and exact source hostnames. Host matching excludes subdomains unless explicitly listed. Matching uses normalized whole phrases in evidence titles and quoted text, with any phrase sufficient. It examines only evidence marked `public_reference`. It does not assert that a host is public or that the operator has correctly identified a public organization. The caller owns scope review; private-person targeting is outside this feature. Research-question scopes are labels, not factual claims or verdicts.

A snapshot includes a validated `contexttrail-case-v1` record and a removal declaration. IDs identify evidence across revisions; changed IDs are separate supplied items, never inferred independent confirmations. Reprocessing an identical case revision is a no-op. A different payload at the same revision, an older revision, or changed creation time is rejected. Use a higher revision for changes. All updates in a request are applied transactionally in memory before any state write. Earlier snapshots remain in `caseHistory`.

Added, changed and explicitly removed evidence are compared by stable ID and deterministic content digest. Quotes, titles, source URLs, reported publication dates, content hashes, rights, media locations and referenced media durations are material. Capture/retrieval bookkeeping and tool-version changes alone do not produce evidence-change notices. They remain in the saved snapshot. A notice includes full old and new evidence records and supplied relation changes; a source-assessed challenge is not a final claim judgment. Affected relation IDs identify interpretations needing review. Unchanged relations whose evidence or claim wording changed also persist in `relationReviewRequired` across later no-op updates, until the relation is removed or its assessment is revised. Consumers must show this review status rather than treating the unchanged relation as current. Matching either the old or new evidence catches corrections that remove the watched phrase.

A missing item does not establish that a website deleted it. The snapshot must declare `removal: { "status": "confirmed", "reason": "..." }` before it can remove evidence from the saved case. Normal imports use `not_confirmed`. A failed fetch instead uses `{ "kind": "retrieval_failed", "caseId": "...", "reason": "..." }`, which preserves all saved evidence and returns a failure without a deletion notice.

## Family review

A family link explicitly connects two existing claims and cites existing evidence, including cross-case references. Operators supply a paraphrase, translation or contradiction relationship. `reviewed` assessments record a reviewer and rationale; `inferred` assessments record a method and rationale. Neither label verifies accuracy. No links are generated from wording similarity. A contradiction keeps both original assertions side by side; it never merges their meanings. The model makes no copying, coordination, source-origin, or response recommendation.

Saved links bind the claim text, language and supporting evidence content at review time. Changes or missing references produce `needs_review`; `current` means the content bindings still match, not that the relation is true. Replaying an identical link cannot clear a stale warning. To record a new assessment, submit the same link ID with updated assessment text describing the review. Retain the review reason. Family views expose the original wording, link uncertainty and exact current supporting evidence. The prior case snapshots preserve source changes; this increment does not provide a full history of watchlist or family-link edits.

## Local storage and interrupted writes

The CLI writes only its specified state file and adjacent temporary/lock files. State and the latest report are one JSON envelope. A same-directory atomic rename replaces the prior state only after validation and file flush. The exclusive lock refuses concurrent writers. No secrets, provider allowance files, media bytes or network endpoints are accessed.

After a process or machine interruption, `--show` can recover the saved report without applying anything. A leftover `.lock` or `.tmp` intentionally blocks another write. Confirm no writer is running, preserve the state and temporary files for inspection, then remove the stale lock/temporary file yourself before retrying the same input. Atomic replacement protects the old state from partial JSON; it is not a multi-user database or a backup. Directory-level power-loss durability, authentication, hosted storage, unbounded history and scheduled delivery are outside this CLI.

The latest report is replaced by the next successful call, including a no-op replay. Save output separately if every run's report is required. Notices describe this request's state transitions only. A watchlist added after cases were imported does not replay historical evidence automatically. State imports cannot prove source authenticity or prevent an operator from editing local JSON.

## Verification

`npm run typecheck`, `npm test`, and `npm run build` cover the repository. The watchlist tests use saved JSON fixtures and an actual compiled CLI subprocess, verify correction output and recovery inspection, duplicate suppression after restart, failed updates, writer-lock refusal, revision conflicts, publication-date changes, literal matching, and review uncertainty. No live-source quality or semantic matching accuracy is claimed.
