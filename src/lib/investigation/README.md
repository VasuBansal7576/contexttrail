# src/lib/investigation

Phase 1 evidence and streaming contracts for ContextTrail's live image
tracer, implementing `contexttrail_master_product_ux_architecture_spec_v1.1.md`
§7–14, §17, §19–24, §28–29.

## Modules

| File | Spec | Contents |
| --- | --- | --- |
| `contracts/evidence.ts` | §10–11 | `EvidenceCandidate`, identity/reporting-origin/date-uncertainty fields |
| `contracts/judgment.ts` | §15.5, §17 | `EvidenceJudgment`, pairwise judgments, frozen thresholds (0.70 / 0.75) |
| `contracts/investigation.ts` | §1.7, §20.2, §22, §33 | `ClaimStatus`, `TraceResult`, `ClaimResult`, `TimelineItem`, `Divergence`, `PublicEvidenceCandidate`, takeaways, limitation codes |
| `contracts/events.ts` | §9.2, §24 | `Stage`, `InvestigationEvent` NDJSON union, `encodeEvent` / `decodeEventLine` / `NdjsonEventReader` |
| `limits.ts` | §7, §27–28, §10.3, §14, §18, §20 | Frozen timeouts, concurrency, retention caps, candidate/verifier bounds |
| `budget.ts` | §7, §29 | `SearchBudget` — hard per-mode search caps, one-shot base slots, single adaptive slot, upload bound, failure accounting |
| `expansion.ts` | §8 | Expansion triggers/early stop and grounded-query choice |
| `url.ts` | §12 | Canonical URL normalization (tracking params, www, ports, params sort) |
| `domain.ts` | §13 | PSL-aware registrable domains (`tldts`), `sourceDomainCount` |
| `dates.ts` | §19 | Claim-date parsing (`chrono-node`), evidence-date precedence, dispute, `PREDATES_CLAIM` with 24h buffer |
| `identity.ts` | §6.3–6.4, §10.2–10.3 | Exact-match collection classification, media-relationship resolution, identity-invariant enforcement |
| `candidates.ts` | §14 | Canonical-URL dedupe, per-kind retention caps, `MAX_JEV_CANDIDATES` selection |
| `reporting-origins.ts` | §13 | Origin-group bookkeeping and the separately-evidenced corroboration gate |
| `divergence.ts` | §20 | Dated-core selection (≤8), context segmentation, first observed divergence |
| `timeline.ts` | §3.11, §20.2 | Dated timeline vs `undatedEvidence` split; uncertain/unexamined connectors preserved |
| `policy.ts` | §21–22, §33 | Deterministic `ClaimStatus` evaluation, takeaways, result assembly |

## Invariants enforced

- `EXACT_MATCH` only ever comes from a validated `lens_exact` retrieval with
  `provider_reported` identity evidence — a visual result's exact-match
  navigation flag/link never confers identity.
- `NEAR_MATCH` requires the pinned local spatial verifier (`passed` +
  version/config IDs + comparison metrics); hash-only stays `VISUAL_LEAD`.
- Unknown/disputed dates stay unknown/disputed and never enter the dated
  timeline or create ordered divergence edges.
- Unresolved or shared reporting origins cannot satisfy the cross-domain
  corroboration gate; `sourceDomainCount` is never "independent sources".
- Trace mode emits no claim status; claim-check statuses come only from
  `evaluateClaimPolicy`, never from a model.
- Every search attempt consumes budget before dispatch; failed base slots
  are not retried; at most one adaptive search per investigation.

## Required dependencies (integration)

Not yet declared in `package.json` (owned by the scaffold stream):

- `chrono-node` — claim/evidence date parsing (§19.1)
- `tldts` — PSL-aware registrable domains (§13)
- `vitest`, `typescript`, `@types/node` — tests/typecheck

## Next wiring action (integration step)

`src/app/api/investigate/route.ts` does not exist yet in this stream. Wire
`runtime = "nodejs"`, `maxDuration = 60`, parse multipart `claim`,
`timezone`, `locale`, `media` into `InvestigationInput`, and write
`encodeEvent(...)` chunks to an `application/x-ndjson` response body while a
runtime executor drives `SearchBudget` + these policies. Fixture fallback in
the production route is forbidden (§40).
