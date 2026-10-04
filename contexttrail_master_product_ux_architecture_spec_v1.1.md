# ContextTrail — current product and acceptance specification

Updated 4 October 2026. This file supersedes the image-first v1.1 specification, retained at [docs/archive/image-first-spec-v1.1.md](docs/archive/image-first-spec-v1.1.md). Existing code comments that cite numbered v1.1 sections refer to that archive. Implementation status is evidence, not an assertion that this entire specification is complete.

## Purpose

Someone brings a question, claim, image or video. ContextTrail does the searching, keeps relevant evidence, compares what sources actually say and explains what remains supported, challenged or unknown. The person can read retained passages inside the app, deliberately open the original, save the investigation and revisit corrections. Manual case construction is optional.

The scope includes old media recaptioned as current, reused clips, changing allegations, related claim variants, brand and product investigations, news checking, open research questions, suspicious-review patterns, advertised/received product differences and earlier appearances of claimed work. Examples do not limit the domain. Government targeting and private-person targeting are excluded. Earliest retrieved appearance never proves original publication or authorship. Multiple complaints or different domains never automatically establish independent corroboration.

## Default journey

1. The cover offers question, image and video entry points in the authored “A Place for the Question” design: cream paper, serif headlines, restrained rust and blue, collage illustrations and chapter navigation.
2. Submit a natural question or explicit claim. Media submission requires permission and explains provider transmission. Show progress and cancellation; do not require a manually assembled case.
3. Lead with readable retained evidence and its scoped relationship to the question. Keep search snippets, page passages and references distinct. The source selection audit and technical coverage details are expandable.
4. Distinguish event/capture time, page publication time, provider-inferred dates, retrieval time and video offsets. Missing dates stay missing.
5. Keep the investigation by default, with an explicit opt-out. Save questions, source text, assessments, uncertainty and provenance; exclude uploaded media bytes. Reopen the report without provider calls. Manual edits invalidate stale derived reports and preserve revision history.
6. A watch follows a question, claim, product, brand or public incident. First retrieval establishes a baseline. Subsequent checks retain newly discovered sources and changed retained samples with links to previous and current investigations. A changed search sample is not automatically a changed claim or correction.

## Current architecture

Next.js 15 and React 19 serve an editorial casebook interface. SerpApi provides public search and Google Lens leads. Pinned TypeSafe Jev assesses exact retained excerpts with validated probability distributions; it does not generate prose or certify truth. Source retrieval pins public DNS destinations, validates redirects and caps bodies and time. HTML uses Readability. Selectable-text PDFs run in a bounded worker: first twelve pages, 64,000 characters, no OCR or figure interpretation. Retained source text is rendered as text, never executed as HTML.

Automatic question research reserves up to six searches, twelve source assessments and ten page reads. It uses distinct research goals and can follow two explicit article citations within that same allocation. The research account organises exact inspected statements into relevant facets, retaining empty facets as gaps. Matching wording and plausible relationships are distinct. Ranking affects acquisition only. An official domain alone does not establish truth; a source's causal explanation is attributed rather than promoted to an established cause.

Automatic video research decodes the full visual track to two tiny luminance samples per second, keeps measured changes, and independently investigates up to three selected frames; identical encoded samples are skipped. The full bounded audio track is recognized locally with a verified multilingual Whisper model. Uncertain repeated recognition remains inspectable and cannot become a search query. Usable recognized wording receives a separately reported source investigation. Whole-run admission includes frame and spoken-research ceilings before dispatch. Completed visual or spoken work survives failure of the other part. Offsets and partial coverage remain visible. No whole-video identity, speaker, authenticity or continuity verdict follows from a sampled-frame or spoken-text lead.

`/families` automatically connects inspected wording across the newest twenty saved cases, merging identical same-page rechecks. Exact wording matches, plausible connections and same-page variants retain separate labels, dated references and links back to each case. This is a retained-source comparison, not proven social spread. Specialized review, brand, attribution and shopping research has distinct evidence facets; two supplied images can also be compared locally. Those paths still require their own real acceptance runs.

