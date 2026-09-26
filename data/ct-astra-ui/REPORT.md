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

## Verification (pending at this commit)

Rebuild + drive rich/possible/empty/insufficient/conflict fixtures on :3111,
desktop + 390px screenshots, keyboard/contrast/focus checks, typecheck +
vitest. After-shots + measurements to be appended here.
