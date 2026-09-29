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

Twelve states, each driven into the **real** `runInvestigation` orchestrator by
controlled SerpApi / Jev / page-fetch doubles. Nothing writes a terminal status,
date, graph, distribution or caveat: each is derived by the product from the
returned envelopes.

The Jev doubles are the **actual production `JevClient`** with an injected
`fetch`, not objects cast to that type. The injected fetch parses the outgoing
request body, derives answers from the serialized state and questions, and
returns a real `Response`. The typed `identity` result is therefore *computed by
the client* from the raw returned `model`; a fixture never supplies it, and
`JevClient` is imported as a value rather than a type. No credential is used —
the key is a literal placeholder that cannot leave the process, because `fetch`
is injected.

Generation:

```bash
CONTEXTTRAIL_GEN_FIXTURES=1 npx vitest run .agents/skills/verify-contexttrail/fixtures/gen-fixtures.test.ts
```

The generation block is `describe.skipIf(!GEN)`, so a normal run only executes the
contract. Regenerate rather than hand-edit any `.ndjson`.

| Fixture | Mode | Terminal / derived state |
| --- | --- | --- |
| `controlled-conflict` | claim | `CONTEXT_CONFLICT` — 2 qualifiers, 2 domains, 2 `separate_origin_evidenced` groups |
| `controlled-no-conflict` | claim | `NO_CONFLICT_FOUND` — five required gates pass, caveat carried |
| `controlled-trace-strong` | trace | dated core across separate origins, segment count 1 |
| `controlled-trace-unresolved-origin` | trace | reconstructed chronology with one unresolved origin, reported not promoted |
| `controlled-trace-limited` | trace | `LIMITED_MEDIA_HISTORY_FOUND` — relevant evidence, fewer than two dated core |
| `controlled-trace-no-dated` | trace | empty dated timeline, segment count withheld |
| `controlled-trace-divergent` | trace | verified later divergence, segment count >= 2 |
| `controlled-placement-disputed-vs-unknown` | trace | disputed and unknown dates kept distinct |
| `controlled-trace-dated-core-ceiling` | trace | exact-only dating, bounded by the deep-read page budget |
| `controlled-trace-dated-core-merged` | trace | same occurrences dated through a merged surface, 8 dated core |
| `controlled-trace-coverage-gap` | trace | comparisons rejected at the client boundary, coverage reported incomplete |
| `controlled-trace-uncertain-transition` | trace | **equal**-date pair yields an `unexamined` connector; later verified divergence survives |

Every named trace fixture has its **exact expected headline asserted**. An
earlier version named a fixture "limited" while never asserting its headline; it
was actually `MEDIA_HISTORY_RECONSTRUCTED`. The inputs that genuinely are limited
now live in `controlled-trace-limited`, and the unresolved-origin case is kept as
its own honestly named state. An unresolved origin does not, by itself, limit
reconstruction.

The `controlled-trace-uncertain-transition` inputs use **equal dates**, not an
imprecise interval. The product's own imprecise-window controls are carried
elsewhere and are deliberately not re-exercised here.

### Dated core: what the real bound is, and a corrected claim

An earlier version of this file claimed a **global five-date ceiling** for dated
core occurrences, reasoning that the lens exact-match normalizer drops its
provider date and so dates require a deep read capped at
`MAX_DEEP_READ_PAGES` (5). **That claim was false.** Two fixtures pin the
correction:

- `controlled-trace-dated-core-ceiling` — exact-only: five dated, bounded by the
  deep-read page budget.
- `controlled-trace-dated-core-merged` — the *same* eleven exact occurrences with
  the same links also dated through another surface. The product merges date
  sources across the same canonical URL while retaining exact identity, so these
  are dated without a deep read: **eight** dated core, eight eligible, eight
  selected, seven compared.

So the five is a **deep-read bound, not a global one**, and there is no
Trace-versus-Claim difference. What is genuinely bounded is retention:
`RETENTION_CAPS.lens_exact` is reapplied after initial and adaptive dedupe, so
with near-match verification disabled and core identity coming from exact
collections, **more than eight retained exact core occurrences is unavailable in
this shipped configuration**. The eight-selection cap *is* reachable, as the
merged fixture shows. A **selection-truncation example is therefore not
established**, and the internal selection algorithm's own proof stays separately
scoped. A future enabled verified-near-match path would need separate analysis.

Relatedly, `comparison_coverage_incomplete` **can** be emitted:
`controlled-trace-coverage-gap` has eight eligible and eight selected occurrences
but zero completed comparisons, because every pairwise call is rejected at the
client boundary. Coverage is reported incomplete and no exact segment count is
claimed, while the classifications themselves remain verified. This is not
selection truncation, and it refutes the earlier "can never be emitted" claim.

No `>8` terminal result is fabricated, and no product limit was altered to make
one appear. The bound above is evidence about the shipped configuration, not
grounds to change frozen retention or identity policy.

### Model identity controls

Driven through the real client, over raw responses whose returned `model` is:

| returned model | expectation |
| --- | --- |
| the pin | accepted; judgments carry `jev-1.13.0` |
| absent | zero accepted classifications |
| `null` | zero accepted classifications |
| an unexpected version | zero accepted classifications |

Each negative also asserts the client was **actually called**, so it cannot pass
by never reaching the boundary.

### Contract-assertion corrections

These are corrections to **fixture assertions and allowlists**, not to
production code. No product source change follows from any of them.

- The limitation allowlist had drifted from the product in both directions: it
  listed a *takeaway* code and two codes absent at this pin, and omitted eight
  the product really emits. A check now reads the product's declared
  `LimitationCode` and `TakeawayCode` unions and fails on drift either way.
- "Has candidates" keyed off a non-empty timeline, so a trace whose occurrences
  are all undated was wrongly required to publish no judgments. It now derives
  from the discovered evidence.
- Distribution-mode expectations were a single global triple, which silently
  forbade any state asserting supports, contradicts or same-context. They are
  now declared per fixture.
- The `NO_CONFLICT_FOUND` caveat control is a real mutation: the fixture bytes
  are copied, the flag removed from the copy, and the **same predicate** the
  positive assertion uses is evaluated on the re-read copy, proving the check is
  load-bearing. In this product the caveat is set unconditionally by
  `buildClaimResult` for every claim status, so it is not a `NO_CONFLICT_FOUND`
  special case.

### Reserved fixture hosts

The host allowlist accepts `fixture-*.example.org`, `example.*` and the
IANA-reserved names `.test` / `.invalid` / `.example` / `.localhost`, with an
opposing control asserting six real hosts are still rejected. Reserved names are
appropriate controlled inputs and are what make distinct registrable domains
possible — pinning every fixture to one registrable domain would make the
corroborating-domain gate and self-bound outlet credits unreachable. They are
**not an egress guard**: do not treat these names as guaranteed non-resolvable on
arbitrary networks. These function probes inject their providers and have no
native fetch fallback.

### Provenance, stated separately

The generator/runner origin and the product source are **different histories**
and are recorded separately. The owned fixture subset was staged byte-exact from
the runner pin before any edit; the product source the generator runs against is
its own authority. Application ancestry must not be inferred from a runner pin:
the `comparisons` and `provenance` result fields that appear in refreshed
fixtures arise from accumulated product contract/graph work, not from the most
recent ownership delta. Fixtures are **semantically, not byte, reproducible**,
because the product mints fresh evidence ids, investigation UUIDs and timestamps
per run; no full independent multi-run equivalence claim is made here.
