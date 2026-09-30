# Live usage and zero-budget operation

## Default behavior

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
shared, durable atomic quota store before this restriction can change. The
Vercel deployment goal in the PRD remains open; a keyless deployment cannot
demonstrate live provider utility.

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
existing ledger must match the exact configured period, model and caps.
Changing those settings cannot reset the recorded usage. Missing, malformed,
partial or inconsistent state prevents provider calls.

## Conservative reservation

Before any provider dispatch, each admitted run durably reserves its entire
worst-case allowance:

| Mode | Searches | Uploads | Jev requests | Jev questions |
| --- | ---: | ---: | ---: | ---: |
| Trace | 4 | 1 | 60 | 113 |
| Claim-check | 6 | 1 | 60 | 272 |

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
