# Inspected historical source links

Deep reading now retains up to 12 safe HTTP(S) anchors or iframe references from paragraphs, blockquotes or figures within explicit article/main containers. Each reference keeps its resolved URL, exact supporting container text (at most 1200 characters), anchor text/title, document-order index, and anchor/embed kind. Navigation, fragment-only references, credentials, sensitive URL parameters, nonpublic literal addresses, invalid URLs and oversized supporting containers are omitted. The fetched URL resolves relative references; an untrusted HTML base tag cannot rewrite the source. DNS safety is checked again by the normal pinned page fetcher.

A reference containing media/post language and an explicit year or earlier/original temporal language is a historical **lead**. That rule selects work; it proves neither a historical date nor media identity. The 12-reference retention prefers historical leads over unrelated references, preserving document order within each class. No names, dates or titles generate URLs or search queries.

## Selection and bounds

The first four ordinary deep-read priorities stay in place. After those reads finish, one historical lead may use the fifth page slot. If no lead is admissible, the ordinary fifth candidate is read. Parent model relevance, parent canonical URL and reference document order determine a stable order, independently of network response timing or publisher reputation. Already-read links are skipped. A new linked candidate is admitted only when there is space in the existing five contextual search retention slots; at most one source-link candidate is retained. A retained candidate reached again by its inspected link keeps its independently acquired identity.

There is one hop, at most five page attempts, no extra search or upload, and the existing shared deadline/signal. The existing 24 distinct-candidate classification allowance and live worst-case request reservation remain unchanged. A page slot can classify a newly acquired linked resource instead of refining the ordinary fifth candidate. No additional semantic work is dispatched after the deadline. This does not guarantee reaching every older source: references outside the first four selected pages, the 12-link retention or free contextual capacity can remain unresolved.

The page-read audit records selected, already-read, retention-limited, page-limited, deadline-limited and unrelated references. A selected reference points to a separate candidate/page-read audit, whose fetch/extraction/binding failure remains visible. References found on the final page are retained but never recursively followed.

## Dates and identity

An article publication date belongs to its fetched resource. A year/event date reported in its text remains supporting text; it is never copied to a linked post. A linked post receives only its own bound JSON-LD/meta publication date or explicitly publication-marked time element outside quoted/embedded content. Entity binding preserves post-ID query parameters and case-sensitive paths. JSON-LD dateCreated, generic date metadata and generic time elements cannot stand in for publication, so creation/filming and reported event times remain distinct and unresolved unless separately evidenced.

A newly followed source is contextual (`source_link`) and has no media identity. A fact-check title, old year, embedded reference or hash resemblance cannot promote it. Independently retrieved Lens exact identity may still qualify on the *same* linked resource. The spatial verifier remains disabled pending its measured acceptance; this work does not claim to verify a newly linked video. Source-link dates alone do not enter the core media chronology. Shared text/attribution continues through the existing origin grouping and cannot create independent corroboration merely from another domain.

## Verification and outstanding #10 acceptance

Offline tests exercise a separately dated contextual post, a linked occurrence independently reported by Lens exact collection, unrelated references, failed reads, URL safety, retention, one-hop/page/deadline limits, event/publication separation and shared-origin counterexamples. They inject finite search/classification/page responses and make no provider calls.

The actual historical-reuse workflow has **not** been demonstrated by these fixtures. Issue #10 stays open. Its draft PR implements bounded inspection and acquisition, while a separately authorized trial must still establish a source-backed original URL and measured media relation, retain requested/final URL binding and dates, and report the actual search/retention limits. A new spatial verifier must be evaluated before enabling identity promotion. The historical trial is not hardcoded and provider requests are not part of issue triage.
