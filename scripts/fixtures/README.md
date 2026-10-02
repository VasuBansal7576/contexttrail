# Offline evidence layout proof

`large-research-result.mjs` deterministically generates a synthetic response, not a provider run. It has 103 sources, long exact URLs, a long unbroken title, and full retained passages with unique end markers. It contains no external image requests.

Generate JSON only when needed (keep generated data outside the source tree):

    node scripts/fixtures/large-research-result.mjs > /tmp/large-research-result.json

Rerun the parser and UI interaction proof:

    npm test -- src/components/casebook/evidence-collection.test.ts

For authorized browser QA on a fresh local preview, use this response as an explicitly labelled offline test response to the automatic-research endpoint. Do not present it as retrieved evidence or live provider success. No provider credentials or calls are needed. Check desktop and 390px width:

- Sources shows 8 cards. Next reaches page 13 and source 103; Previous works.
- A title expands retained evidence in the current page. Entering Sources or inspecting a title never opens an external page.
- Each card visibly gives its domain and exact URL. Only Open in new tab opens it. Copy URL gives success or an accessible fallback.
- The expanded passage retains its FINAL RECORD marker; unbroken strings and URLs wrap without widening the viewport.
- Keyboard paging focuses the collection. The fixed chapter bar never covers the last row or pagination.
- Also verify an empty response, image result Overview/Timeline/Sources/Analysis, image progress/cancelled states, saved Sources/Evidence, and the original cover without changing its missing asset.

These are browser verification instructions. Automated DOM assertions do not establish visual acceptance.
