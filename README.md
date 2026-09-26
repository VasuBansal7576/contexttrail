# ContextTrail

**Reconstruct the web history of an image and see when, where, and how its context changed.**

Upload a photo. Optionally add the claim or caption attached to it. ContextTrail searches the
live web for exact and visually related appearances, normalizes them into evidence, arranges
that evidence into a chronology, marks where the context shifted, and — when a claim is
supplied — compares the retrieved history against it.

Release status, deadlines and the live-case checklist live in [`docs/release.md`](docs/release.md).

---

## Why this is not a reverse-image lookup

Most misleading media is not fabricated. It is real media reused with a new year, a new city,
or a new event. Reverse-image tools hand back a grid of visually similar pages and leave the
user to open tabs, compare dates, and work out when the context changed.

ContextTrail's primary artifact is not a match grid. It is a reconstructed evidence history:

```text
retrieved occurrences
  → normalized evidence
  → source-domain counting and reporting-origin checks
  → chronology
  → context segmentation
  → first observed context divergence
  → claim comparison (optional)
  → inspectable provenance timeline
```

**Two modes.**

| Mode | Input | Output |
| --- | --- | --- |
| **Trace** | image only | media history, earliest observed occurrence, source-domain count, timeline, context shifts. Never a claim verdict. |
| **Claim-check** | image + claim/caption | everything Trace produces, plus exactly one conservative status: `CONTEXT_CONFLICT`, `POSSIBLE_CONTEXT_CONFLICT`, `NO_CONFLICT_FOUND`, or `INSUFFICIENT_EVIDENCE`. |

**What it deliberately is not:** an AI chatbot, a truth-percentage meter, a credibility or
fake-news score, an AI-image detector, or an oracle for the "original upload". It reports
observed evidence relationships and states its limits next to its conclusions.

---

## Status

This is a working live vertical slice — real upload, real SerpApi retrieval, bounded
classification, streamed progress, and a result you can inspect down to individual sources.
It is not finished.

An independent audit of the integration returned **NO-GO** against the project's own
definition of done: **18 findings (8 P1, 10 P2, no P0)**, and grouped PRD coverage of
**23 PASS / 61 PARTIAL / 26 FAIL / 4 NOT VERIFIED** across 114 requirement rows. The
central promise — a reliable, inspectable history of the *same* image with defensible context
changes — has **not yet been demonstrated on a strong live case**. Several evidence-integrity
defects were reproduced with controlled inputs.

What does pass today, on this revision:

| Check | Command | Result |
| --- | --- | --- |
| Unit / contract tests | `npm test` | 143 tests in 20 files, all passing, no external API calls |
| Types | `npm run typecheck` | clean (`tsc --noEmit`) |
| Production build | `npm run build` | succeeds |

See [`docs/release.md`](docs/release.md) for the open blockers and what must be proven before
any release claim.

---

## Prerequisites

- **Node.js 20 or newer** — declared in `package.json` under `engines.node` (`>=20`).
- **npm** — the repo ships a `package-lock.json`, so install with `npm ci` for a reproducible
  dependency tree. No other package manager lockfile is supported.
- **API keys** — only needed for live retrieval: a SerpApi key and a TypeSafe (Jev) key.
  Running the test suite, the typecheck and the build requires **no keys and spends no credits**.
- A current desktop browser. Chrome is the browser exercised by verification so far;
  Edge, Safari, Firefox and real mobile engines are **not yet verified**.

---

## Setup

```bash
npm ci
```

Then create `.env.local` in the repository root (this file is gitignored via the `.env*.local`
rule — never commit it):

```bash
# .env.local — server-only. Never prefix any of these with NEXT_PUBLIC_.
SERPAPI_API_KEY=<your-serpapi-api-key>
TYPESAFE_API_KEY=<your-typesafe-api-key>
TYPESAFE_MODEL=jev-1.13.0
```

| Variable | Purpose |
| --- | --- |
| `SERPAPI_API_KEY` | SerpApi — image upload, Google Lens, Google Search and Google News retrieval. |
| `TYPESAFE_API_KEY` | TypeSafe Jev — semantic classification of retrieved candidates only. |
| `TYPESAFE_MODEL` | Jev model id. The project pins `jev-1.13.0`; the value above is the documented default, not a secret. |

These are read **server-side only**, in `src/lib/investigation/server.ts`. They are never
exposed through `NEXT_PUBLIC_*`, never logged, and must never appear in committed examples,
screenshots, recordings or bug reports. Leave the two key values as placeholders until you
are about to run a live investigation.

If `.env.local` is absent or a key is empty, the app still runs — the investigation ends in an
honest configuration failure (`SERPAPI_API_KEY is not configured`) instead of falling back to
fixtures, and no search request is dispatched.

---

## Commands

| Task | Command |
| --- | --- |
| Development server | `npm run dev` |
| Production build | `npm run build` |
| Serve the production build | `npm start` (add `-- -p 4000` to pick a port) |
| Typecheck | `npm run typecheck` |
| Tests | `npm test` |

