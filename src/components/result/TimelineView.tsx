/**
 * Screen 5 — Evidence timeline (spec sections 3.11–3.13, 4.8).
 *
 * Single vertical timeline of dated core occurrences, then a separate
 * "Additional evidence · date unknown" section. Unknown dates are never
 * forced onto the line. Connectors are solid only for assessed
 * relationships; uncertain/uncompared edges are dashed and labeled.
 */
"use client";

import { motion, useReducedMotion } from "framer-motion";
import {
  contextLabel,
  mediaRelationshipLabel,
  occurrenceDate,
  occurrenceDatePrecision,
  occurrenceDateSource,
  occurrenceExcerpt,
  occurrenceId,
  occurrenceImage,
  str,
  type JsonRecord,
} from "@/lib/stream/result-view";
import { Badge } from "@/components/ui";
import { cn } from "@/components/cn";

export interface TimelineGroups {
  dated: JsonRecord[];
  unknownDate: JsonRecord[];
  supporting: JsonRecord[];
}

function MatchBadge({ occurrence }: { occurrence: JsonRecord }) {
  const label = mediaRelationshipLabel(occurrence);
  if (!label) return null;
  const tone = label === "Visual lead" ? "neutral" : "info";
  return <Badge tone={tone}>{label}</Badge>;
}

function ContextBadge({ occurrence }: { occurrence: JsonRecord }) {
  const label = contextLabel(occurrence);
  if (!label) return null;
  const tone = label === "Different context" ? "conflict" : label === "Same context" ? "ok" : "neutral";
  return <Badge tone={tone}>{label}</Badge>;
}

function Excerpt({ occurrence }: { occurrence: JsonRecord }) {
  const { text, source } = occurrenceExcerpt(occurrence);
  if (!text) return <p className="mt-2 text-sm text-ink/55">No excerpt available</p>;
  const attribution =
    source ?? (str(occurrence, "excerptType")?.toLowerCase().includes("page") ? "Extracted page excerpt" : "Search snippet");
  return (
    <figure className="mt-2">
      <blockquote className="border-l-2 border-ink/15 pl-3 text-sm leading-relaxed text-ink/75">
        “{text}”
      </blockquote>
      {attribution ? <figcaption className="mt-1 pl-3 text-xs text-ink/50">{attribution}</figcaption> : null}
    </figure>
  );
}

function OccurrenceCard({
  occurrence,
  index,
  highlight,
  onInspect,
}: {
  occurrence: JsonRecord;
  index: number;
  highlight: boolean;
  onInspect: () => void;
}) {
  const date = occurrenceDate(occurrence);
  const precision = occurrenceDatePrecision(occurrence);
  const dateSource = occurrenceDateSource(occurrence);
  const title = str(occurrence, "title");
  const domain = str(occurrence, "domain");
  const image = occurrenceImage(occurrence);
  const reportingOrigin =
    str(occurrence, "reportingOrigin") ?? str(occurrence, "reportingOriginStatus");

  return (
    <div
      className={cn(
        "rounded-xl bg-white/70 p-4 ring-1 transition sm:p-5",
        highlight ? "ring-2 ring-signal" : "ring-ink/10",
      )}
    >
      <div className="flex flex-col gap-4 sm:flex-row">
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image}
            alt=""
            loading="lazy"
            className="h-28 w-full shrink-0 rounded-lg object-cover ring-1 ring-ink/10 sm:w-40"
          />
        ) : null}
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium tracking-wide text-ink/55 uppercase">
            {date ?? "Date unknown"}
            {precision && date ? ` · ${precision}` : ""}
          </p>
          <h3 className="mt-1 font-medium text-ink">{title ?? "Untitled result"}</h3>
          {domain ? <p className="text-sm text-ink/60">{domain}</p> : null}
          <div className="mt-2 flex flex-wrap gap-2">
            <MatchBadge occurrence={occurrence} />
            <ContextBadge occurrence={occurrence} />
          </div>
          {dateSource ? (
            <p className="mt-2 text-xs text-ink/50">Date source: {dateSource}</p>
          ) : date ? (
            <p className="mt-2 text-xs text-ink/50">Date source unknown</p>
          ) : null}
          {reportingOrigin ? (
            <p className="mt-1 text-xs text-ink/50">Reporting origin: {reportingOrigin}</p>
          ) : null}
          <Excerpt occurrence={occurrence} />
          <button
            type="button"
            onClick={onInspect}
            aria-label={`Inspect evidence: ${title ?? `occurrence ${index + 1}`}`}
            className="mt-3 inline-flex min-h-[36px] items-center gap-1 text-sm font-medium text-signal underline underline-offset-2"
          >
            Inspect evidence <span aria-hidden="true">→</span>
          </button>
        </div>
      </div>
    </div>
  );
}

