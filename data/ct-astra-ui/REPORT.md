# ct-astra-ui private work report (Firstmate communication artifact)

Branch: `fm/ct-astra-ui`. Local-only. No push / PR / merge by this worker.

## Baseline

Detached HEAD was docs-only (`d50474f`). The brief listed 6 investigation
commits whose parent chain needs the UI shell (`ce641b4` + `57c3d1c`,
package.json + src/app + src/components). Cherry-picked in order:

`ce641b4`, `57c3d1c`, `47b6882`, `2e769f2`, `1040931`, `3e1927e`,
`9fafaba`, `2233d6c` — all clean, no conflicts. The two extra UI-shell
picks are a documented necessity deviation, not scope creep: without them
there is no app to repair.

Inbox handled: `001.msg` (boundary + PID tracking + entry-coverage honesty),
`002.msg` (backend Phase0 CLI at `aed4ea1` available for cherry-pick).

## Findings reproduced (baseline, :3111, controlled fixtures at API boundary)

Real drop (DragEvent) + real form submit + fetch-interception of
`POST /api/investigate` replaying review fixtures. Upload bytes are the real
project illustration served by the app; preprocessing + stream reduction are
real. Before-proof (kept on disk, NOT committed): `data/ct-astra-ui/before-*`.

- F04: solid identical connectors; `incomingConnector` unread; divergence
  banner unlinked; later node unmarked.
- F12: Sources rows identical; Analysis missing coverage/origins/reasons;
  takeaway with `evidenceIds=[]` has no link.
- F13: composite `Title:/Snippet:` quoted whole; raw `page_text` /
  `serp_snippet` / `shared_origin` tokens; full ~8K model context in viewer.
- F14: focus on 1x1px input, no visible dropzone focus; Escape restores BODY;
  no tab-arrow behavior; `text-signal` ~3.4:1 on paper.
- F15: 390px overview shows submitted image before headline; stage list
  before live evidence.
- F16: generic icons x3; `document.fonts.size === 0`.
- F17: 7133-byte completed result in sessionStorage; refresh -> upload form.

## Implementation (this commit)

- `src/components/result/evidence-display.ts` (new, owned): frontend
  projection — connector states, coverage text, divergence endpoints,
  identity basis, role, readable origin/date-source labels, composite
  excerpt splitting, short attributable spans. No `src/lib` edits.
- TimelineView: per-kind edges (dashed + required text), gated context
  badges (assessed edges only), linked divergence endpoints + marked later
  node, coverage line, short excerpts, honest empty core.
- EvidenceViewer: one genuine span + expandable full text, readable
  attribution/origin/identity/date, pair navigation, entry notes, focus
  restore to trigger via `onCloseAutoFocus`.
- ResultView: roving-tabindex tabs, mobile result-first order, Sources roles
  + basis + origin + date provenance, Analysis coverage/origins/reasons with
  honest nulls, takeaway link states, F17 `restoredNotice`.
- F14: `--color-signal-ink #2f4fd0` (6.07 paper / 6.67 white), `link` badge
  tone on light surfaces, dropzone `focus-within` ring.
- F15: InvestigationView evidence-first mobile order + compact current-stage
  summary; ResultView overview result-first on mobile.
- F16: local `Instrument Serif` + `Geist Sans` via `next/font/local`
  (`src/app/fonts/*.woff2`); hero repeats NASA Earthrise (Apollo 8, public
  domain, `public/illustrative-earthrise.jpg`) across 3 labeled cards.
- F17: `investigate/page.tsx` resume banner + restored ResultView with
  explicit image-unavailable state; never persists image bytes. Cache-key
  literal mirrors backend-owned `RESULT_CACHE_KEY` — pending typed contract.

## Backend dependencies (for parent)

1. Typed result contract pending: per-request attempts/budgets, takeaway
   `evidenceIds` completeness, comparison selected IDs, policy gate reasons.
   Frontend renders honest "not in payload" lines meanwhile.
2. Excerpt composite building (`Title:/Snippet:` + 8K context) is backend
   (`extract.ts`/`run.ts`); frontend splits for display only.
3. `LIMITATION_COPY` "hash-only" wording is lib-owned; suggest user-meaning
   reword from backend.
4. Selectors for backend CLI map: tabs `role=tab` names
   Overview/Timeline/Sources/Analysis; `Inspect evidence: <title>`;
   `View evidence →`; divergence `Earlier:/Later:` buttons; `View last
   result`; viewer `Previous evidence`/`Next evidence`/`Back to timeline`
   (`Dialog.Close`); dropzone label `Drop an image here or click to browse`;
   claim field `Claim or caption (optional)`; `Start investigation`.

## Entry coverage honesty

- Drop: real `DragEvent` drop on the dropzone (genuine control path).
- Upload icon/label click, keyboard chooser activation: focus verified;
  native chooser cannot complete headless — no browse/keyboard/drop
  completion coverage claimed beyond what was actually activated.
