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
  dateSourceLabel,
  fullExcerptText,
  identityBasis,
  reportingOriginLabel,
  type AttributableSpan,
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
  /** Element that opened the viewer; focus returns here on close (F14). */
  triggerRef: React.RefObject<HTMLElement | null>;
  /** Why this occurrence was opened (takeaway / divergence entry). */
  entryNote: string | null;
  /** The paired divergence endpoint id, when the open item is half of a pair. */
  pairId: string | null;
  onJumpToId: (id: string) => void;
  onClose: () => void;
  onNavigate: (index: number) => void;
}

function TechDetails({ occurrence }: { occurrence: JsonRecord }) {
  const dateKey =
    str(occurrence, "dateSource") ??
    str(occurrence, "publicationDateSource") ??
    str(occurrence, "publishedAtSource");
  const rows: Array<[string, string | null]> = [
    ["Search engine", str(occurrence, "engine")],
    ["Result position", occurrencePosition(occurrence)],
    ["Lens result type", str(occurrence, "lensResultType") ?? str(occurrence, "resultType")],
    ["Canonical URL", str(occurrence, "canonicalUrl")],
    ["Publication-date source", dateSourceLabel(dateKey)],
    ["Retrieval timestamp", str(occurrence, "retrievedAt") ?? str(occurrence, "retrievalTimestamp")],
    ["Model version", str(occurrence, "jevModel") ?? str(occurrence, "modelVersion")],
  ];
  const visible = rows.filter(([, v]) => v !== null);
  if (visible.length === 0) return null;
  return (
    <details className="mt-4 rounded-lg bg-white/5 px-4 py-3 ring-1 ring-white/10">
      <summary className="min-h-[32px] cursor-pointer text-sm font-medium text-white/80">
        Technical details
      </summary>
      <dl className="mt-2 space-y-1 text-xs text-white/60">
        {visible.map(([label, value]) => (
          <div key={label} className="flex gap-2">
            <dt className="shrink-0 font-medium text-white/45">{label}:</dt>
            <dd className="break-all">{value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

export default function EvidenceViewer({
  open,
  items,
  index,
  submittedImageUrl,
  claim,
  triggerRef,
  entryNote,
  pairId,
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
  const span: AttributableSpan | null = occurrence ? attributableSpan(occurrence, 600) : null;
  const fullText = occurrence ? fullExcerptText(occurrence) : null;
  const showFullText =
    fullText !== null && span !== null && fullText.length > span.text.length + 1;
  const origin = occurrence ? reportingOriginLabel(occurrence) : null;

  const position = items.length > 0 ? `${Math.min(index + 1, items.length)} of ${items.length}` : "0 of 0";

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70" />
        <Dialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(e) => {
            // F14: return focus to the control that opened the viewer.
            const trigger = triggerRef.current;
            if (trigger && document.contains(trigger)) {
              e.preventDefault();
              trigger.focus();
            }
          }}
          className="fixed inset-0 z-50 overflow-y-auto bg-deep text-white"
        >
          <div className="mx-auto max-w-[1280px] px-5 py-5 sm:px-8">
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
              <div className="mt-6 grid gap-8 lg:grid-cols-[2fr_1fr]">
                {/* Image comparison */}
                <div>
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
                <div>
                  <Dialog.Title className="font-serif text-3xl leading-tight">{title}</Dialog.Title>
                  {domain ? <p className="mt-1 text-sm text-white/60">{domain}</p> : null}
                  <p className="mt-2 text-sm text-white/60">
                    {date ? `Published ${date}` : "Date unknown"}
                    {precision && date ? ` · ${precision} precision` : ""}
                    {date ? (dateSource ? ` · ${dateSource}` : " · date source unknown") : ""}
                  </p>
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
                    <p className="mt-3 rounded-lg bg-white/5 px-3 py-2 text-xs leading-relaxed text-white/65 ring-1 ring-white/10">
                      {entryNote}
                    </p>
                  ) : null}
                  {pairId ? (
                    <button
                      type="button"
                      onClick={() => onJumpToId(pairId)}
                      className="mt-2 inline-flex min-h-[36px] items-center gap-1 text-sm font-medium text-white underline underline-offset-2"
                    >
                      View paired divergence occurrence <span aria-hidden="true">→</span>
                    </button>
                  ) : null}

                  <h3 className="mt-5 text-sm font-semibold tracking-wide text-white/50 uppercase">
                    {span ? span.attribution : "Source excerpt"}
                  </h3>
                  {span ? (
                    <figure className="mt-2">
                      <blockquote className="border-l-2 border-white/20 pl-3 text-[15px] leading-relaxed text-white/85">
                        “{span.text}”
                      </blockquote>
                      {showFullText ? (
                        <details className="mt-2 pl-3">
                          <summary className="min-h-[32px] cursor-pointer text-sm text-white/70 underline underline-offset-2">
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

                  {origin ? (
                    <p className="mt-3 text-sm text-white/65">{origin}</p>
                  ) : null}

                  {claim ? (
                    <p className="mt-3 text-sm text-white/60">
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

                  <TechDetails occurrence={occurrence} />
                  <p className="mt-3 text-xs text-white/40">Evidence ID: {occurrenceId(occurrence, `#${index}`)}</p>
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
