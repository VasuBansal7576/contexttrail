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

The image-investigation core was merged in [PR #1](https://github.com/VasuBansal7576/contexttrail/pull/1)
on September 29, 2026. The integrated public source is `main` commit
`6976173ecab12ec4bcef4f6d7c910957ffe10e0a`.

A fresh offline check of that exact commit on September 30 passed **692 tests across
27 files**, with **17 intentionally gated fixture-generation tests skipped**. Earlier
143/161/228-test totals in the historical reports belong to older revisions. They are not
current totals. Run the commands below for the revision you are using.

The central release gate remains open: a strong live image-history case and a strong live
claim conflict have not yet been demonstrated by the retained evidence. Historical live
runs returned limited history or insufficient evidence. Those are valid conservative results,
but they do not prove the flagship context-change workflow.

The repository includes all nine mapped verification areas, controlled browser fixtures,
and detailed evidence-policy tests. Fresh browser verification, live-provider acceptance,
demo capture and deployment are separate gates. **A passing fixture or build does not prove
live provenance accuracy.** See [the release checklist](docs/release.md) and
[the latest work index](https://github.com/VasuBansal7576/contexttrail/issues/2).

---

## Local research application service

An opt-in, loopback-only [research application service](docs/research-application-service.md)
connects open questions, subquestions, hypotheses, exact text/timed findings, retained evidence
and supplied source-dependency reports through real HTTP routes and persistent local files.
It adds no interface or automatic retrieval. Design approval, hosted storage, and provider-backed
research remain separate work. Run `npm run research:verify` after a production build to
reproduce the synthetic HTTP, correction, restart and persistence checks.

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

For a keyless preview, no provider configuration is needed. Live use is disabled by default.
Before any live setup, read [live usage and zero-budget operation](docs/live-usage.md).
Keys alone do not enable live investigations.

Only after the free-allocation and persistent-storage checks are satisfied, place authorized
server credentials in `.env.local` (gitignored; never commit it):

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
honest disabled/configuration failure instead of falling back to fixtures, and no provider
request is dispatched. Live admission rejects before an investigation starts when the gate
is disabled or its configuration is unavailable.

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

Browser walkthroughs are zero-credit with live mode disabled. You can exercise upload,
validation and error recovery without contacting providers. Controlled public-contract
fixtures cover result rendering separately and must remain labeled as controlled evidence.

### Gated live verification (spends credits)

Live runs are for integration work, milestone verification, demo rehearsal and pre-submission
checks — never for routine testing or CI.

- Requires explicit live admission and a verified free allocation, as described in
  [live usage](docs/live-usage.md). A credential file alone is insufficient. Run **one case at
  a time, sequentially**, inside both per-run and persistent allocation limits.
- The credit gate is explicit in the harness: `--live` refuses to run unless `RUN_LIVE_TESTS=1`
  is set in the environment. That gate lives in the harness CLI, **not** in `npm test` — no
  test in `npm test` can reach a provider.
- Record **attempted / returned / retained** counts separately; a large returned count is not
  the same as independent sources.
- Do not re-run an identical input just to capture a screenshot.

### Evidence tiers

The project keeps five tiers distinct and labels every artifact with the one it came from:

| Tier | Where it happens | Credit | Proves | Does not prove |
| --- | --- | --- | --- | --- |
| `source/unit` and `function-probe` | `npm test` (Vitest, imported production functions) | 0 | budgets, contracts, policy invariants, normalization, failure boundaries | anything about the live web |
| `real-ui` | the harness driving a real built app in a browser, no provider interception | 0 | landing, upload, layout, keyboard, error states | provenance truth |
| `public-contract-boundary` | the harness intercepts `POST /api/investigate` and delivers a controlled NDJSON stream | 0 | rendering, recovery, all four report tabs | provenance truth — a fixture that renders `CONTEXT_CONFLICT` is not a fact check |
| `live` | real SerpApi + Jev through the production route (`RUN_LIVE_TESTS=1` and `--live`) | spends | what the product actually returned for that input | completeness of web coverage, or the identity of the original upload |

Keep the tiers visibly distinct in any evidence you publish. Fixtures are legitimate for tests,
development and deterministic local verification; they must never be presented as live
retrieval, and browser-controlled exceptional states do not certify provenance accuracy — both
the function layer and the browser layer are required before a finding can be called closed.

### Project verification harness

A project-owned browser harness lives at `.agents/skills/verify-contexttrail/` on the
integration branch — confirm the directory exists in your checkout before running it — with
the CLI at `.agents/skills/verify-contexttrail/bin/control-contexttrail`:

```bash
.agents/skills/verify-contexttrail/bin/control-contexttrail <launch|doctor|drive|evidence|cleanup> [args]
```

- **`launch`** snapshots a pinned revision into its own directory, runs `npm ci` + `npm run
  build` there, and starts `npm start` on an isolated port. It never builds against a live
  server's `.next` and never touches the interactive server.
- **`doctor`** is a read-only health check (owned PID, port, BUILD_ID, revision match, landing
  identity) and consumes no credit.
- **`drive <feature>`** exercises real ARIA roles/names. Implemented drives: `landing`,
  `upload`, `investigation`, `result` (desktop and mobile). Unimplemented ones report
  `unknown drive feature` instead of passing — missing coverage is recorded as **NOT VERIFIED**.
- **`evidence`** writes screenshots, ARIA snapshots, browser video, action logs and a manifest
  under `.verify/<run-id>/evidence/`; **`cleanup`** kills only the PIDs it created and removes
  the snapshot while the evidence survives.

Its **creation gate has passed** — one mapped landing feature with 26 evidence artifacts
surviving cleanup — which proves the harness runs, not that the product is accepted. The
map at `.agents/skills/verify-contexttrail/features/README.md` covers nine features; **only
four drives exist today, so entry coverage is pending**. Normal harness runs spend **zero
provider credit**.

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
- **Only core occurrences may assert media history.** The result keeps four separate buckets
  and never merges them: `timeline` holds dated **core** occurrences only
  (`EXACT_MATCH` / verified `NEAR_MATCH`); `supportingEvidence` holds dated non-core visual
  leads; `contextualEvidence` holds dated web/news rows with no media identity (identity basis
  `contextual`); `undatedEvidence` holds everything without a usable date. A contextual or
  lead row can never be read as "this image appeared there".
- **Dates.** Unknown and disputed dates never enter the dated timeline. Publication dates are
  bound to article/posting entities — a container's generic creation date cannot become a
  publication date — and impossible calendar dates are rejected. Claim-relative dates resolve
  on the browser's IANA wall clock. The result states `unknown_dates_present`,
  `disputed_dates_present` and `insufficient_dated_occurrences` rather than guessing.
- **Takeaways are gated.** A historical-reuse takeaway requires a *core* occurrence with a
  usable date that predates the claim; an undated or contextual lead cannot assert media
  history.
- **Reporting origins.** Cross-domain corroboration requires separately evidenced reporting
  origins — positive attribution in a non-negated sentence, not a bare mention of staff or
  reporters. Unresolved origins surface as `reporting_origins_unresolved`, and the
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
tabs. The Timeline view is an occurrence ledger: dated **core** occurrences sit on the line,
and **supporting leads** and **undated evidence** are rendered as visibly separate sections so
they cannot be read as confirmed media history. **Inspect evidence** opens the comparison
viewer — submitted image beside retrieved image, match basis, date source, excerpt and
reporting origin, with **Open original source** and previous/next navigation. **Technical
details** holds the lower-level identifiers.

**On the wire:** `POST /api/investigate` streams `application/x-ndjson`. `evidence.discovered`
events are emitted as each search job settles rather than after the slowest one, and
`investigation.completed` carries the final result with four evidence buckets
(`timeline`, `supportingEvidence`, `contextualEvidence`, `undatedEvidence`). The stream is
plain newline-delimited JSON — capture the response body to replay or diff it.

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

## Illustrative assets, credits and attribution

- The landing hero repeats `public/illustrative-earthrise.jpg`, labeled in the interface as
  NASA's Apollo 8 Earthrise photograph, December 24, 1968. Its context cards and static
  walkthrough are explicitly illustrative; they are not retrieved investigation evidence.
  Source and reuse details are recorded in [asset credits](docs/assets.md).
- The application also bundles its icon, favicon and local Instrument Serif / Geist Sans
  font files. Review their source and license records together with the image assets before
  redistribution. No publisher logos or customer testimonials are used as product proof.
- **Design boards — credit: AI-generated.** `contexttrail-designs/screen-designs.png` was
  produced from `contexttrail-designs/design-prompt.txt`, which is recorded as an
  *"Initial design prompt (built-in image-generation tool)"*. The prompt itself forbids real
  publisher logos, fake partnerships and statistics presented as live. These are design
  references, not product output, and this is part of the AI-tool disclosure for the project.
- **`contexttrail-designs/original-reference.png` has no recorded provenance.** It is the
  "supplied image" the design prompt refers to as a visual reference; it carries no embedded
  credit, license or source text, and no attribution file exists for it. **Do not redistribute
  it as a project asset until its source and license are established.**
- **No LICENSE file has been selected.** [Asset credits](docs/assets.md) records the image source and remaining font/reference checks.
  Any photograph, illustration or borrowed visual added later must be committed together with
  its license and attribution record — do not ship an unattributed image.

---

## Deployment (Vercel)

The original specification targets Vercel's Node runtime. The zero-budget safety gate
currently disables live operation on Vercel and other known serverless environments because
a local filesystem ledger cannot enforce a global persistent allowance there.

A keyless preview may be deployed after normal review, but it cannot prove live investigation
utility. Do not add provider keys to an unrestricted public endpoint. Hosted live operation
requires a reviewed shared atomic quota store and verified provider billing controls first.
For an authorized local live demo, follow [live usage](docs/live-usage.md).

No deployment is claimed. The hackathon's local-demo requirement and the remaining product
acceptance work are recorded in [the release checklist](docs/release.md).

### Precise retained evidence anchors

The local research service can bind findings to a pixel region in a retained user-supplied PNG or an exact cell in a structured table. Material replacement and source correction require review; withdrawal stays explicitly unavailable. CaseRecord v1 is unchanged. See [formats, limits, v1/v2 compatibility and HTTP examples](docs/precise-evidence-anchors.md). No OCR, automatic truth judgment, image-authenticity assessment, provider call or UI is added.

### Local sampled-frame comparison

The local CLI compares rights-cleared supplied videos and images and retains candidate
sampled-frame overlaps with timestamps, hashes, approximate crop regions, raw scores
and sampling limits. It does not change case contracts or make truth/identity findings.
See [local media matching](docs/local-media-matching.md).
