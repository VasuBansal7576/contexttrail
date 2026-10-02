# ContextTrail

Investigate where an image appeared, inspect the retrieved sources and dates, and compare
that evidence with a supplied caption. Questions and Video offer bounded automatic research;
the local casebook preserves sources, exact findings, corrections and saved reports.

## Revision and release status

The research application includes [PR #6](https://github.com/VasuBansal7576/contexttrail/pull/6),
[PR #7](https://github.com/VasuBansal7576/contexttrail/pull/7), and the repairs recorded in the
[issue index](docs/issue-followups-20261002.md). Historical counts and browser records belong
to their recorded revisions. Run the checks below on the revision you intend to review.

Offline verification checks contracts and interface behavior. It does not establish live
retrieval quality, an original upload, or a strong historical-reuse demonstration.
[Release and submission gates](docs/release.md) track that remaining work.

## Install and preview

Use Node.js 20 or newer and npm. CI uses Node 24. Native video ingestion and comparison
require FFmpeg and FFprobe on PATH.

```sh
npm ci
cp .env.example .env.local
npm run dev -- -H 127.0.0.1
```

The template disables live retrieval, local research storage and media decoding. No provider
keys are required for preview, tests, typecheck or build. Submitting an investigation with
live access disabled returns the actual configuration error. Production never substitutes a
fixture for a failed provider request.

For persistent local cases and supplied-media comparison, explicitly opt into the loopback
services. Use a persistent directory you control:

```sh
npm run build
CONTEXTTRAIL_RESEARCH_LOCAL=1 \
CONTEXTTRAIL_MEDIA_LOCAL=1 \
CONTEXTTRAIL_RESEARCH_DATA_DIR=/absolute/path/to/persistent/local-cases \
  npm start -- -H 127.0.0.1 -p 3119
```

Provider access remains disabled. Research storage is single-user and bound to loopback.
Do not rebuild a checkout while its Next.js server is running; use a separate worktree for
builds and browser verification.

| Entry | Input and behavior | Details |
| --- | --- | --- |
| `/investigate` | Image or reviewed public image URL, optional caption; Trace or Claim-check | [Live usage](docs/live-usage.md) |
| `/questions` | One topic/question; bounded retrieved evidence and claim-scoped report | [Automatic research](docs/automatic-investigation.md) |
| `/video` | One supplied video; research on one representative sampled frame | [Automatic research](docs/automatic-investigation.md) |
| `/compare` | Supplied still/video or video/video; local sampled-frame comparison | [Media bridge](docs/local-media-application.md) |
| `/casebook` | Saved cases, findings, retained material and correction history | [Casebook](docs/casebook-interface.md) |

## Verification

```sh
npm test
npm run typecheck
npm run build
```

There is no configured ESLint gate. The obsolete interactive `next lint` script has been
removed; the commands above are the maintained checks. CI verifies every pull request base,
including stacked integration branches, with live access disabled and native FFmpeg required.

After a production build, the local service contracts have additional offline checks:

```sh
npm run research:verify
node scripts/verify-media-http.mjs
node scripts/verify-casebook-ui.mjs
```

Read each script's documented options before running it. These exercise generated or controlled
evidence, not live providers. The image verification harness is at
`.agents/skills/verify-contexttrail/bin/control-contexttrail`. Its
[feature map](.agents/skills/verify-contexttrail/features/README.md) lists the maintained
landing, upload, investigation, result, viewer, session and accessibility drives. It snapshots
a pinned revision, owns its server, preserves artifacts and rejects unsupported drives.
`RUN_LIVE_TESTS=1` is a harness admission requirement, not an npm-test provider switch.

Keep source/unit, function-probe, real-UI, public-contract-boundary and live evidence distinct.
A controlled result is not a fact check, and a successful build is not release acceptance.

## Live configuration and bounds

Read [live usage](docs/live-usage.md) before enabling providers. Live operation requires
server-only `SERPAPI_API_KEY`, `TYPESAFE_API_KEY`, pinned `TYPESAFE_MODEL=jev-1.13.0`, explicit
single-host persistent deployment configuration, a durable existing usage ledger and an
operator-verified allocation. Keys alone are insufficient. Never commit `.env.local`.
Hosted/serverless live access currently fails closed.

| Workflow | Maximum search attempts | Upload attempts | Jev requests | Jev questions |
| --- | ---: | ---: | ---: | ---: |
| Image Trace | 4 | 1 | 60 | 113 |
| Image Claim-check | 6 | 1 | 60 | 272 |
| Topic | 3 | 0 | 8 | 40 |
| Representative video frame, no caption | 4 | 1 | 60 | 113 |
| Representative video frame, caption | 6 | 1 | 60 | 272 |

Reviewed public-image URLs use zero upload attempts. The retired Lens About This Image
surface is no longer dispatched or repurposed. At most one adaptive search and five source
page reads remain permitted. The full worst-case allowance is reserved before dispatch;
failures and cancellations do not refund it. Counts distinguish attempted, returned and
retained results. They do not represent independent sources or complete web coverage.

## Evidence and retention

Only provider-reported exact matches or accepted verified near matches can enter media history.
Near-match promotion remains disabled pending measured acceptance. Contextual pages and visual
leads stay separate. Unknown/disputed dates never become dated occurrences, and an article's
publication date is distinct from reported event time, filming time or original capture time.
Reporting-domain counts do not establish independent origins. Trace has no claim verdict.

Image uploads accept JPEG, PNG and WebP. Browser preprocessing caps the long edge at 1600 px
and targets 450 KB; the server rejects images over 500 KB. Processed input bytes stay in memory.
Image saves retain a validated evidence projection, not the full provider report or uploaded
image bytes. Topic saves retain their report and exact source bindings. Supplied-media comparison
saves retain checked sampled frames and the comparison report, never original videos.

Unsaved automatic results are lost on reload. Explicit video saves retain the complete bounded
report and its original evidence, excluding video and sampled image bytes. The historical viewer
opens exact retained text, image regions and table cells when a current source is missing or changed.
Read the [automatic retention contract](docs/automatic-investigation.md) and
[casebook documentation](docs/casebook-interface.md). Corrections preserve history and require
review; reopening does not rerun retrieval or renew an earlier finding's review.

## Source and design records

| Area | Location |
| --- | --- |
| Image executor, budgets, identity, dates and deterministic policy | `src/lib/investigation/` |
| Automatic research and local persistent service | `src/lib/research/` |
| Safe page acquisition/extraction | `src/lib/pages/` |
| Provider transports | `src/lib/serpapi/`, `src/lib/jev/` |
| Saved findings and material contracts | [Precise anchors](docs/precise-evidence-anchors.md) |
| Native matching evaluation | [Evaluation](docs/local-media-matching-evaluation.md) |
| Product specification | `contexttrail_master_product_ux_architecture_spec_v1.1.md` |

The cover's NASA Earthrise collage is illustrative. Its example captions are not retrieved
evidence. [Asset credits](docs/assets.md) records the source, font/reference gaps and provenance.
The supplied design reference has no established reuse permission. A project-wide software
license remains an owner decision. Do not infer a license from public repository visibility.

The [issue follow-up index](docs/issue-followups-20261002.md) distinguishes implemented work,
PR dependencies and pending acceptance for every open issue. Historical reports remain on GitHub.
