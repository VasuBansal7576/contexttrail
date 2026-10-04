# Automatic investigations

The primary paths are `/questions`, `/investigate` and `/video`. Manual evidence entry is optional. The cover follows the authored “A Place for the Question” reference.

Questions use three bounded searches, retain at most eight sources and read a bounded subset of HTML or selectable-text PDF pages. The result presents exact retained passages, source links, publication/retrieval distinctions, scoped excerpt assessments and remaining leads. Choose “Check a claim” to compare the exact assertion with the retained passages. The `Claim:` prefix is also supported for pasted input; a broad question remains a broad question. No invented user claim or unsourced generated answer is substituted.

Video research decodes up to three moments from a supplied video of at most 32 MB / 120 seconds. Distinct sampled frames are searched independently. Caption mode reserves at most 18 searches, 3 uploads, 180 Jev requests and 816 questions across the entire video. Trace mode reserves 12 / 3 / 180 / 339. These are worst-case reservations, not actual usage. Audio and unsampled intervals are not investigated. Per-frame offsets are not publication dates; even verified stills cannot establish whole-video identity or authenticity.

Both paths keep completed investigations in the local casebook by default. Uncheck “Keep this investigation in my casebook” to opt out. Retained reports exclude original uploads and frame bytes. Reopening performs no provider retrieval. Source edits invalidate stale derived reports; historical revisions remain available.

HTML/PDF source text is untrusted material. PDFs are read in an isolated bounded worker, with at most twelve pages / 64,000 characters; OCR, figures and scanned pages are unsupported. Page-reading failure preserves a search lead with its original attribution. A search snippet never silently becomes a page quote.

A live UPI research run and a three-frame Delhi caption investigation on 4 October 2026 expose remaining acceptance gaps. Important primary sources and historical-media identity are not consistently established. See the [current specification](../contexttrail_master_product_ux_architecture_spec_v1.1.md) and [product work log](product/work-log.md).

For ongoing retrieval, see [automatic watches](automatic-watches.md). Keys, finite provider allowance and single-host persistence are required for live paths. Keyless previews do not contact providers.
