# Controlled public-contract fixtures

NDJSON streams captured from the REAL `runInvestigation` orchestrator running
with controlled SerpApi/Jev/page-fetch providers. They prove rendering and
stream behavior at the `POST /api/investigate` HTTP boundary — they never
represent real provenance, and no provider credit is spent replaying them.

Evidence tier: `public-contract-boundary`.

Regenerate after contract changes (skipped by default):

```
CONTEXTTRAIL_GEN_FIXTURES=1 npx vitest run \
  .agents/skills/verify-contexttrail/fixtures/gen-fixtures.test.ts
```

## Shipped fixtures

| Fixture | Mode | What it exists to prove |
| --- | --- | --- |
| `controlled-trace` | `trace` | media-history reconstruction with no claim submitted; the terminal `headline` token is compared with the exact rendered copy |
| `controlled-claim` | `claim_check` | a claim-check result with a decisive connector, dated core occurrences and a real status headline |
| `controlled-viewer` | `claim_check` | per-occurrence loadable thumbnails (distinct solid-colour PNGs) plus a no-excerpt item, so image attribution and fallback are provable |
| `controlled-pair` | `claim_check` | a real `firstObservedContextDivergence` whose two endpoints are displayed occurrences, one never-compared edge and one compared-but-inconclusive edge |
| `controlled-insufficient` | `claim_check` | provider-validated EMPTY collections (not malformed/unavailable ones) resolving to an honest `INSUFFICIENT_EVIDENCE` |

`controlled-pair` is built from four dated core occurrences whose dates come from
fetched page JSON-LD, and a Jev mock that answers the pairwise question
`DIFFERENT_CONTEXT` for the divergence edge and `UNCLEAR` for the later one. The
same-day pair is never sent for comparison at all, which is how "not compared"
and "compared but inconclusive" end up as two distinguishable connector states
in one chronology. Per-candidate relevance is strict so the deep-read budget
spends itself on exactly those four occurrences — without that, selection falls
back to id order and the pair cannot exist.

Retrieved images are generated as distinct solid-colour PNGs, one per candidate,
and are required to differ from each other **and** from the 1×1 PNG the harness
submits: identical pixels render identically wherever they appear, so a
screenshot could neither attribute the rendered `<img>` to a candidate nor
disprove submission-image substitution.

## Contract suite

The always-on half of `gen-fixtures.test.ts` runs on every `npx vitest run` and
asserts, per fixture: terminal event and mode/status coherence, `requestLog`
engine counters and finite `durationMs`, policy/support/identity/date/origin
fields with resolvable cross-references, normalized probability distributions,
the **exact** configured model pin (`JEV_MODEL`, not any `jev-*` lookalike),
event chronology with discovered → classified → published id identity, stage
start/complete pairing, distinguishable decodable images, and the absence of
real hosts and credential material. Nullable unknown fields stay valid.

Deliberately not asserted, because the product does not guarantee them: that
every announced classification survives into the terminal result (candidates
are dropped after the deep read), and that every published row was announced
(late candidates are published without an `evidence.classified` event). Both
are product-side progressive-stream observations, not fixture properties.

Red controls that must keep failing: a model relabelled `jev-9.99.0`, an
`evidence.classified` id that was never discovered, a duplicated retrieved
image URL, a string `durationMs`, a probability of 9, and a real source host.

## Mutation controls (not fixtures)

`controls/coverage-mutants.mjs` derives **new, untracked** streams from copies of
the checked-in fixtures so the Analysis comparison-coverage assertions can be
proved to bite. No tracked fixture is ever regenerated or edited, and
`node controls/coverage-mutants.mjs clean` removes every stream it wrote.

Keep the mutants absent: `gen-fixtures.test.ts` validates every `*.ndjson` in this
directory, so a leftover mutant would be asserted as if it were real evidence.
A drive run against a mutant is a deliberate red control, never acceptance
proof; its `drive.json` names the mutant and the harness run that used it is
labelled as such.

