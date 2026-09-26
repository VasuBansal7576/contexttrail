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

