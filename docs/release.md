# Release and submission checklist

Working notes for shipping ContextTrail. Everything here is written to be publishable: no
secrets, no private machine paths, and no claim that has not been earned.

**Nothing in this file is a submission.** It does not fill in any form, does not record
participant or team details, and does not assert eligibility. Re-verify every external rule
against the official sources below on the day you submit.

---

## 1. Primary sources

| What | Where |
| --- | --- |
| Official hackathon site (authoritative for rules, dates and requirements) | <https://serpapi.github.io/serpapi-india-hackathon-2026/> |
| Blog announcement (secondary, conflicts on date — see §3) | <https://serpapi.com/blog/introducing-the-serpapi-india-hackathon-2026/> |
| Public repository | <https://github.com/VasuBansal7576/contexttrail> |
| The product specification this build implements | `contexttrail_master_product_ux_architecture_spec_v1.1.md` in this repository |

Track: **Knowledge & Public Interest (news literacy)**, matching the PRD's stated hackathon
fit. Participant eligibility, team size, and all submission fields are defined by the official
site and Rules — confirm them there; they are deliberately not restated as fact here.

---

## 2. Where the product actually stands

An independent audit of the integration returned **NO-GO** against the project's own
definition of done:

- **18 findings — 8 P1, 10 P2, no P0.** The P1s are evidence-integrity defects (reporting-origin
  inference, timeline membership, dropped adaptive evidence, comparison gaps, sampled context
  counts, entity-agnostic publication dates, an ungated historical-reuse takeaway) plus the
  release-evidence gap itself: at audit time there was no top-level run/demo guide, no
  project-owned browser harness, and no proven strong live provenance case.
- Grouped PRD coverage: **23 PASS / 61 PARTIAL / 26 FAIL / 4 NOT VERIFIED** across 114
  requirement rows covering all 4,193 PRD lines.
- **No strong live Trace/divergence case and no strong live claim case has been demonstrated.**
  The two real runs that exist stayed conservative (`LIMITED_MEDIA_HISTORY_FOUND` and
  `INSUFFICIENT_EVIDENCE`), which is an honest outcome, not a proven flagship result.

Repairs have partly landed (below). **Do not describe the release as passed, and do not treat a
synthetic or fixture-rendered status as real proof.**

### What each "pass" number actually means

Three different things get called "tests pass". Keep them apart:

| Tier | What ran | Result | What it does **not** cover |
| --- | --- | --- | --- |
| **Baseline checks** — the audited baseline this documentation was drafted against | `npm test`, `npm run typecheck`, `npm run build` | **143 tests / 20 files**, typecheck clean, build succeeds (independently re-run) | browser behavior, live providers, any release gate |
| **Backend repair head** — reported by the backend lane and independently re-run here | the same three commands plus the Phase 0 regression gates | **161 passed + 2 skipped / 22 files (163 collected)**, typecheck clean, build succeeds | browser behavior, live providers; backend full-suite validation still in progress |
| **Integrated browser + gated live acceptance** | the project harness driving a built app in a real browser, then gated live runs against real providers | **not run** | — |

Only the third tier could ever support a release claim, and it has not happened.

### Current blockers

| Blocker | State |
| --- | --- |
| **Evidence-integrity repairs (P1)** | **Partly landed.** Backend repairs for F01–F03 and F05–F11 are in, and the Phase 0 regression gates — which were written to *reproduce* each defect and failed before the repair — now pass (161 passed, 2 skipped on the repair head). Remaining findings and UI-side work are not closed, so this is repair progress, not acceptance. |
| **Integrated browser verification** | Not run against the repaired build. The audit's browser coverage predates the repair. |
| **Strong live milestone cases** | Not run. PRD requires at minimum one strong Trace, one strong claim conflict, one limited/uncertain, and one failure/degradation case. |
| **Verification harness** | Creation gate passed (one mapped landing feature, 26 evidence artifacts surviving cleanup); the doctor records an identity proof for the build it launched. **Four of nine drives exist** (`landing`, `upload`, `investigation`, `result`); the rest report `unknown drive feature` and are recorded as NOT VERIFIED, never silently passed. CLI expansion to all nine mapped features is **underway** — nine-map entry coverage stays marked **pending** until its expansion commit lands, and must not be described as complete. |
| **Observability** | Structured success telemetry is absent; only sanitized failure warnings exist. |
| **Browsers** | Chrome only. Edge, Safari, Firefox and real mobile engines are unverified. |
| **Asset credits / licensing** | No `LICENSE` and no attribution document exist. `contexttrail-designs/screen-designs.png` is AI-generated and credited in the README; `contexttrail-designs/original-reference.png` has **no recorded provenance or license** and must not be redistributed until that is established. |
| **Account / auth for deployment** | Vercel CLI is not installed, there is no stored Vercel login state, and this repository is not linked to a Vercel project. Deployment prerequisites are unmet — this says nothing about whether an account exists. No login is performed from this repository or this document. |
| **Publication / merge** | The public repository exists and is seeded; product branches are still local-only and the merge into `main` is pending. |