`npm run lint` also exists in `package.json`, but no ESLint configuration is committed in this
revision, so `next lint` drops into an interactive setup prompt. It is **not** part of the
verification gate below.

### Keep dev and build directories separate

`next dev`, `next build` and `next start` all share one `.next` directory per checkout.
**Never run `npm run build` or `npm run dev` inside a checkout whose `npm start` server is
currently running** — it rewrites the artifacts under a live server and produces stale or
half-built pages. Build in a separate clone, worktree or snapshot directory while a server is
up, and point the browser at the directory you actually built.

---

## Budgets and credit attempts

Search budgets are hard invariants in `src/lib/investigation/limits.ts` and
`src/lib/investigation/budget.ts`, not suggestions:

1. **Trace mode (image only): at most 4 SerpApi search requests** — 3 base
   (Lens `type=all`, Lens `type=exact_matches`, Lens `about_this_image`) plus at most
   1 adaptive Google Search on a grounded related-content query.
2. **Claim-check mode (image + claim): at most 6 SerpApi search requests** — 5 base
   (the three above plus one Google Search and one Google News on the claim) plus at most
   1 adaptive search.
3. **Image upload: exactly 1 bounded attempt per investigation**, and it is not counted as a
   search request.
4. **Adaptive expansion: at most 1 per investigation**, allowed only after every base slot for
   the mode has been reserved. A failed base slot is never retried or repurposed.

Every attempted search consumes budget *before* it is dispatched, including failures. The
production route has no fixture fallback: if a provider is unavailable you get the real
failure state, never a substituted result.

---

## Image upload and privacy

Exactly as implemented:

- **Accepted types:** JPEG, PNG, WebP (`image/jpeg`, `image/png`, `image/webp`).
- **Client preprocessing** (`src/lib/media/image-preprocess.client.ts`) runs entirely in the
  browser: decode, preserve aspect ratio, cap the long edge at **1600 px**, encode WebP
  starting at quality **0.82** and step down in 0.07 increments to a floor of **0.55** until
  the payload is **≤ 450 KB**, then retries the same ladder as JPEG. If neither encoder reaches
  the bound the upload is rejected ("could not be compressed under 450 KB"). The processed bytes
  exist only in memory.
- **Server-side bound** (`src/app/api/investigate/route.ts`): media over **500 KB** is rejected
  with HTTP `413`; the claim is truncated to **500 characters**.
- **No database in v1.** The only client-side persistence is the latest completed
  investigation JSON in `sessionStorage` — **image bytes are never stored there**. A refresh
  may lose an active investigation; that is accepted for v1.
- **The temporary SerpApi `image_id` is not persisted, and media bytes are not logged.**
- The upload screen states this next to the control: *"Your image is sent to SerpApi / Google
  Lens for visual search. ContextTrail does not persist your image."*

---

## Verification

### Zero-credit (default — use this in the loop)

```bash
npm ci
npm test           # deterministic Vitest suite, zero external calls
npm run typecheck  # tsc --noEmit
npm run build      # production build
```

Browser walkthroughs are also zero-credit when `.env.local` is absent: with no
`SERPAPI_API_KEY` the server reports an honest configuration failure before any search is
dispatched, so you can exercise upload, validation, streaming, error recovery and layout
without spending anything.

### Gated live verification (spends credits)

Live runs are for integration work, milestone verification, demo rehearsal and pre-submission
checks — never for routine testing or CI.

- Requires a real `.env.local`. Run **one case at a time, sequentially**, inside the budgets
  above.
- Record **attempted / returned / retained** counts separately; a large returned count is not
  the same as independent sources.
- Do not re-run an identical input just to capture a screenshot.
- Note: the `RUN_LIVE_TESTS=1` gate specified by the PRD is **not wired in this revision**, so
  treat every live run as manually gated. Do not wire live calls into `npm test`.

### Fixture tiers

| Tier | Credit | Proves | Does not prove |
| --- | --- | --- | --- |
| **Deterministic unit fixtures** (`src/**/*.test.ts`) | 0 | budgets, contracts, policy invariants, normalization, failure boundaries | anything about the live web |
| **Controlled / boundary fixtures** (result or stream contract delivered at the HTTP boundary) | 0 | rendering, recovery, keyboard and layout behavior | provenance truth — a fixture that renders `CONTEXT_CONFLICT` is not a fact check |
| **Real live runs** (configured providers, real SerpApi responses) | spends | what the product actually returned for that input | completeness of web coverage, or the identity of the original upload |

Keep the tiers visibly distinct in any evidence you publish. Fixtures are legitimate for tests,
development and deterministic local verification; they must never be presented as live retrieval.

### Project verification harness (in progress)

