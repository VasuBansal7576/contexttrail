# Automatic local watches

Open `/watch`, enter a question about a claim, product, brand or public incident, and choose daily or hourly checks. The first check runs within thirty seconds while the local Node server is running. Its sources establish a baseline. Later checks retain new passages, new source leads and changed retained samples, with links to current and previous saved investigations.

Pause/resume and Check now are available in the app. Pausing preserves history. A failed check or exhausted provider allowance pauses the watch; the app does not silently retry paid work indefinitely. There are no email or push notifications. The watch page is the alert inbox.

## Setup

Use Node 22.13 or newer, a persistent single-host data root, server-only provider keys, the durable usage ledger and `CONTEXTTRAIL_RESEARCH_LOCAL=1`. Run `npm run dev` or a built `npm run start` on loopback. The same live-admission configuration used for automatic questions governs watches. Each check reserves up to 6 searches, 12 Jev requests and 60 questions. The ledger counts reservations conservatively; it is not the provider account balance.

The worker runs through Next.js Node instrumentation and reports a recent heartbeat. A stopped server performs no checks. Serverless deployment, multiple hosts, browser-closed scheduling without a running server and user account isolation are not implemented.

Watches retain at most 100 watches, 1,000 source fingerprints per watch and the most recent 50 check summaries. Saved investigations remain in the casebook. Store corruption and unexplained locks fail closed rather than discarding evidence. Changed samples may reflect different search snippets or selected paragraphs; inspect both samples before claiming the original page was corrected. Different URLs may repeat one report.

Manual import/comparison tools remain documented separately in [manual-watchlists.md](manual-watchlists.md).