---

## 3. Dates

| Date | Meaning | Source |
| --- | --- | --- |
| **Oct 5, 2026** | **Internal code/content freeze** — PRD §1.9 internal target, leaving buffer for demo capture, repository cleanup, submission validation and external-service surprises. | This project's PRD |
| **Oct 10, 2026, 23:59 IST** | **Official submission cutoff.** | Official hackathon site |

**Conflict, stated plainly:** the blog announcement gives **October 5, 2026, 11:59 PM IST**,
which is earlier than the official site's Oct 10. The official site is authoritative and its
Oct 10 date already matches the PRD, so **Oct 5 is treated as the internal freeze margin, not a
second deadline**. Re-both-check before submitting; if the official site ever moves to Oct 5,
the freeze buffer disappears entirely.

---

## 4. Bounded live-case checklist

### What must be proven (PRD §38.4)

- [ ] One **strong Trace** case — dated core occurrences, inspected timeline.
- [ ] One **strong Claim-check conflict** case.
- [ ] One **limited / uncertain** case.
- [ ] One **failure / degradation** case.
- [ ] A case proving **dedicated exact-match retrieval and normalization**, and a case where
      `type=all` returns only a navigation flag/link.
- [ ] **Empty** and **failed** exact-match results shown as distinct outcomes.
- [ ] Near-match verifier readiness **not** claimed until its held-out fixtures and live-image
      acceptance gate pass (promotion is currently disabled and reported as such).

### Candidate inputs (public-domain / clean license)

| # | Input | Role | License |
| --- | --- | --- | --- |
| **B** | NOAA GOES *Hurricane Floyd*, `Hurricane Floyd 1999-09-14.jpg`, 14 Sep 1999 | **Conflict / context-change run** — the same frame recirculated as Frances, the 2004 tsunami, Katrina and later storms; pair with the documented Katrina miscaption claim | Public domain (US federal / NOAA work) |
| **A** | Situation Room photograph, Pete Souza, 1 May 2011 | **Trace / history run** — heavily republished on dated pages over 15 years | Public domain (US federal work) |
| **D** | *Migrant Mother*, Dorothea Lange, March 1936 | **Consistent / no-conflict third** — use the uncontroversial photographer/place/date claim only | Public domain (FSA/OWI) |
| **C** | Tomb of the Unknowns sentinels, 2012 | **Excluded from use.** Copyrighted; must not ship in repository or demo assets. Its dated debunk trail is reference context only | Not licensed for reuse |
| — | NASA Earthrise | Retired as the headline case — dated-core yield was weak | — |

Download the original frames at run time from their Commons/Wikimedia file pages; do not commit
multi-megabyte originals into the repository. The app's client preprocessing already caps the
long edge at 1600 px and the payload at 450 KB.

### Capping rules for every run

- **Trace ≤ 4 SerpApi search requests; Claim-check ≤ 6.** One image-upload attempt (not a
  search). At most one adaptive expansion. See the README's budgets section.
- Run cases **sequentially**, one at a time. Record **attempted / returned / retained** counts
  separately — a large returned count is not independent-source coverage.
- The free development allowance is limited (the hackathon material lists 250 SerpApi search
  credits per month — re-verify against the official site).
- **Never re-run an identical input just to capture a screenshot.**
- Fixtures are for tests, development and deterministic local verification. They must never be
  presented as live retrieval, and the production route must never silently fall back to them.

---

## 5. Demo video requirements

From the official site, the submission needs a **demo video under three minutes that shows the
project running locally**, delivered as a public/unlisted YouTube link, a Drive link, or
equivalent, together with a project description, track, disclosures including AI tools used,
and acceptance of the Rules/Terms. Participant details are collected by the form itself —
nothing is invented here.

