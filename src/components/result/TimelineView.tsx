/**
 * Screen 5 — Evidence timeline (spec sections 3.11–3.13, 4.8).
 *
 * A disciplined occurrence ledger: dated core occurrences on the line, then
 * supporting leads and unknown-date evidence kept visibly separate. Each
 * edge renders its actual comparison relationship — solid only for assessed
 * same/different pairs, dashed with required text for uncertain or
 * unperformed comparisons. The first observed divergence marks its later
 * node and links both endpoints. Unknown dates are never forced onto the
 * line, and an empty core stays honestly empty.
 */
"use client";

import { EvidenceCollection } from "../casebook/EvidenceCollection";
import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useState } from "react";
import {
  occurrenceDate,
  occurrenceDatePrecision,
  occurrenceId,
  occurrenceImage,
  str,
  type JsonRecord,
} from "@/lib/stream/result-view";
import {
  attributableSpan,
  connectorInfo,
  dateSourceLabel,
  dateStatusNote,
  identityBasis,
  isDivergencePoint,
  occurrenceRole,
  reportingOriginLabel,
  type ConnectorInfo,
  type DivergenceEndpoints,
} from "./evidence-display";
import { Badge } from "@/components/ui";
import { cn } from "@/components/cn";

export interface TimelineGroups {
  dated: JsonRecord[];
  unknownDate: JsonRecord[];
  supporting: JsonRecord[];
  contextual: JsonRecord[];
}

export interface DivergenceLink {
  endpoints: DivergenceEndpoints;
  fromTitle: string | null;
  toTitle: string | null;
}

function MatchBadge({ occurrence }: { occurrence: JsonRecord }) {
  const identity = identityBasis(occurrence);
  if (!identity) return null;
  const tone = identity.badge === "Visual lead" ? "neutral" : "link";
  return <Badge tone={tone}>{identity.badge}</Badge>;
}

/**
 * Occurrence-level context classification. In claim mode this is
 * claim-relative (U4: "Differs from claim"), while the edge label describes
 * the adjacent-pair comparison — both facts coexist with explicit scopes.
 */
function ContextBadge({
  occurrence,
  assessed,
  claimMode,
}: {
  occurrence: JsonRecord;
  assessed: boolean;
  claimMode: boolean;
}) {
  if (!assessed) return null;
  const raw = (str(occurrence, "contextLabel") ?? str(occurrence, "context") ?? "").toUpperCase();
  let label: string | null = null;
  if (raw.includes("SAME")) label = claimMode ? "Same as claim" : "Same context";
  else if (raw.includes("DIFFERENT")) label = claimMode ? "Differs from claim" : "Different context";
  else if (raw.includes("HISTORICAL")) label = "Historical reference";
  else if (raw.includes("UNCLEAR") || raw.includes("UNCERTAIN")) label = "Unclear";
  else if (raw.includes("SUBMITTED") || raw.includes("CLAIM")) label = "Submitted claim";
  if (!label) return null;
  const tone =
    label === "Different context" || label === "Differs from claim"
      ? "conflict"
      : label === "Same context" || label === "Same as claim"
        ? "ok"
        : "neutral";
  return <Badge tone={tone}>{label}</Badge>;
}

function ShortExcerpt({ occurrence }: { occurrence: JsonRecord }) {
  const span = attributableSpan(occurrence, 280);
  if (!span) return <p className="mt-2 text-sm text-ink-soft">No excerpt available</p>;
  return (
    <figure className="mt-2">
      <blockquote className="border-l-2 border-ink/15 pl-3 text-sm leading-relaxed text-ink/75">
        “{span.text}”
      </blockquote>
      <figcaption className="mt-1 pl-3 text-xs text-ink-soft">{span.attribution}</figcaption>
    </figure>
  );
}

