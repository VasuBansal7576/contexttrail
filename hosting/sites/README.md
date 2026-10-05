# ChatGPT Sites edition

This adapter projects the canonical ContextTrail UI and domain logic into the official Sites Vinext/Cloudflare Worker starter. It supports real question and image research, private casebooks, findings, source anchors, comparison history and manual watched-question checks. Provider results are never replaced with demo fixtures.

Native FFmpeg video decoding, local Whisper speech recognition, native media comparison and scheduled background watches remain features of the local Node application. The hosted UI explains those limits. Hosted source reads inspect HTML only; PDFs remain uninspected.

## Source and deployment

The existing Site identity lives in `.openai/hosting.json`. Reuse it; do not register a duplicate. Create an isolated Sites checkout with the official Sites starter and workflow, then project this repository into it:

```sh
node hosting/sites/prepare.mjs /absolute/path/to/contexttrail-public
cd /absolute/path/to/contexttrail-public
npm run install:ci
npm run typecheck
node /absolute/path/to/contexttrail/hosting/sites/tests/boundaries.mjs .
```

Use the Sites plugin's `build-site.mjs` and `site-workflow.mjs` to build, commit and push the exact source, then package its build output. Save the matching pushed SHA and archive with Sites, and deploy that saved version. The Worker manifest supplies logical `DB` (D1) and `FILES` (R2) bindings; `drizzle/` contains the migration. Sites applies packaged migrations during publication. Never use local Wrangler database IDs as production IDs.

`prepare.mjs` copies only application source, public assets and the adapter. It does not copy provider keys, local investigations, usage ledgers, uploads or native models. Its destination `src` and `public` are generated outputs; keep original edits in this repository. Start from the official starter so its required authentication and build helpers are present.

## Private runtime configuration

Store `SERPAPI_API_KEY` and `TYPESAFE_API_KEY` as secret Sites environment variables. They are consumed by the server and must never be placed in `NEXT_PUBLIC_*`, browser source, the hosting manifest, screenshots or Git. For local Worker tests only, use an ignored mode-0600 `.dev.vars`. Build artifacts must remain independent of its values.

Enable live operation only with these explicit non-secret settings:

- `TYPESAFE_MODEL=jev-1.13.0`
- `CONTEXTTRAIL_LIVE_ENABLED=true`
- `CONTEXTTRAIL_FREE_ALLOWANCE_ACKNOWLEDGED=true`
- `CONTEXTTRAIL_LIVE_DEPLOYMENT=sites-d1`
- `CONTEXTTRAIL_FREE_ALLOWANCE_PERIOD`: stable, operator-assigned allocation ID
- `CONTEXTTRAIL_FREE_SERPAPI_SEARCHES`, `CONTEXTTRAIL_FREE_SERPAPI_UPLOADS`, `CONTEXTTRAIL_FREE_JEV_REQUESTS`, `CONTEXTTRAIL_FREE_JEV_QUESTIONS`: verified bounded integer allocations
- `CONTEXTTRAIL_PUBLIC_ALLOWANCE_EXPIRES_AT`: explicit future UTC expiry before the provider allowance expires

The launch allocation is limited to 120 search attempts, 20 image upload attempts, 600 Jev requests and 3,000 Jev questions, expiring 18 October 2026. Each signed-in account has at most three admission attempts per UTC day. There is one active provider run across the Site. Failed, cancelled and abandoned runs keep their entire reserved worst-case charge; nothing is refunded. A crash can leave the run busy and requires operator reconciliation. Do not erase the ledger, change the period or raise caps to bypass exhaustion.

## Persistence and verification

D1 indexes cases by authenticated account ID and case ID. Private R2 objects retain immutable revisions; D1 atomically selects the current revision. Updates compare the previous object key, rejecting stale editors with HTTP 409. Reads and lists always bind the authenticated owner. Cases have a 5 MiB limit and each account may retain up to 100. Prior R2 revisions remain recovery copies; no public object URLs are returned.

The isolated Worker test exercises actual D1/R2 bindings: persistence, idempotent creation, concurrent edits, revision conflicts, account isolation, busy admission, daily/global quota exhaustion, no refunds, fail-closed configuration, and actual readable HTML passages. It never dispatches provider requests. Separately verify a real investigation and saved-case reload in the browser before releasing.