A project-owned browser harness — isolated `launch` / `doctor` / `drive` / `evidence` /
`cleanup` around a pinned production build, plus a nine-feature product map — is under
development and is **not part of this revision yet**. When it lands it lives at
`.agents/skills/verify-contexttrail/` with the CLI at
`.agents/skills/verify-contexttrail/bin/control-contexttrail`. Its creation gate has passed
(one mapped landing feature, 26 evidence artifacts surviving cleanup); full nine-feature
coverage is still pending. Normal runs of that harness spend **zero provider credit**.

---

## Known limitations and honest uncertainty

ContextTrail is built to preserve uncertainty rather than manufacture confidence.

- **"Earliest observed" is not "original."** It is the earliest occurrence in the retrieved
  sample. Nothing in the product asserts the original upload.
- **Identity.** `EXACT_MATCH` comes only from a provider-reported exact-match collection.
  Visually similar results stay `VISUAL_LEAD`. **Near-match promotion is deliberately
  disabled** until a local spatial verifier passes its held-out acceptance gate — the result
  surfaces `near_match_verifier_disabled`, and no spatial confirmation is claimed anywhere in
  the UI.
- **Dates.** Unknown and disputed dates never enter the dated timeline. The result states
  `unknown_dates_present`, `disputed_dates_present` and `insufficient_dated_occurrences`
  rather than guessing.
- **Reporting origins.** Cross-domain corroboration requires separately evidenced reporting
  origins. Unresolved origins surface as `reporting_origins_unresolved`, and the
  source-domain count is never labeled "independent sources".
- **Comparison coverage.** Gaps are labeled, not smoothed over — `comparison_coverage_incomplete`
  is shown, and the observed-context count is `null` unless the displayed dated sequence has
  complete, decisive adjacent comparisons.
- **Trace mode never emits a claim status.** Claim statuses come only from the deterministic
  policy, never from the model.
- **Bounded retrieval.** Results describe a retrieved sample within fixed budgets, not
  complete web coverage.
- **Still unproven:** a strong live Trace/divergence case, a strong live claim case, real
  provider failure accounting, non-Chrome browsers, and deployment. See
  [`docs/release.md`](docs/release.md).

---

## Where to inspect sources and comparisons

**In the app:** after an investigation, use the **Overview / Timeline / Sources / Analysis**
tabs. **Inspect evidence** opens the comparison viewer — submitted image beside retrieved
image, match basis, date source, excerpt and reporting origin, with **Open original source**
and previous/next navigation. **Technical details** holds the lower-level identifiers.

**In the code:**

| Area | Path |
| --- | --- |
| Evidence contracts, budgets, identity, dates, divergence, timeline, deterministic policy | `src/lib/investigation/` |
| Provider clients | `src/lib/serpapi/`, `src/lib/jev/` |
| Safe page fetch and extraction | `src/lib/pages/` |
| Streamed NDJSON route (`runtime = "nodejs"`, `maxDuration = 60`) | `src/app/api/investigate/route.ts` |
| Result, timeline and viewer UI | `src/components/result/` |
| Upload and preprocessing | `src/components/upload/`, `src/lib/media/` |
| The specification this implements | `contexttrail_master_product_ux_architecture_spec_v1.1.md` |
| Design reference boards | `contexttrail-designs/` |

---

## Illustrative assets and attribution

- The landing hero uses **abstract placeholder motifs, not photographs**, and is labeled
  *"Illustrative example — not retrieved evidence."* The static walkthrough below it is
  explicitly marked illustrative, uses generic sample labels rather than real publisher names,
  and states that it runs no investigation and implies no live API calls.
- **No third-party photographs, publisher logos or licensed artwork are bundled in this
  repository.** The only shipped static assets are `src/app/icon.svg` and
  `src/app/favicon.ico`.
- **No LICENSE file and no third-party asset attribution document exist in this revision.**
  If an illustrative photograph is ever added to the landing page, its license and attribution
  must be committed alongside it in a frontend attribution document — do not ship an
  attributed-or-unattributed image without one.

---

## Deployment (Vercel)

The specification targets Vercel with the Node runtime, and the code already matches it:
`src/app/api/investigate/route.ts` exports `runtime = "nodejs"` and `maxDuration = 60`.

To deploy your own instance:

1. Create a Vercel project from this repository and select the **Node** runtime (the default
   for this Next.js app).
2. Add the same three environment variables in the project's environment settings —
   `SERPAPI_API_KEY`, `TYPESAFE_API_KEY`, `TYPESAFE_MODEL` — **without** `NEXT_PUBLIC_`
   prefixes.
3. Deploy. Client preprocessing already keeps request bodies far under the platform's payload
   limit (≤ 450 KB processed, ≤ 500 KB upstream).

This revision has **not** been deployed, and this document makes no hosting, account or
publication promise — no login is performed and no deployment is configured here. Deployment
is a product-acceptance goal, **not** a submission requirement; the hackathon asks for a demo
video of the project running **locally**. See [`docs/release.md`](docs/release.md).