### The PRD's three-minute flow (§41)

| Time | Beat |
| --- | --- |
| 0:00–0:20 | Problem — *"Every image has a history."* Real images reused with new contexts. No architecture talk. |
| 0:20–0:35 | Input — upload a known strong-live-result image, paste a misleading claim, start. |
| 0:35–1:10 | Live investigation — real streamed Google Lens / About This Image / Search / News stages and counts. Evidence appearing progressively is the key visual. |
| 1:10–1:40 | Result summary — context status, earliest observed occurrence, source domains, observed contexts. Keep it brief. |
| 1:40–2:20 | Timeline — same image, earlier occurrence, later reuse, transition, first observed divergence, submitted claim. **This is the centerpiece.** |
| 2:20–2:45 | Evidence viewer — source, date, excerpt, media relationship, context relationship, original source link. |
| 2:45–3:00 | Technical proof — Analysis / technical details, make SerpApi's role visible. End on *"Search finds pages. ContextTrail reconstructs provenance."* |

### Hard rules for the video

- **The calls must be live.** PRD §40: the demo route may never silently switch to fixtures.
  If a live service fails during recording, show the real failure state.
- **No fabricated anything** — search counts, timeline dates, source names, publishers,
  excerpts, model judgments, progress percentages or accuracy metrics.
- **Official rules require the video to show the project running locally.** The PRD's Vercel
  deployment (§5.2) is a *product acceptance* goal, not a submission requirement — a local
  `npm run build && npm start` run satisfies the video requirement, and un-deployed status does
  not invalidate a submission.
- A case may be *chosen* because it is known to produce strong live results; the calls
  themselves must still be genuinely live.

---

## 6. Recording strategy: full walkthrough vs submission cut

Two different artifacts — do not confuse them:

1. **Full walkthrough recording (internal).** One long, uncut session driving the app end to
   end: every stage, all four report tabs, the evidence viewer, a failure/recovery path, and
   the technical drawer. Longer than three minutes is fine — this is the internal record for
   review and evidence, and it is **not** the submission artifact.
2. **Submission cut (≤ 3 minutes).** A separate, edited cut assembled strictly to the §41 beat
   table above, from a live run, with the strongest available case. This is what gets submitted.

Record the full walkthrough first so the cut never forces a re-run of a credit-spending
investigation. Keep the raw recording; do not submit it as-is.

---

## 7. Repository requirements for submission

- [ ] Repository is **public**: <https://github.com/VasuBansal7576/contexttrail>
- [ ] Top-level README contains purpose, prerequisites, exact install/run/test commands, and
      the server-only environment variable names (with placeholders, never real values).
- [ ] No secrets anywhere in the tree, in commit history, in screenshots or in the recording.
- [ ] No `.env.local`, no credential values, no provider URLs carrying keys.
- [ ] No copyrighted demo input committed (see input **C** above).
- [ ] **Asset credits are complete.** Design boards are credited as AI-generated (see the
      README); `contexttrail-designs/original-reference.png` is either credited with a source
      and license or removed before publication — it currently has neither.
- [ ] **AI-tool disclosure is written for the submission form** (this project uses AI coding
      assistance and an image-generation tool for the design boards; the form's own wording is
      the authority — fill it there, not here).
- [ ] Merge of the product branches into `main` completed and the public tree matches what the
      video shows.

---

## 8. What has *not* been verified

Not represented as passed anywhere in this repository:

- a real strong Trace/divergence; a real `CONTEXT_CONFLICT` or `NO_CONFLICT_FOUND`;
- separate reporting-origin evidence across real corroborating sources;
- a complete real dated core chain;
- **any browser verification of the repaired build** — the recorded browser coverage predates
  the evidence-integrity repairs, and the two real live runs predate them too, so no live case
  yet demonstrates the repaired behavior;
- near-match verification (promotion is disabled pending its acceptance gate);
- real provider-specific cancellation/failure accounting;
- the 55-second partial cutoff and 90-second client watchdog observed end-to-end;
- clipboard paste and every image codec/fallback;
- Edge/Safari/Firefox, real mobile engines and full screen-reader coverage;
- a deployed Vercel build and any public integration;
- current external hackathon and provider-rule recertification.

Two live runs are not a performance distribution, and a synthetic strong status is not a real
provenance result.