interface TimelineViewProps {
  groups: TimelineGroups;
  divergenceNote: string | null;
  highlightId: string | null;
  onInspect: (id: string) => void;
}

export default function TimelineView({ groups, divergenceNote, highlightId, onInspect }: TimelineViewProps) {
  const reduce = useReducedMotion();
  const { dated, unknownDate, supporting } = groups;

  if (dated.length === 0 && unknownDate.length === 0 && supporting.length === 0) {
    return (
      <p className="rounded-xl bg-white/70 p-8 text-center text-sm text-ink/60 ring-1 ring-ink/10">
        No occurrences were returned in this investigation.
      </p>
    );
  }

  return (
    <div>
      <h2 className="font-serif text-4xl">The media&apos;s journey</h2>
      <p className="mt-2 max-w-3xl text-sm leading-relaxed text-ink/65">
        This timeline shows appearances found in this investigation. Gaps do not mean the image was
        absent from the web.
      </p>

      {divergenceNote ? (
        <p role="note" className="mt-4 rounded-xl bg-coral/10 px-4 py-3 text-sm ring-1 ring-coral/25">
          <strong>First observed context divergence in retrieved evidence.</strong> {divergenceNote}
        </p>
      ) : null}

      {dated.length > 0 ? (
        <ol className="mt-8 space-y-0">
          {dated.map((occurrence, i) => (
            <motion.li
              key={occurrenceId(occurrence, `dated-${i}`)}
              initial={reduce ? false : { opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-40px" }}
              transition={{ duration: 0.4 }}
              className="relative grid gap-3 border-l-2 border-ink/15 pb-8 pl-6 last:pb-0 sm:grid-cols-[110px_1fr] sm:gap-6 sm:pl-8"
            >
              <span aria-hidden="true" className="absolute top-2 -left-[7px] h-3 w-3 rounded-full bg-signal ring-4 ring-paper" />
              <p className="text-sm font-semibold text-ink/70">
                {occurrenceDate(occurrence) ?? "—"}
              </p>
              <OccurrenceCard
                occurrence={occurrence}
                index={i}
                highlight={highlightId === occurrenceId(occurrence, `dated-${i}`)}
                onInspect={() => onInspect(occurrenceId(occurrence, `dated-${i}`))}
              />
            </motion.li>
          ))}
        </ol>
      ) : null}

      {supporting.length > 0 ? (
        <section aria-label="Supporting visual leads" className="mt-10">
          <h3 className="text-sm font-semibold tracking-wide text-ink/60 uppercase">
            Supporting visual leads · not part of the core timeline
          </h3>
          <ul className="mt-3 space-y-4">
            {supporting.map((occurrence, i) => (
              <li key={occurrenceId(occurrence, `supporting-${i}`)}>
                <OccurrenceCard
                  occurrence={occurrence}
                  index={i}
                  highlight={highlightId === occurrenceId(occurrence, `supporting-${i}`)}
                  onInspect={() => onInspect(occurrenceId(occurrence, `supporting-${i}`))}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {unknownDate.length > 0 ? (
        <section aria-label="Evidence with unknown dates" className="mt-10">
          <h3 className="text-sm font-semibold tracking-wide text-ink/60 uppercase">
            Additional evidence · date unknown
          </h3>
          <p className="mt-1 text-xs text-ink/55">
            These occurrences could not be placed on the timeline because no usable date was retrieved.
          </p>
          <ul className="mt-3 space-y-4">
            {unknownDate.map((occurrence, i) => (
              <li key={occurrenceId(occurrence, `unknown-${i}`)}>
                <OccurrenceCard
                  occurrence={occurrence}
                  index={i}
                  highlight={highlightId === occurrenceId(occurrence, `unknown-${i}`)}
                  onInspect={() => onInspect(occurrenceId(occurrence, `unknown-${i}`))}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