Cases and watches are stored on the local single-host filesystem. Writes use bounded validation, exclusive locks and atomic replacement. The watch worker runs inside a long-lived Node server, checks due work every thirty seconds and retains provider-budget leases. Watches pause on failure/exhausted allowance. The UI reports worker connectivity. This is not a serverless scheduler, multi-user account system or email/push notification service.

Provider keys remain server-only. A durable usage ledger reserves worst-case units before admission and holds ownership until provider work settles. Fixed grants add allowance; they never reset prior consumption. Account balances and reserved units are different quantities.

## Acceptance and present evidence

| Capability | Current state | Required acceptance |
|---|---|---|
| Automatic questions/claims | Search, bounded reading, scoped assessment, source-bound reading account | Open research must consistently recover important primary sources and explain the question adequately; issue #30 remains open |
| Images and recaptioning | Lens discovery, exact-collection policy, source inspection, dates and caption assessments | Demonstrate historical identity and earliest retrievable context on real media; issue #10 remains open |
| Video and audio | Full-track local scan and recognition, up to three selected frame searches, separate spoken-source research and saved reports | Real Delhi run retained 121 samples and three completed frame searches; crop/trim/subtitle segment identity and speaker/authenticity remain unestablished |
| Saved investigations | Default automatic save; reports reopen in question/evidence/changes views | Real saved UPI and video reports reopen with retained evidence; regression recorded as #53 |
| Watches | Real scheduled local retrieval, baseline, new/changed samples, pause/resume/check history | Real UPI scheduled check retained HTML/PDF passages; watch paused afterward; durable hosted scheduling and external notifications remain incomplete |
| Claim families/spread | Automatic cross-saved-source wording groups, exact/plausible/same-page labels and publication trails | Real saved sample exercised the route; broader meaningful variants and source-bound spread reconstruction still require acceptance |
| Brands/reviews/products | General scoped research and supplied-media comparison | Specialized independent-review investigation and advertised/received explanation require further real acceptance runs |
| Claimed work | Earlier-appearance leads and attribution uncertainty | No automatic authorship finding; dedicated workflow remains incomplete |
| Interface | Authored cover and coherent casebook chapters; expandable methods | Verify desktop/phone, source reading, original links, correction history and failures through computer use |
| Launch demonstration | Must use actual runs and retained source evidence | Narrated interactive launch must show observed behavior; do not stage invented provider successes |

The 4 October live UPI baseline retrieved no retained NPCI/RBI page despite primary candidates being present. Later retrieval read a PIB factsheet and a PDF. The final metadata-poor-document fix automatically retained RBI publication 23127 and its UPI passages in case research-c592b691-35ce-4e66-8096-09dcc71e2bd7. This verifies the reproduced selection failure; broader consistent primary-source acceptance remains open. The earlier three-frame Delhi caption run retrieved historical-demolition reports without establishing media identity. The later full-track run, `research-55069ef5-81db-4f94-95fb-9c129582f445`, retained 121 local visual samples and completed searches at 0, 10.5 and 60 seconds. Its first frame has a possible context conflict; the 10.5-second sample retains The Quint’s Jasola-demolition passage. Whole-clip identity remains unresolved. The 17 repetitive Hindi recognition segments were excluded from spoken searches. A separate authored audio run retained reporting of 24.51 billion UPI transactions. Short recognized speech now keeps all usable segments in its search query; that query change still needs a fresh provider run. Review research retained suppression and settlement reporting plus a company response, but did not recover a direct FTC page or establish fabricated reviews. Passing tests do not override these outcomes.

## Release rule

Keep current product docs distinct from historical run records. Every asserted capability needs an implemented path and appropriate verification. Record reproducible bugs on GitHub, fix them and verify through the product. Keep open acceptance goals open when real runs still fail. Never relabel a bounded search result as complete research, a visual lead as proven media identity, a model relationship as truth or a sampled-frame investigation as full video understanding.