function OccurrenceCard({
  occurrence,
  index,
  highlight,
  assessed,
  claimMode,
  group,
  groupLabel,
  onInspect,
}: {
  occurrence: JsonRecord;
  index: number;
  highlight: boolean;
  /** True when this edge was actually compared (core dated pairs). */
  assessed: boolean;
  /** Claim-check mode: occurrence context labels are claim-relative. */
  claimMode: boolean;
  group: "dated" | "supporting" | "contextual" | "unknown";
  groupLabel: string | null;
  onInspect: () => void;
}) {
  const date = occurrenceDate(occurrence);
  const precision = occurrenceDatePrecision(occurrence);
  const rawDateKey =
    str(occurrence, "dateSource") ??
    str(occurrence, "publicationDateSource") ??
    str(occurrence, "publishedAtSource");
  const dateSource = dateSourceLabel(rawDateKey);
  const title = str(occurrence, "title");
  const domain = str(occurrence, "domain");
  const image = occurrenceImage(occurrence);
  const identity = identityBasis(occurrence);
  const role = occurrenceRole(occurrence, group);
  const matchBadge = identity?.badge ?? null;
  // Each badge carries distinct meaning (section group vs role vs match
  // basis); never print the same label twice.
  const showRole = role !== null && role !== groupLabel && role !== matchBadge;
  const divergence = isDivergencePoint(occurrence);
  const dateNote = dateStatusNote(occurrence);

  return (
    <div
      className={cn(
        "rounded-xl bg-white/70 p-4 ring-1 transition sm:p-5",
        highlight || divergence ? "ring-2 ring-coral" : "ring-ink/10",
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
          <p className="text-xs font-medium tracking-wide text-ink-soft uppercase">
            {date ?? "Date unknown"}
            {precision && date ? ` · ${precision} precision` : ""}
          </p>
          <h3 className="mt-1 font-medium text-ink">{title ?? "Untitled result"}</h3>
          {domain ? <p className="text-sm text-ink-soft">{domain}</p> : null}
          <div className="mt-2 flex flex-wrap gap-2">
            {groupLabel ? <Badge tone="neutral">{groupLabel}</Badge> : null}
            {showRole && role ? <Badge tone="neutral">{role}</Badge> : null}
            <MatchBadge occurrence={occurrence} />
            <ContextBadge occurrence={occurrence} assessed={assessed} claimMode={claimMode} />
            {divergence ? <Badge tone="conflict">First observed divergence</Badge> : null}
          </div>
          {identity ? (
            <p className="mt-2 text-xs text-ink-soft">Match basis: {identity.basis}.</p>
          ) : (
            <p className="mt-2 text-xs text-ink-soft">Match basis not reported.</p>
          )}
          {date ? (
            <p className="mt-1 text-xs text-ink-soft">
              {dateSource ? `Publication date: ${dateSource}.` : "Date source unknown."}
              {dateNote ? ` ${dateNote}` : ""}
            </p>
          ) : (
            <p className="mt-1 text-xs text-ink-soft">
              No usable date was retrieved for this occurrence.
              {dateNote ? ` ${dateNote}` : ""}
            </p>
          )}
          <p className="mt-1 text-xs text-ink-soft">{reportingOriginLabel(occurrence)}</p>
          <ShortExcerpt occurrence={occurrence} />
          <button
            type="button"
            onClick={onInspect}
            aria-label={`Inspect evidence: ${title ?? `occurrence ${index + 1}`}`}
            className="mt-3 inline-flex min-h-[44px] items-center gap-1 text-sm font-medium text-signal-ink underline underline-offset-2"
          >
            Inspect evidence <span aria-hidden="true">→</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function ConnectorEdge({ info }: { info: ConnectorInfo }) {
  if (info.kind === "start") return null;
  return (
    <p
      className={cn(
        "mb-3 flex items-center gap-2 text-xs",
        info.tone === "conflict" ? "text-coral-ink" : "text-ink-soft",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "inline-block h-0 w-8 border-t-2",
          info.dashed ? "border-dashed border-ink/30" : "border-solid",
          !info.dashed && info.tone === "conflict" ? "border-coral/60" : "",
          !info.dashed && info.tone !== "conflict" ? "border-ink/25" : "",
        )}
      />
      {info.label}
    </p>
  );
}

interface TimelineViewProps {
  groups: TimelineGroups;
  /** Comparison coverage line, e.g. "3 pairs compared across 4 selected". */
  coverageText: string | null;
  divergence: DivergenceLink | null;
  highlightId: string | null;
  /** Claim-check mode: context labels are claim-relative. */
  claimMode: boolean;
  onInspect: (id: string) => void;
}

export default function TimelineView({
  groups,
  coverageText,
  divergence,
  highlightId,
  claimMode,
  onInspect,
}: TimelineViewProps) {
  const reduce = useReducedMotion();
  // Mounted flag (U2): SSR and reduced-motion render the visible final
  // state; hidden initial states apply only after mount with motion allowed.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  const { dated, unknownDate, supporting, contextual } = groups;

  if (dated.length === 0 && unknownDate.length === 0 && supporting.length === 0 && contextual.length === 0) {
    return (
      <p className="rounded-xl bg-white/70 p-8 text-center text-sm text-ink-soft ring-1 ring-ink/10">
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
      <p className="mt-2 max-w-3xl text-sm leading-relaxed text-ink/65">
        {coverageText ? (
          <>Context comparisons: {coverageText}.</>
        ) : (
          <>Comparison coverage was not reported for this investigation.</>
        )}
      </p>

      {divergence ? (
        <div
          role="note"
          aria-label="First observed context divergence"
          className="mt-4 rounded-xl bg-coral/10 px-4 py-3 text-sm ring-1 ring-coral/25"
        >
          <p>
            <strong>First observed context divergence in retrieved evidence.</strong>{" "}
            {divergence.endpoints.earlierUnresolved
              ? "Earlier transitions are unresolved — this is the earliest strongly different compared pair, not the first change on the internet."
              : "The later occurrence below presents the media in a different context than the earlier one, in retrieved evidence."}
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => onInspect(divergence.endpoints.fromId)}
              className="inline-flex min-h-[44px] items-center gap-1 text-sm font-medium text-signal-ink underline underline-offset-2"
            >
              Earlier: {divergence.fromTitle ?? divergence.endpoints.fromId} <span aria-hidden="true">→</span>
            </button>
            <button
              type="button"
              onClick={() => onInspect(divergence.endpoints.toId)}
              className="inline-flex min-h-[44px] items-center gap-1 text-sm font-medium text-signal-ink underline underline-offset-2"
            >
              Later: {divergence.toTitle ?? divergence.endpoints.toId} · first observed divergence{" "}
              <span aria-hidden="true">→</span>
            </button>
          </div>
        </div>
      ) : null}

      {dated.length > 0 ? (
        <div className="mt-8 space-y-0">
          <EvidenceCollection items={dated} label="Dated occurrences">{(occurrence, i) => {
            const id = occurrenceId(occurrence, `dated-${i}`);
            const info = connectorInfo(occurrence);
            const assessed = info.kind === "same" || info.kind === "different";
            return (
              <motion.article
                key={id}
                initial={mounted && !reduce ? { opacity: 0, transform: "translateY(8px)" } : false}
                whileInView={{ opacity: 1, transform: "translateY(0)" }}
                viewport={{ once: true, margin: "-40px" }}
                transition={{ duration: mounted && !reduce ? 0.2 : 0, ease: [0.23, 1, 0.32, 1] }}
                className={cn(
                  "relative grid gap-3 border-l-2 pb-8 pl-6 last:pb-0 sm:grid-cols-[110px_1fr] sm:gap-6 sm:pl-8",
                  info.dashed ? "border-dashed border-ink/30" : "border-solid",
                  !info.dashed && info.tone === "conflict" ? "border-coral/50" : "",
                  !info.dashed && info.tone !== "conflict" ? "border-ink/15" : "",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute top-2 -left-[7px] h-3 w-3 rounded-full ring-4 ring-paper",
                    info.tone === "conflict" ? "bg-coral" : "bg-signal",
                  )}
                />
                <p className="text-sm font-semibold text-ink/70">
                  {occurrenceDate(occurrence) ?? "—"}
                </p>
                <div>
                  <ConnectorEdge info={info} />
                  <OccurrenceCard
                    occurrence={occurrence}
                    index={i}
                    highlight={highlightId === id}
                    assessed={assessed}
                    claimMode={claimMode}
                    group="dated"
                    groupLabel={null}
                    onInspect={() => onInspect(id)}
                  />
                </div>
              </motion.article>
            );
          }}</EvidenceCollection>
        </div>
      ) : (
        <p className="mt-8 rounded-xl bg-white/70 p-5 text-sm leading-relaxed text-ink/65 ring-1 ring-ink/10">
          <strong>No dated core occurrences were found,</strong> so nothing is placed on the
          timeline. Leads below are shown without manufacturing a chronology.
        </p>
      )}

      {supporting.length > 0 ? (
        <section aria-label="Supporting visual leads" className="mt-10">
          <h3 className="text-sm font-semibold tracking-wide text-ink-soft uppercase">
            Supporting visual leads · not part of the core timeline
          </h3>
          <p className="mt-1 text-xs text-ink-soft">
            Visually similar material that was not confirmed as the same image. Dates here do not
            place these leads into the core history.
          </p>
          <div className="mt-3 space-y-4">
            <EvidenceCollection items={supporting} label="Visual leads">{(occurrence, i) => {
              const id = occurrenceId(occurrence, `supporting-${i}`);
              return (
                <article key={id}>
                  <OccurrenceCard
                    occurrence={occurrence}
                    index={i}
                    highlight={highlightId === id}
                    assessed={false}
                    claimMode={claimMode}
                    group="supporting"
                    groupLabel="Supporting lead"
                    onInspect={() => onInspect(id)}
                  />
                </article>
              );
            }}</EvidenceCollection>
          </div>
        </section>
      ) : null}

      {contextual.length > 0 ? (
        <section aria-label="Contextual web results" className="mt-10">
          <h3 className="text-sm font-semibold tracking-wide text-ink-soft uppercase">
            Contextual web results · not same-media evidence
          </h3>
          <p className="mt-1 text-xs text-ink-soft">
            Related pages from web and news search. They were not confirmed to show the submitted
            image and never enter the core timeline.
          </p>
          <div className="mt-3 space-y-4">
            <EvidenceCollection items={contextual} label="Contextual sources">{(occurrence, i) => {
              const id = occurrenceId(occurrence, `contextual-${i}`);
              return (
                <article key={id}>
                  <OccurrenceCard
                    occurrence={occurrence}
                    index={i}
                    highlight={highlightId === id}
                    assessed={false}
                    claimMode={claimMode}
                    group="contextual"
                    groupLabel="Contextual result"
                    onInspect={() => onInspect(id)}
                  />
                </article>
              );
            }}</EvidenceCollection>
          </div>
        </section>
      ) : null}

      {unknownDate.length > 0 ? (
        <section aria-label="Evidence with unknown dates" className="mt-10">
          <h3 className="text-sm font-semibold tracking-wide text-ink-soft uppercase">
            Additional evidence · date unknown
          </h3>
          <p className="mt-1 text-xs text-ink-soft">
            These occurrences could not be placed on the timeline because no usable date was retrieved.
          </p>
          <div className="mt-3 space-y-4">
            <EvidenceCollection items={unknownDate} label="Undated evidence">{(occurrence, i) => {
              const id = occurrenceId(occurrence, `unknown-${i}`);
              return (
                <article key={id}>
                  <OccurrenceCard
                    occurrence={occurrence}
                    index={i}
                    highlight={highlightId === id}
                    assessed={false}
                    claimMode={claimMode}
                    group="unknown"
                    groupLabel="Date unknown"
                    onInspect={() => onInspect(id)}
                  />
                </article>
              );
            }}</EvidenceCollection>
          </div>
        </section>
      ) : null}
    </div>
  );
}