- Fixture setup uses API-boundary interception only; no React state setters,
  no debug routes, no production fallback.

## Owned runtime (cleanup at end)

- Next :3111 PID 45122 (do NOT touch :3100 PID 36879 — sibling lane).
- Fixture CORS server :3112 PID 60237 (serves audit fixtures read-only).
- Never build against :3100 artifacts; worktree `.next` is isolated.

## Verification (after-proof, all on isolated ports, no live calls)

Rebuilt production builds; `tsc` clean; `vitest` 161 passed / 2 skipped
(matches backend stage). CLI `verify-contexttrail` run-2 (rev 1e64e75,
fresh fixtures): doctor healthy, landing/upload/investigation/result drives
with 0 unexpected console errors (fixture image DNS failures are expected
unavailable-image handling, not app errors). Note: the CLI's result drive
records the requested view without asserting selection (known backend gap,
recheck §CLI) — every view below was asserted explicitly (`aria-selected`)
in the CDP flow before screenshotting.

- F04: `after-rich-timeline.png` — dashed uncertain/unexamined edges with
  required text, coverage line "7 of 8 selected pairs compared · 10
  eligible occurrences", divergence banner with Earlier/Later endpoint
  buttons + unresolved qualifier, marked later node, context badges gated
  on assessed edges.
- F12: CLI `result-sources.png` — Contextual/Core+Exact/Visual-lead rows
  with basis, origin, date provenance; `result-analysis.png` — real
  retrieval counts (labeled retrieved), coverage, reporting groups/
  unresolved, stages, limits. Takeaway with `evidenceIds=[]` renders "No
  supporting evidence was linked to this takeaway in the result." (no dead
  link). New contract: contextual section + roles verified on
  `result-timeline.png` (run-2).
- F13: timeline page-wide grep — 0 `Title:` / 0 wire tokens
  (`page_text`, `serp_snippet`, origin/status tokens); short spans with
  "Search snippet"/"Extracted page excerpt" attribution; title-only and
  title+body-without-snippet composites split (backend emits 3 shapes, all
  labeled `page_text`); viewer `after-viewer-body-excerpt.png` — one span
  + "Full retrieved text" disclosure.
- F14: `after-upload-keyboard-focus.png` — visible dropzone ring with focus
  on the 1px input; Escape restores the originating trigger (verified
  Later-button round-trip; BODY only when activation carried no focus);
  ArrowRight moves tab focus+selection Timeline→Sources; evidence-link
  color rgb(47,79,208) = 6.49:1 on cards / 6.07:1 on paper (was ~3.4).
- F15: `after-mobile-overview.png` — 390px DOM+visual order is result
  headline before submitted material; investigation DOM is summary →
  evidence → full stages with compact current-stage banner.
- F16: CLI `landing-hero.png` — repeated Earthrise photo ×3 labeled cards +
  illustrative badge + NASA public-domain credit; `document.fonts.size`=5
  (Instrument Serif + Geist Sans local woff2, system fallbacks intact).
- F17: `after-restored-overview.png` — resume banner → restored result with
  "Submitted image unavailable after refresh" + preserved-limits notice;
  sessionStorage holds only `contexttrail.latest-result` JSON (9.9KB, no
  image bytes); Discard/New-investigation clear it.

## Precise additive fields needed from the backend contract (per 005)

Per occurrence: `identityBasis{method,supportId?}`, `dateProvenance{value,
precision,source,entityBinding,rejectedCandidates[{value,reason}]}`,
`originSupport{status,groupId,attributionSpans[{text,relation}],groupingReason}`,
excerpt split into `displayText`+`displayAttribution` vs a separately-keyed
model `classificationContext` (never quoted), `comparisonSelection{selected,
comparedPairIds}`. Result level: `requestLog[{engine,attempted,returned,
retained}]`, coverage with displayed-vs-eligible including imprecise dates
(B2), `policyReasons[{gate,passed,detail,supportIds}]`, complete takeaway
`evidenceIds`, `reportingGroups[{groupId,memberIds,reason}]` +
`unresolvedCandidateIds`. Frontend currently renders honest "not in payload"
lines where these are absent; no placeholders.

## Residuals (not mine — tracked for parent)

- Analysis "Finalizing result" running dot + `corroboration_limited` stage
  detail token: backend F10/stage-copy (B5). Rendered honestly as received.
- `LIMITATION_COPY` "hash-only" wording: lib-owned; suggest user-meaning
  reword from backend.
- Strong live provenance cases, other engines/AT, deployment: NOT VERIFIED
  (no live calls per brief; parent coordinates).
- Invalid-feature CLI flags / view-selection assertion: backend-owned CLI
  gaps; worked around by explicit assertions above.
