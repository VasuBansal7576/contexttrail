/**
 * Screen 6 — Evidence viewer (spec sections 3.14, 4.8).
 *
 * Dark immersive modal. Shows submitted and retrieved images side by side
 * (accessible toggle on narrow screens), source details with attributed
 * excerpts, and collapsible technical details. Missing images or excerpts
 * render as explicit limitations — never substituted or invented.
 */
"use client";

import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  attributableSpan,
  claimComparisonsFor,
  comparisonSelected,
  comparisonsForOccurrence,
  dateProvenanceOf,
  dateSourceLabel,
  displayAttributionOf,
  fullExcerptText,
  identityBasis,
  identityBasisDetailOf,
  jevDistributionsOf,
  mediaRelationshipText,
  originStatusLabel,
  originSupportOf,
  pageMetadataOf,
  reportingOriginLabel,
  resultTypeLabel,
  retrievalEngineLabel,
  searchIdsOf,
  type AttributableSpan,
  type ClaimComparisonView,
  type ComparisonView,
  type DistributionGroup,
  type PageMetadataView,
} from "./evidence-display";
import {
  occurrenceDate,
  occurrenceDatePrecision,
  occurrenceId,
  occurrenceImage,
  occurrencePosition,
  str,
  type JsonRecord,
} from "@/lib/stream/result-view";
import { Badge } from "@/components/ui";
import { cn } from "@/components/cn";

interface EvidenceViewerProps {
  open: boolean;
  items: JsonRecord[];
  index: number;
  submittedImageUrl: string | null;
  claim: string | null;
  /**
   * Restores focus after the viewer closes. Owned by the parent so the opener
   * (and its fallback) is decided where the opener was recorded, and so focus
   * can be put back synchronously as well as after unmount.
   */
  onRestoreFocus: () => void;
  /** Why this occurrence was opened (takeaway / divergence entry). */
  entryNote: string | null;
  /** The paired divergence endpoint id, when the open item is half of a pair. */
  pairId: string | null;
  /** Performed context comparisons for the whole result (§14, §20, §34). */
  comparisons: ComparisonView[];
  /** The full result, for result-level comparison lookup; may be null. */
  result: JsonRecord | null;
  onJumpToId: (id: string) => void;
  onClose: () => void;
  onNavigate: (index: number) => void;
}

/** A labelled technical field. Null values are never rendered as blanks. */
function Field({ label, value }: { label: string; value: string | null }) {
  if (value === null) return null;
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 font-medium text-white/60">{label}:</dt>
      <dd className="min-w-0 break-all">{value}</dd>
    </div>
  );
}

/**
 * One question's actual per-option probabilities.
 *
 * Both the option label and its value are AA on this surface: the viewer sits
 * on `bg-deep` under `bg-white/5`, where a dimmed value measured 3.75:1 and
 * read as an afterthought next to its own label. The value is the data, so it
 * is never the dimmer of the two, and it is exposed to assistive technology
 * as ordinary text rather than duplicated for it.
 */
function DistributionList({ options }: { options: Array<{ label: string; value: number }> }) {
  return (
    <ul className="mt-1 space-y-0.5">
      {options.map((o) => (
        <li key={o.label} className="flex flex-wrap items-baseline gap-x-2 text-xs">
          <span className="text-white/70">{o.label}</span>
          <span className="tabular-nums text-white/80">{o.value.toFixed(3)}</span>
        </li>
      ))}
    </ul>
  );
}

function DistributionGroupBlock({ group }: { group: DistributionGroup }) {
  return (
    <div className="mt-2">
      <p className="text-xs font-medium text-white/75">{group.label}</p>
      {group.options ? (
        <DistributionList options={group.options} />
      ) : (
        <p className="text-xs text-white/55">{group.notAnswered}</p>
      )}
    </div>
  );
}

/**
 * A claim-relative question whose verified answers are already shown, per
 * occurrence, in the claim-comparison block below. Pointing there instead of
 * repeating the same numbers keeps the disclosure readable and makes the two
 * comparison scopes unmistakable.
 */
function DeferredGroupBlock({ group, shownUnder }: { group: DistributionGroup; shownUnder: string }) {
  return (
    <div className="mt-2">
      <p className="text-xs font-medium text-white/75">{group.label}</p>
      <p className="text-xs text-white/55">
        Answered for this occurrence — see {shownUnder} below. Same verified answers, listed
        once per occurrence.
      </p>
    </div>
  );
}

