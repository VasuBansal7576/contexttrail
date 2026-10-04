# Live usage and zero-budget operation

## Default behavior

The upload screen also offers **Try NASA's public Earthrise image**. This
reviewed catalogue choice searches NASA's existing image URL; it never calls
the Image API and never publishes a private upload. An **Already-public image URL**
input also accepts HTTPS JPEG, PNG and WebP URLs without credentials, query
parameters or custom ports. Before provider search, ContextTrail reads the
image through the same public-IP/DNS validation, pinned connection, redirect,
five-second deadline and 2 MB boundary as source-page reads. Google fetches the
public URL on its own infrastructure; ContextTrail cannot pin Google's socket.
Public-image runs reserve zero upload attempts; setting the approved
upload cap to zero also prevents an uploaded-image run from being admitted.
Search, Jev request/question, deep-read and adaptive ceilings stay unchanged.

Google discontinued Lens `about_this_image`; ContextTrail no longer dispatches
that request. Supported Lens all/exact results, claim web/news searches,
optional bounded expansion and inspected source pages still feed the evidence
timeline. The result explicitly reports this lost surface. Dates are observed
source dates, not proof of the original photograph's publication.

The [supported Lens parameters](https://serpapi.com/google-lens-api),
[NASA source and credit](https://www.nasa.gov/image-article/earthrise-by-nasa-astronaut-bill-anders/),
and [NASA media guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/)
document this public route. The local preview is a resized reproduction of the
same photograph; the provider searches NASA's original public asset.

Live investigations are disabled unless the server is explicitly enabled.
A keyless preview can show the interface and honest configuration failures.
Normal tests use controlled transports and do not contact providers.

The usage gate does not query provider balances and cannot prove that a request
is free. Before enabling live use, the operator must verify remaining free
allowances, their billing units and expiration, and that provider-side billing
cannot exceed the approved zero-dollar budget. Leave live use disabled if any
of those facts are unknown. Never put credentials into chat, source control,
browser-visible configuration, screenshots or video.

## Supported execution

The current gate supports one operator-controlled host with one persistent
local ledger shared by every ContextTrail process on that host. It permits one
live investigation at a time. Filesystem paths and an environment attestation
cannot prove that a disk survives replacement; the operator must establish
that property.

Vercel and known serverless environments fail closed. Multiple hosts with
independent disks are unsupported. A hosted live endpoint needs a reviewed,
shared, durable atomic quota store before this restriction can change. A keyless deployment cannot demonstrate live provider utility; hosted scheduling and account isolation remain separate acceptance work.

## Server-only configuration

No browser request can choose these values.

| Variable | Required value or meaning |
| --- | --- |
| `CONTEXTTRAIL_LIVE_ENABLED` | Exact `true` to request live operation; omit or keep `false` for preview |
| `CONTEXTTRAIL_LIVE_DEPLOYMENT` | Exact `single-host-persistent`, only when accurate |
| `CONTEXTTRAIL_FREE_ALLOWANCE_ACKNOWLEDGED` | Exact `true` only after the operator verifies the free allocation and billing boundaries |
| `CONTEXTTRAIL_USAGE_LEDGER_PATH` | Absolute normalized path to an existing ledger on persistent local storage |
| `CONTEXTTRAIL_FREE_ALLOWANCE_PERIOD` | Operator-chosen allocation identifier; it never resets automatically |
| `CONTEXTTRAIL_FREE_SERPAPI_SEARCHES` | Finite nonnegative integer cap for search attempts |
| `CONTEXTTRAIL_FREE_SERPAPI_UPLOADS` | Finite nonnegative integer cap for upload attempts |
| `CONTEXTTRAIL_FREE_JEV_REQUESTS` | Finite nonnegative integer cap for Jev requests |
| `CONTEXTTRAIL_FREE_JEV_QUESTIONS` | Finite nonnegative integer cap for Jev questions |
| `SERPAPI_API_KEY` | Existing authorized server credential, entered through a secure local/deployment mechanism |
| `TYPESAFE_API_KEY` | Existing authorized server credential, entered through a secure local/deployment mechanism |
| `TYPESAFE_MODEL` | Omit or use `jev-1.13.0`; other model overrides are rejected |

Request and question limits are separate because a Jev request may contain
multiple questions. If a provider's free allowance is defined in different
units that these controls do not bound, live use must remain disabled.

## Initialize once, offline

After verifying the allocation, create an operator-owned persistent directory
outside the repository. Set its path, allocation identifier and approved caps
in the server environment. Keep live use disabled during setup.

Run `node scripts/init-live-usage-ledger.mjs` in that environment. It creates a
new ledger exclusively and refuses to replace an existing file. It reads no
API keys and makes no network request. It does not create a provider account,
verify a balance or enable billing.

There is no automatic reset, rollover, refund or stale-lock cleanup. An
existing ledger must match the exact configured period, model and effective caps.
Changing those settings cannot reset the recorded usage. Missing, malformed,
partial or inconsistent state prevents provider calls.

An explicitly authorized additional public-image trial can extend the same
ledger without resetting its reservations. Keep live access off, verify the
additional free allowance, set the **cumulative** caps, and set
`CONTEXTTRAIL_ALLOWANCE_GRANT` to the additional public claim allocation
`{"searches":6,"uploads":0,"jevRequests":60,"jevQuestions":272}` (or public trace
`{"searches":4,"uploads":0,"jevRequests":60,"jevQuestions":113}`). Set
`CONTEXTTRAIL_ALLOWANCE_GRANT_REASON` to a short audit identifier and run
`node scripts/grant-live-allowance.mjs`. It acquires the shared lock, validates
the old journal, and appends one grant. The original header and every spent
reservation remain unchanged; rerunning the same grant fails rather than
raising caps again. This script never contacts providers or enables live use.

## Conservative reservation

Before any provider dispatch, each admitted run durably reserves its entire
worst-case allowance:

| Mode | Searches | Uploads | Jev requests | Jev questions |
| --- | ---: | ---: | ---: | ---: |
| Trace | 4 | 1 | 60 | 113 |
| Claim-check | 6 | 1 | 60 | 272 |

For the reviewed public image, uploads are **0**, with all other columns
unchanged. The retired About This Image slot is never repurposed or billed as
an attempt, and there is still at most one adaptive search. These remain
conservative maxima, not a promise that all historical occurrences can be found.

## Private existing-key setup and harmless verification

Run `node scripts/local-key-setup.mjs`. It binds an unused loopback port and
prints the form URL. The operator personally enters existing SerpApi and
TypeSafe keys in masked fields. Strict Host/Origin/nonce checks protect the
form; it streams a 16 KB body cap, writes an ignored `.env.local` exclusively
with mode 600, never displays/logs values, and leaves live use and allowance
acknowledgement false. It refuses to overwrite existing configuration.

After saving, `node --env-file=.env.local scripts/check-provider-auth.mjs`
uses only the documented SerpApi free Account GET and TypeSafe Models GET.
It prints individual authentication status and a whitelist of nonsecret plan
counters; never raw responses, keys, or credential-bearing URLs. This is not
a search/upload/inference test or a substitute for billing evidence.

Current [pinned Jev documentation](https://docs.typesafe.ai/models) specifies
$0.042 per million input tokens, output free and 64k context tokens/request.
Sixty accepted maximum-size requests therefore debit at most $0.16128 of
existing credit under that documented model contract. Verify account credit,
expiry, no auto-recharge and no paid overage before a trial; future pricing or
model changes invalidate this calculation. Never enlarge caps or replenish a
ledger merely to retry a demo.

The Jev ceiling covers up to 24 initial classifications, 24 adaptive
re-attempts of admitted candidates with missing judgments, five source-page
refinements and seven pairwise comparisons. These are ceilings, not expected
usage. Dispatch checks enforce the reservation too.

Failed and cancelled attempts retain the full reservation. This deliberately
understates the remaining free allowance. It avoids refunding work the
provider may already have charged. External uses of the same provider account
are not visible to this ledger; the operator must reserve for those separately.

## Failure and recovery

The exclusive lock lasts through provider work. A process crash or uncertain
write leaves the lock and reservation in place. A restart does not unlock or
replenish usage.

If live use is blocked, stop sending new requests. Inspect the recorded state
and provider usage through the authorized account. Reconcile any interrupted
run before an operator removes a stale lock or provisions a new allocation.
Never delete the ledger merely to make a demo run again.

These controls limit admitted work. They are not authentication, a public
abuse-prevention service or a provider billing guarantee. Do not expose a
key-backed unrestricted endpoint to the public.

## Automatic questions, video and watches

Questions, audio research and each watch check reserve 6 searches / 0 uploads / 12 Jev requests / 60 questions. An uploaded video reserves 24 / 3 / 192 / 876 with a caption, or 18 / 3 / 192 / 399 without one, including one separately reported spoken-source investigation. The entire reservation precedes provider dispatch; unused units are not automatically refunded. Identical samples are skipped and completed frame/speech results survive failure of the other part. Historical ledger entries retain their earlier allocations and are not reset or repriced. See automatic-investigation.md and automatic-watches.md.

A separately verified SerpApi balance can add exactly six searches with zero uploads, TypeSafe requests or TypeSafe questions. This search-only grant does not authorize a reduced-cost investigation: each subsequent run still reserves its full normal allocation from all remaining units. Prior reservations remain charged. The operator must verify the current free search balance before appending this grant.