| Command | Stream written | What it proves turns red |
| --- | --- | --- |
| `contrary-count` | `controlled-empty-contrary-count` | a pair count claimed for a run with nothing eligible |
| `summary-contradiction` | `controlled-empty-summary-contradiction` | performed comparisons presented for a run that selected nothing |
| `availability` | `controlled-pair-availability-mutant` | a summary that disagrees with the result's own performed list |
| `phantom-performed` | `controlled-pair-phantom-performed` | a performed pair naming occurrences that were never displayed |


## A8 current-source states

Nine states were added by driving the **real** `runInvestigation` orchestrator
with controlled SerpApi / Jev / page-fetch doubles. Nothing writes a terminal
status, date, graph, distribution or caveat: each is derived by the product from
the returned envelopes. Generation:

```bash
CONTEXTTRAIL_GEN_FIXTURES=1 npx vitest run .agents/skills/verify-contexttrail/fixtures/gen-fixtures.test.ts
```

The generation block is `describe.skipIf(!GEN)`, so a normal run only executes the
contract. Every fixture is regenerated at the product authority the generator is
pinned to; do not hand-edit a `.ndjson`.

| Fixture | Mode | Terminal / derived state |
| --- | --- | --- |
| `controlled-conflict` | claim | `CONTEXT_CONFLICT` — 2 qualifiers, 2 registrable domains, 2 `separate_origin_evidenced` groups, corroborating-pair gate passed |
| `controlled-no-conflict` | claim | `NO_CONFLICT_FOUND` — all five required gates pass, `doesNotProveClaimTrue` carried |
| `controlled-trace-strong` | trace | dated core across separate origins, `contextSegmentCount` 1, no divergence |
| `controlled-trace-limited` | trace | 1 unresolved origin reported as `reporting_origins_unresolved`, never promoted to a group |
| `controlled-trace-no-dated` | trace | empty dated timeline, all occurrences undated, segment count withheld |
| `controlled-trace-divergent` | trace | verified later divergence, `contextSegmentCount` ≥ 2 |
| `controlled-placement-disputed-vs-unknown` | trace | a **disputed** date (two disagreeing page sources, rejected ledger retained) and an **unknown** date, kept distinct |
| `controlled-trace-dated-core-ceiling` | trace | the reachable dated-core ceiling (5) — see the note below |
| `controlled-trace-uncertain-transition` | trace | equal-date pair yields an `unexamined` connector and withholds the segment count, while the later verified divergence survives |

### The dated-core ceiling, and why there is no ">8" fixture

The state list asked for **more than eight dated core occurrences with at most
eight selected**. That condition is **not reachable** at this product pin, so no
fixture pretends otherwise; `controlled-trace-dated-core-ceiling` records the
ceiling that is reachable and the contract pins why:

- core occurrences (`EXACT_MATCH` / `NEAR_MATCH`) arise only from a validated
  lens exact collection — contextual web/news/about-image surfaces are given
  `mediaRelationship: null`;
- `normalizeExactMatchesResponse` returns an **empty** `dateTexts`, so the
  provider date on an exact match is dropped;
- the only remaining date source is a fetched page, and deep reads are capped at
  `MAX_DEEP_READ_PAGES` (5).

So at most five dated core occurrences can exist, `MAX_DIVERGENCE_OCCURRENCES`
(8) is structurally unreachable, selection is never truncated, and
`comparison_coverage_incomplete` cannot be emitted by a real investigation. This
is a product-side gap, **not** a fixture gap. It is routed to the API owner and
**no product source was changed to work around it**.

### Two controls that keep the contract honest

- `limitation codes cover the product union` reads the product's declared
  `LimitationCode` and `TakeawayCode` unions and fails if either allowlist drifts.
  It already caught three stale entries that had been sitting in the fixture
  allowlist: `no_current_media_corroboration` (a *takeaway* code),
  `location_unresolved` and `model_identity_unverified` (neither exists at this
  pin), plus real codes the allowlist never listed.
- `the reserved-host allowlist still rejects real hosts` is the opposing control
  for the host allowlist, which was widened to the RFC 2606 / RFC 6761 reserved
  names (`.test`, `.invalid`, `.example`, `.localhost`). Those are the TLDs whose
  entire purpose is "never resolves", which is what the check protects, and they
  are required here: pinning every occurrence to a single registrable domain
  would make the corroborating-domain gate and self-bound outlet credits
  unreachable. Real hosts are still rejected.
