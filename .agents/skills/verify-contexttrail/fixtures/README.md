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
