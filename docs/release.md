# Release and submission checklist

Current implementation and real-run status are recorded in [the product work log](product/work-log.md) and [the current specification](../contexttrail_master_product_ux_architecture_spec_v1.1.md). The 2 October stack and submission discussion below are historical. They are not instructions to submit or merge a new release.

## Publication on 5 October 2026

[The public ChatGPT Site](https://contexttrail.zippy17.chatgpt.site) was deployed successfully from Sites source commit `37f371845fb8a0f631b97a64b9c8362c7b5471ca`, version 1. This source is generated from the canonical UI and the adapter in `hosting/sites`. Secret runtime credentials remain outside Git and the deployment archive. Question and image investigations use private per-account D1/R2 persistence, three admission attempts per UTC day, shared durable provider reservations, and a trial expiry of 18 October 2026. Native video/audio and scheduled watches remain local features.

Verification included 1,734 passing canonical tests (17 intentional skips), typecheck and production builds, 18 isolated actual D1/R2 boundary checks, and real question and uploaded-image runs through the hosted Worker preview. The question was saved, reopened, reloaded and inspected at a retained page passage. These runs establish working retrieval and persistence; they do not establish an original image upload or a provenance verdict.

The approved [90-second launch film](https://youtu.be/iRT1YDrCMDI) is published publicly on YouTube and retained locally. YouTube reported no copyright-check issues. The video played in Chrome Incognito without sign-in, and the public repository also opened in that window. The hackathon draft includes both links and the participant information supplied by the owner; final submission awaits specific rules/terms acceptance. The historical research gates below retain their original scope.

Checked against the combined application and issue roster on 2 October 2026.
This file records gates, not release approval. Historical audits and test counts remain in
[the investigation report](https://github.com/VasuBansal7576/contexttrail/issues/3),
[research report](https://github.com/VasuBansal7576/contexttrail/issues/4) and
[docs report](https://github.com/VasuBansal7576/contexttrail/issues/5).

## Source and merge order

The image core came through PR #1. The local research application builds on
[#6](https://github.com/VasuBansal7576/contexttrail/pull/6), then
[#7](https://github.com/VasuBansal7576/contexttrail/pull/7). The owner authorized merging the
reviewed PR stack on 2 October 2026. Merge parents before their children, retarget each child
to `main` after its parent lands, and check conflicts and CI on the resulting revision.
Keep merge commits and historical branches so stacked fixes retain their ancestry.

[The follow-up index](issue-followups-20261002.md) accounts for the issue repairs and remaining gates.
Preserved historical branches are evidence records, not ready-to-merge alternatives.
In particular, do not merge the entire old evidence branch over the repaired application.

## Verification gates

| Gate | Required evidence | State |
| --- | --- | --- |
| Offline correctness | Exact revision, test totals/skips, clean typecheck and build | Run in each issue PR; CI covers every PR base |
| Rendered interface | Built revision, desktop/mobile screenshots, keyboard and overlap checks | Scoped records belong to each PR; no blanket acceptance |
| Native supplied-media workflow | Actual FFmpeg decode, checked frame hashes, local save/reopen | Separate from provider provenance; test with synthetic supplied media |
| Strong image provenance | Real dated core chain, inspected sources and independent reporting-origin evidence where claimed | Open |
| Historical linked-video recovery | Actual earlier occurrence acquired and media relation verified under existing bounds | Open, tracked in #10; offline controls cannot close it |
| Near-match verifier | Measured held-out spatial identity acceptance and counterexamples | Disabled; no promotion until accepted |
| Demo | Under-three-minute local functionality recording using retained real results | Separate acceptance; no duplicate provider run for recording |
| Public live hosting | Reviewed shared durable atomic quotas and account/storage boundary | Published bounded question/image Sites edition; see the 5 October record above |
| Redistribution | Owner-selected project license, complete font/reference/artwork provenance | Open |

Normal checks use no keys or provider credits:

```sh
npm ci
npm test
npm run typecheck
npm run build
```

Use a separate checkout for builds when a server is running. Service and browser verification
commands are in the README and their feature documentation. Never describe a controlled
NDJSON result as live evidence. The maintained harness implements landing, upload,
investigation, result, viewer, session and accessibility; unsupported inputs fail closed.

## Bounded real-case plan

The candidate list in [issue #4](https://github.com/VasuBansal7576/contexttrail/issues/4)
is research, not a set of verified ContextTrail results. Floyd with a Katrina caption and
the Situation Room trace remain candidate trials. Migrant Mother is an alternate.
The copyrighted Tomb photograph remains excluded. Earthrise is illustrative and is not
claimed as a strong headline demonstration.

Before a trial, verify the current source/license, remaining allocation, billing controls,
exact workflow reservation and destinations through [live usage](live-usage.md). Enable
only the authorized single-host persistent service, run cases sequentially, and retain
attempted/returned/retained counts and the original result. Do not reset an exhausted ledger.

- [ ] Strong Trace case with a dated core chain and inspected timeline.
- [ ] Strong caption conflict, with each stronger claim supported by the policy gates.
- [ ] Honest limited/uncertain result and failure/recovery path.
- [ ] Actual exact-match empty versus failure behavior and provider accounting.
- [ ] Historical source follow-up demonstrated separately from offline fixtures.
- [ ] Full walkthrough retained before editing the submission recording.

The retired About This Image provider surface is not dispatched and must not be shown as a
successful live stage in a new recording. Article publication, linked-post publication,
reported event and filming dates retain their separate meanings. Hash resemblance and a
fact-check title cannot establish media identity.

## Submission requirements

The [official hackathon site](https://serpapi.github.io/serpapi-india-hackathon-2026/) and
[announcement](https://serpapi.com/blog/introducing-the-serpapi-india-hackathon-2026/)
were checked on 2 October 2026. Both now give **10 October 2026, 23:59 IST**.
The earlier report's blog-date conflict has been resolved. The project's 5 October freeze
remains an internal target. Recheck the official rules before submission.

The official checklist requires a public code repository with setup instructions, a public
or unlisted functionality video under three minutes showing local execution, a description
and track, participant details, AI-tool disclosures and acceptance of the rules/terms.
Participant data and eligibility remain for the owner to confirm in the actual form.

- [ ] Public repository and demo links work in a private browser window.
- [ ] README describes the exact revision, opt-ins, commands and retention limits.
- [ ] Video shows working functionality with its actual evidence and uncertainty.
- [ ] Participant/team details and AI-tool disclosures are accurate.
- [ ] Required source/font/artwork records and owner-selected software license are complete.
- [ ] No unlicensed supplied reference is redistributed as a product/demo asset.
- [ ] Final reviewed source matches the recording; pending PRs are not described as merged.
- [ ] Owner submits through the dashboard before the deadline.

The submission requirements above do not mandate a hosted live deployment. Deployment,
merging PRs, spending provider allocation and submitting the entry are separate actions.
No release is certified by this documentation update.