/**
 * Descriptive page metadata, shown as inert text. Values are rendered as text
 * nodes inside a definition list — never as links, images, or markup — so an
 * `og:url` carrying a `javascript:` (or any other) scheme is displayed as the
 * descriptive string it is and can never be activated or navigated to. The
 * validated source/canonical link above is the only navigation in the viewer.
 */
function PageMetadataBlock({ metadata }: { metadata: PageMetadataView }) {
  return (
    <div className="mt-3">
      <p className="text-xs font-medium text-white/75">Page metadata</p>
      <p className="mt-1 text-xs text-white/55">
        Descriptive text copied from the page&apos;s own structured data. It is shown as text
        only — it is not a link, and it is not used to navigate anywhere.
      </p>
      {metadata.entities.length > 0 ? (
        <ul className="mt-1 space-y-1">
          {metadata.entities.map((entity, i) => (
            <li key={i} className="min-w-0 text-xs text-white/60">
              <span className="text-white/70">Structured data {entity.binding}:</span>
              <dl className="mt-0.5 space-y-0.5">
                {entity.fields.map((f) => (
                  <div key={f.label} className="flex gap-2">
                    <dt className="shrink-0 text-white/50">{f.label}:</dt>
                    <dd className="min-w-0 break-words">{f.value}</dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ul>
      ) : null}
      {metadata.openGraph.length > 0 ? (
        <dl className="mt-1 space-y-0.5">
          {metadata.openGraph.map((pair) => (
            <div key={pair.property} className="flex min-w-0 gap-2 text-xs text-white/60">
              <dt className="shrink-0 text-white/50">{pair.property}:</dt>
              <dd className="min-w-0 break-all">{pair.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

function ComparisonBlock({
  comparison,
  occurrenceKey,
}: {
  comparison: ComparisonView;
  occurrenceKey: string;
}) {
  // Direction is read from the pair's own endpoints against the occurrence
  // being inspected, so the label can never claim the wrong side.
  const arrives = comparison.toId === occurrenceKey;
  return (
    <div className="mt-2">
      <p className="text-xs text-white/75">
        {arrives ? "Against the previous occurrence: " : "Against the next occurrence: "}
        {comparison.label}
      </p>
      {comparison.options ? (
        <DistributionList options={comparison.options} />
      ) : (
        <p className="text-xs text-white/55">No pairwise answer was recorded for this pair.</p>
      )}
    </div>
  );
}

/**
 * Claim/context questions answered about THIS occurrence. Kept separate from
 * the occurrence-to-occurrence block above: one dated candidate can carry a
 * claim comparison with no adjacent pair at all, and the two answer different
 * questions about different things.
 */
function ClaimComparisonBlock({ comparison }: { comparison: ClaimComparisonView }) {
  return (
    <div className="mt-2">
      <p className="text-xs text-white/75">{comparison.questionLabel}</p>
      {comparison.options.length > 0 ? (
        <DistributionList options={comparison.options} />
      ) : (
        <p className="text-xs text-white/55">
          The classification model returned no answer for this question about this occurrence.
        </p>
      )}
    </div>
  );
}

function TechnicalDetails({
  occurrence,
  occurrenceKey,
  claimSubmitted,
  comparisons,
  claimComparisons,
}: {
  occurrence: JsonRecord;
  occurrenceKey: string;
  claimSubmitted: boolean;
  comparisons: ComparisonView[];
  claimComparisons: ClaimComparisonView[];
}) {
  const dateKey =
    str(occurrence, "dateSource") ??
    str(occurrence, "publicationDateSource") ??
    str(occurrence, "publishedAtSource");
  const searchIds = searchIdsOf(occurrence);
  const distributions = jevDistributionsOf(occurrence, { claimSubmitted });
  const pageMetadata = pageMetadataOf(occurrence);
  const sourceUrl = str(occurrence, "sourceUrl") ?? str(occurrence, "url");

  const rows: Array<[string, string | null]> = [
    ["Search ids", searchIds.length > 0 ? searchIds.join(", ") : null],
    ["Retrieval engine", retrievalEngineLabel(occurrence)],
    ["Result type", resultTypeLabel(occurrence)],
    ["Result position", occurrencePosition(occurrence)],
    ["Source URL", sourceUrl],
    ["Canonical URL", str(occurrence, "canonicalUrl")],
    ["Media relationship", mediaRelationshipText(occurrence)],
    ["Publication-date source", dateSourceLabel(dateKey)],
    ["Retrieved at", str(occurrence, "retrievedAt") ?? str(occurrence, "retrievalTimestamp")],
  ];
  const visible = rows.filter(([, v]) => v !== null);
  const hasDistributionWork =
    distributions !== null &&
    (distributions.relevance !== null || distributions.groups.some((g) => g.options !== null));

  if (
    visible.length === 0 &&
    !hasDistributionWork &&
    comparisons.length === 0 &&
    claimComparisons.length === 0 &&
    !pageMetadata
  ) {
    return null;
  }

  return (
    <details className="mt-4 rounded-lg bg-white/5 px-4 py-3 ring-1 ring-white/10">
      <summary className="min-h-[44px] cursor-pointer text-sm font-medium text-white/80">
        Technical details
      </summary>
      {visible.length > 0 ? (
        <dl className="mt-2 space-y-1 text-xs text-white/70">
          {visible.map(([label, value]) => (
            <Field key={label} label={label} value={value} />
          ))}
        </dl>
      ) : (
        <p className="mt-2 text-xs text-white/55">
          No retrieval fields were reported for this occurrence.
        </p>
      )}
      {searchIds.length === 0 ? (
        <p className="mt-1 text-xs text-white/55">
          The provider reported no search id for this retrieval.
        </p>
      ) : null}

      {distributions ? (
        <div className="mt-3">
          <p className="text-xs font-medium text-white/75">
            Classification question answers
            {distributions.model ? ` · ${distributions.model}` : ""}
          </p>
          <p className="mt-1 text-xs text-white/55">
            These are the classification model&apos;s answers to fixed questions about this page.
            They are not a confidence, accuracy or credibility score, and they are never combined
            into one.
          </p>
          {distributions.relevance ? (
            <div className="mt-2">
              <p className="text-xs font-medium text-white/75">Relevance</p>
              <DistributionList options={distributions.relevance} />
            </div>
          ) : (
            <p className="mt-2 text-xs text-white/55">
              No relevance answer was recorded for this occurrence.
            </p>
          )}
          {distributions.groups.map((group) => {
            // A claim-relative question with a verified per-occurrence answer is
            // shown once, in the claim block; only deferred when it is really
            // there, so an older payload without it still shows the answer.
            const claimQuestion =
              group.id === "contextRelation"
                ? "context_relation"
                : group.id === "claimRelation"
                  ? "claim_relation"
                  : null;
            const deferred =
              claimQuestion !== null &&
              claimComparisons.some((c) => c.question === claimQuestion && c.options.length > 0);
            return deferred ? (
              <DeferredGroupBlock
                key={group.id}
                group={group}
                shownUnder="Comparison with your claim"
              />
            ) : (
              <DistributionGroupBlock key={group.id} group={group} />
            );
          })}
        </div>
      ) : (
        <p className="mt-3 text-xs text-white/55">
          No classification answers were recorded for this occurrence.
        </p>
      )}

      <div className="mt-3">
        <p className="text-xs font-medium text-white/75">Context comparison</p>
        {comparisons.length === 0 ? (
          <p className="mt-1 text-xs text-white/55">
            This occurrence took part in no comparison with another occurrence.
          </p>
        ) : (
          <>
            {comparisons.map((c) => (
              <ComparisonBlock key={c.pairId} comparison={c} occurrenceKey={occurrenceKey} />
            ))}
            <p className="mt-1 text-xs text-white/50">
              These compare two retrieved occurrences with each other.
            </p>
          </>
        )}
      </div>

      {claimSubmitted ? (
        <div className="mt-3">
          <p className="text-xs font-medium text-white/75">Comparison with your claim</p>
          {claimComparisons.length === 0 ? (
            <p className="mt-1 text-xs text-white/55">
              No claim comparison was recorded for this occurrence.
            </p>
          ) : (
            <>
              {claimComparisons.map((c, i) => (
                <ClaimComparisonBlock key={`${c.occurrenceId}-${c.question ?? i}`} comparison={c} />
              ))}
              <p className="mt-1 text-xs text-white/50">
                These are this occurrence&apos;s own answers about your claim, separate from the
                occurrence-to-occurrence comparisons above.
              </p>
            </>
          )}
        </div>
      ) : null}

      {pageMetadata ? <PageMetadataBlock metadata={pageMetadata} /> : null}

      <p className="mt-3 break-all text-xs text-white/60">Occurrence ID: {occurrenceKey}</p>
    </details>
  );
}

export default function EvidenceViewer({
  open,
  items,
  index,
  submittedImageUrl,
  claim,
  onRestoreFocus,
  entryNote,
  pairId,
  comparisons,
  result,
  onJumpToId,
  onClose,
  onNavigate,
}: EvidenceViewerProps) {
  const [mobileTab, setMobileTab] = useState<"submitted" | "retrieved">("retrieved");
  /** Remote retrieved-image URL that failed to load (per-occurrence). */
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);
  const occurrence = items[index] ?? null;

  useEffect(() => {
    if (open) setMobileTab("retrieved");
  }, [open, index]);

  const title = occurrence ? (str(occurrence, "title") ?? "Untitled result") : "Evidence";
  const domain = occurrence ? str(occurrence, "domain") : null;
  const url = occurrence ? (str(occurrence, "url") ?? str(occurrence, "sourceUrl")) : null;
  const retrievedImage = occurrence ? occurrenceImage(occurrence) : null;
  const retrievedImageFailed = retrievedImage !== null && failedImageUrl === retrievedImage;

  useEffect(() => {
    setFailedImageUrl(null);
  }, [index, retrievedImage]);
  const mediaLabel = occurrence ? identityBasis(occurrence) : null;
  const date = occurrence ? occurrenceDate(occurrence) : null;
  const precision = occurrence ? occurrenceDatePrecision(occurrence) : null;
  const dateKey = occurrence
    ? (str(occurrence, "dateSource") ??
      str(occurrence, "publicationDateSource") ??
      str(occurrence, "publishedAtSource"))
    : null;
  const dateSource = dateSourceLabel(dateKey);
  // Typed additive provenance (R4) with flat-field fallbacks so older
  // payloads keep their accepted rendering.
  const dateProv = occurrence ? dateProvenanceOf(occurrence) : null;
  const originSup = occurrence ? originSupportOf(occurrence) : null;
  const identityDetail = occurrence ? identityBasisDetailOf(occurrence) : null;
  const compared = occurrence ? comparisonSelected(occurrence) : null;
  const shownDate = dateProv?.value ?? date;
  const shownPrecision = dateProv?.precision ?? precision;
  const shownDateSource = dateProv?.sourceLabel ?? dateSource;
  const origin = occurrence ? reportingOriginLabel(occurrence) : null;
  const shownOrigin = originSup ? originStatusLabel(originSup.status) : origin;
  const span: AttributableSpan | null = occurrence ? attributableSpan(occurrence, 600) : null;
  const fullText = occurrence ? fullExcerptText(occurrence) : null;
  const showFullText =
    fullText !== null && span !== null && fullText.length > span.text.length + 1;

  const position = items.length > 0 ? `${Math.min(index + 1, items.length)} of ${items.length}` : "0 of 0";

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70" />
        <Dialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(e) => {
            // Backstop only: the parent restores focus synchronously as the
            // viewer closes, so focus is never parked on <body> in between.
            e.preventDefault();
            onRestoreFocus();
          }}
          // `overflow-x-hidden` is a backstop, not the fix: every long value
          // below wraps on its own, so nothing is clipped or dropped. It stops
          // one unbreakable token from turning the whole dialog into a
          // horizontally scrolling surface.
          className="fixed inset-0 z-50 overflow-y-auto overflow-x-hidden bg-deep text-white"
        >
          <div className="mx-auto w-full min-w-0 max-w-[1280px] px-5 py-5 sm:px-8">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="inline-flex min-h-[44px] items-center gap-2 rounded-full px-4 text-sm text-white/80 ring-1 ring-white/25 transition hover:text-white hover:ring-white/50"
                >
                  <span aria-hidden="true">←</span> Back to timeline
                </button>
              </Dialog.Close>
              <div className="flex items-center gap-2" role="group" aria-label="Browse evidence">
                <button
                  type="button"
                  disabled={index <= 0}
                  onClick={() => onNavigate(index - 1)}
                  aria-label="Previous evidence"
                  className="min-h-[44px] rounded-full px-4 text-sm ring-1 ring-white/25 transition enabled:hover:ring-white/50 disabled:opacity-40"
                >
                  ‹ Previous
                </button>
                <p aria-live="polite" className="min-w-[64px] text-center text-sm text-white/70">
                  {position}
                </p>
                <button
                  type="button"
                  disabled={index >= items.length - 1}
                  onClick={() => onNavigate(index + 1)}
                  aria-label="Next evidence"
                  className="min-h-[44px] rounded-full px-4 text-sm ring-1 ring-white/25 transition enabled:hover:ring-white/50 disabled:opacity-40"
                >
                  Next ›
                </button>
              </div>
            </div>

            {occurrence ? (
              <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                {/* Image comparison */}
                <div className="min-w-0">
                  <div role="group" aria-label="Choose image to inspect" className="mb-3 flex gap-2 lg:hidden">
                    {(["submitted", "retrieved"] as const).map((tab) => (
                      <button
                        key={tab}
                        type="button"
                        aria-pressed={mobileTab === tab}
                        onClick={() => setMobileTab(tab)}
                        className={cn(
                          "min-h-[44px] flex-1 rounded-full px-4 text-sm capitalize ring-1 transition",
                          mobileTab === tab
                            ? "bg-white text-ink ring-white"
                            : "text-white/70 ring-white/25",
                        )}
                      >
                        {tab} image
                      </button>
                    ))}
                  </div>
                  <div className="grid gap-4 lg:grid-cols-2">
                    <figure className={cn(mobileTab !== "submitted" && "hidden lg:block")}>
                      <figcaption className="mb-2 text-sm font-medium text-white/70">
                        Submitted image
                      </figcaption>
                      {submittedImageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={submittedImageUrl}
                          alt="The image submitted for this investigation"
                          className="max-h-[60vh] w-full rounded-xl object-contain bg-black/40 ring-1 ring-white/15"
                        />
                      ) : (
                        <p className="rounded-xl bg-white/5 p-6 text-sm text-white/55 ring-1 ring-white/10">
                          Submitted image unavailable in this view.
                        </p>
                      )}
                    </figure>
                    <figure className={cn(mobileTab !== "retrieved" && "hidden lg:block")}>
                      <figcaption className="mb-2 text-sm font-medium text-white/70">
                        Retrieved image
                      </figcaption>
                      {retrievedImage && !retrievedImageFailed ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={retrievedImage}
                          alt={`Retrieved image from ${domain ?? "unknown source"}`}
                          onError={() => setFailedImageUrl(retrievedImage)}
                          className="max-h-[60vh] w-full rounded-xl object-contain bg-black/40 ring-1 ring-white/15"
                        />
                      ) : (
                        <p className="rounded-xl bg-white/5 p-6 text-sm text-white/55 ring-1 ring-white/10">
                          Retrieved image unavailable — the source image could not be loaded. It
                          is not replaced with your submitted image.
                        </p>
                      )}
                    </figure>
                  </div>
                </div>

                {/* Source details */}
                <div className="min-w-0">
                  <Dialog.Title className="font-serif text-3xl leading-tight break-words">
                    {title}
                  </Dialog.Title>
                  {domain ? <p className="mt-1 break-all text-sm text-white/60">{domain}</p> : null}
                  <p className="mt-2 break-words text-sm text-white/60">
                    {shownDate
                      ? `Published ${shownDate}${shownPrecision ? ` · ${shownPrecision} precision` : ""} · ${shownDateSource ?? "date source unknown"}`
                      : "Date unknown"}
                  </p>
                  {dateProv?.entityBinding ? (
                    <p className="mt-1 text-xs text-white/55">Date binding: {dateProv.entityBinding}.</p>
                  ) : null}
                  {dateProv && dateProv.rejected.length > 0 ? (
                    <details className="mt-1">
                      <summary className="min-h-[44px] cursor-pointer text-xs text-white/60 underline underline-offset-2">
                        {dateProv.rejected.length} other date{" "}
                        {dateProv.rejected.length === 1 ? "candidate was" : "candidates were"} rejected
                      </summary>
                      <ul className="mt-1 space-y-1 text-xs text-white/55">
                        {dateProv.rejected.map((r, i) => (
                          <li key={i}>
                            {r.value} — {r.reason}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {mediaLabel ? (
                      <Badge tone={mediaLabel.badge === "Visual lead" ? "neutral" : "info"} className="bg-white/10 text-white ring-white/20">
                        {mediaLabel.badge === "Exact match"
                          ? "Exact match · reported by Google Lens"
                          : mediaLabel.badge === "Near match"
                            ? "Near match · locally verified"
                            : "Visual lead · not confirmed"}
                      </Badge>
                    ) : null}
                  </div>

                  {entryNote ? (
                    <p className="mt-3 rounded-lg bg-white/5 px-3 py-2 text-xs leading-relaxed break-words text-white/65 ring-1 ring-white/10">
                      {entryNote}
                    </p>
                  ) : null}
                  {pairId ? (
                    <button
                      type="button"
                      onClick={() => onJumpToId(pairId)}
                      className="mt-2 inline-flex min-h-[44px] items-center gap-1 text-sm font-medium text-white underline underline-offset-2"
                    >
                      View paired divergence occurrence <span aria-hidden="true">→</span>
                    </button>
                  ) : null}

                  <h3 className="mt-5 text-sm font-semibold tracking-wide text-white/50 uppercase">
                    {span ? (occurrence ? (displayAttributionOf(occurrence) ?? span.attribution) : span.attribution) : "Source excerpt"}
                  </h3>
                  {span ? (
                    <figure className="mt-2">
                      <blockquote className="border-l-2 border-white/20 pl-3 text-[15px] leading-relaxed break-words text-white/85">
                        “{span.text}”
                      </blockquote>
                      {showFullText ? (
                        <details className="mt-2 pl-3">
                          <summary className="min-h-[44px] cursor-pointer text-sm text-white/70 underline underline-offset-2">
                            Full retrieved text
                          </summary>
                          <p className="mt-1 text-sm leading-relaxed break-words text-white/70">
                            {fullText}
                          </p>
                        </details>
                      ) : null}
                    </figure>
                  ) : (
                    <p className="mt-2 text-sm text-white/60">No excerpt available</p>
                  )}

                  {identityDetail ? (
                    <p className="mt-3 text-sm text-white/65">
                      Match basis: {identityDetail.methodLabel ?? "not reported"}
                      {identityDetail.supportId ? ` · reference ${identityDetail.supportId}` : ""}.
                    </p>
                  ) : null}

                  {origin ? (
                    <div className="mt-3">
                      <p className="text-sm text-white/65">{shownOrigin}</p>
                      {originSup && originSup.spans.length > 0 ? (
                        <ul className="mt-2 space-y-2">
                          {originSup.spans.map((s, i) => (
                            <li key={i} className="min-w-0 border-l-2 border-white/20 pl-3">
                              <p className="text-sm leading-relaxed break-words text-white/80">“{s.text}”</p>
                              <p className="mt-1 text-xs text-white/50">{s.relation}</p>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {originSup && originSup.reasons.length > 0 ? (
                        <p className="mt-1 text-xs text-white/55">
                          Grouping basis: {originSup.reasons.join("; ")}.
                        </p>
                      ) : null}
                    </div>
                  ) : null}

                  {compared !== null ? (
                    <p className="mt-2 text-xs text-white/55">
                      {compared
                        ? "Selected for the compared run."
                        : "Not selected for the compared run."}
                    </p>
                  ) : null}

                  {claim ? (
                    <p className="mt-3 break-words text-sm text-white/60">
                      Submitted claim: <span className="text-white/85">“{claim}”</span>
                    </p>
                  ) : null}

                  {url ? (
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-5 inline-flex min-h-[44px] items-center gap-2 rounded-full bg-paper px-5 py-2.5 text-sm font-medium text-ink transition hover:bg-white"
                    >
                      Open original source <span aria-hidden="true">↗</span>
                    </a>
                  ) : (
                    <p className="mt-5 text-sm text-white/55">No source link was retrieved for this occurrence.</p>
                  )}

                  <TechnicalDetails
                    occurrence={occurrence}
                    occurrenceKey={occurrenceId(occurrence, `#${index}`)}
                    claimSubmitted={claim !== null}
                    comparisons={
                      result
                        ? comparisonsForOccurrence(result, occurrenceId(occurrence, `#${index}`))
                        : comparisons
                    }
                    claimComparisons={
                      result
                        ? claimComparisonsFor(result, occurrenceId(occurrence, `#${index}`))
                        : []
                    }
                  />
                </div>
              </div>
            ) : (
              <p className="mt-10 text-center text-white/60">No evidence selected.</p>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
