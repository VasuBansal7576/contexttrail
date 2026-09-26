/**
 * Screen 4 — Result overview plus Timeline / Sources / Analysis views
 * (spec sections 3.7–3.10, 4.8).
 *
 * One tabbed view over a single in-memory investigation. Every number, date,
 * and excerpt comes from the completed result payload; absent values render
 * as explicit unknowns, never zeros or guesses. Tabs follow the ARIA tab
 * keyboard pattern; on mobile the result headline precedes the submitted
 * material. Sources distinguishes core occurrences, visual leads and
 * contextual results; Analysis shows real coverage, origin checks and the
 * deterministic reasons behind the result.
 */
"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  STATUS_COPY,
  TRACE_HEADLINE,
  TRACE_HEADLINE_WEAK,
  arr,
  getLimitations,
  getMetrics,
  getMode,
  getStatus,
  getTakeaways,
  getTimeline,
  occurrenceDate,
  occurrenceDatePrecision,
  occurrenceId,
  rec,
  str,
  type JsonRecord,
} from "@/lib/stream/result-view";
import {
  comparisonCoverageText,
  dateSourceLabel,
  divergenceEndpoints,
  identityBasis,
  occurrenceRole,
  reportingCounts,
  reportingOriginLabel,
} from "./evidence-display";
import type { SearchCount, StageState } from "@/lib/stream/useInvestigation";
import { Badge } from "@/components/ui";
import { cn } from "@/components/cn";
import TimelineView, { type DivergenceLink, type TimelineGroups } from "./TimelineView";
import EvidenceViewer from "./EvidenceViewer";

type Tab = "overview" | "timeline" | "sources" | "analysis";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "timeline", label: "Timeline" },
  { id: "sources", label: "Sources" },
  { id: "analysis", label: "Analysis" },
];

interface ResultViewProps {
  result: JsonRecord;
  submittedImageUrl: string | null;
  claim: string | null;
  searchCounts: SearchCount[];
  stages: StageState[];
  onNewInvestigation: () => void;
  /** Shown when this result was restored after a refresh (F17). */
  restoredNotice?: string | null;
}

export default function ResultView({
  result,
  submittedImageUrl,
  claim,
  searchCounts,
  stages,
  onNewInvestigation,
  restoredNotice = null,
}: ResultViewProps) {
  const [tab, setTab] = useState<Tab>("overview");
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [viewerNote, setViewerNote] = useState<string | null>(null);
  const [viewerPairId, setViewerPairId] = useState<string | null>(null);
  /** Control that opened the viewer; focus returns here on close. */
  const triggerRef = useRef<HTMLElement | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const mode = getMode(result);
  const status = getStatus(result);
  const copy = status ? STATUS_COPY[status] : null;
  const metrics = getMetrics(result);
  const takeaways = getTakeaways(result);
  const limitations = getLimitations(result);
  const timeline = getTimeline(result);
  const coverageText = comparisonCoverageText(result);
  const endpoints = divergenceEndpoints(result);
  const origins = reportingCounts(result);

  const groups: TimelineGroups = useMemo(() => {
    const supportingRaw =
      arr(result, "supportingEvidence") ?? arr(result, "visualLeads") ?? [];
    const contextualRaw = arr(result, "contextualEvidence") ?? [];
    const clean = (items: unknown[]) =>
      items
        .map((i) => (typeof i === "object" && i !== null && !Array.isArray(i) ? (i as JsonRecord) : null))
        .filter((i): i is JsonRecord => i !== null);
    return {
      dated: timeline.dated,
      unknownDate: timeline.unknownDate,
      supporting: clean(supportingRaw),
      contextual: clean(contextualRaw),
    };
  }, [result, timeline.dated, timeline.unknownDate]);

  /** Flat navigation order for the evidence viewer. */
  const viewerItems = useMemo(
    () => [...groups.dated, ...groups.supporting, ...groups.contextual, ...groups.unknownDate],
    [groups],
  );

  const viewerIdList = useMemo(
    () => viewerItems.map((o, i) => occurrenceId(o, `item-${i}`)),
    [viewerItems],
  );

  const idToTitle = useMemo(() => {
    const map = new Map<string, string>();
    viewerItems.forEach((o, i) => {
      const title = str(o, "title");
      if (title) map.set(viewerIdList[i], title);
    });
    return map;
  }, [viewerItems, viewerIdList]);

  const divergence: DivergenceLink | null = useMemo(() => {
    if (!endpoints) return null;
    return {
      endpoints,
      fromTitle: idToTitle.get(endpoints.fromId) ?? null,
      toTitle: idToTitle.get(endpoints.toId) ?? null,
    };
  }, [endpoints, idToTitle]);

  const pairFor = (id: string): string | null => {
    if (!endpoints) return null;
    if (id === endpoints.fromId) return endpoints.toId;
    if (id === endpoints.toId) return endpoints.fromId;
    return null;
  };

  /** Viewer position → evidence group (matches viewerItems order). */
  const groupOfIndex = (i: number): "dated" | "supporting" | "contextual" | "unknown" => {
    if (i < groups.dated.length) return "dated";
    if (i < groups.dated.length + groups.supporting.length) return "supporting";
    if (i < groups.dated.length + groups.supporting.length + groups.contextual.length) {
      return "contextual";
    }
    return "unknown";
  };

  const openEvidenceById = (id: string, entry?: { kind: "takeaway"; index: number } | { kind: "divergence" }) => {
    triggerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const idx = viewerIdList.indexOf(id);
    if (entry?.kind === "takeaway") {
      setViewerNote(`Opened from key takeaway ${entry.index + 1}.`);
    } else if (entry?.kind === "divergence") {
      setViewerNote(
        id === endpoints?.toId
          ? "Observed divergence pair — later occurrence (first observed divergence)."
          : "Observed divergence pair — earlier occurrence.",
      );
    } else {
      setViewerNote(null);
    }
    setViewerPairId(pairFor(id));
    if (idx >= 0) {
      setViewerIndex(idx);
    } else {
      setHighlightId(id);
      setTab("timeline");
    }
  };

  const jumpToPair = (id: string) => {
    const idx = viewerIdList.indexOf(id);
    if (idx < 0) return;
    setViewerNote(
      id === endpoints?.toId
        ? "Observed divergence pair — later occurrence (first observed divergence)."
        : "Observed divergence pair — earlier occurrence.",
    );
    setViewerPairId(pairFor(id));
    setViewerIndex(idx);
  };

  const closeViewer = () => setViewerIndex(null);

  /** ARIA tab keyboard pattern: arrows move focus and selection. */
  const onTabKeyDown = (e: React.KeyboardEvent, current: number) => {
    let next: number | null = null;
    if (e.key === "ArrowRight") next = (current + 1) % TABS.length;
    else if (e.key === "ArrowLeft") next = (current - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    if (next === null) return;
    e.preventDefault();
    setTab(TABS[next].id);
    tabRefs.current[next]?.focus();
  };

  const backendHeadline = str(result, "headline");
  const headline =
    mode === "trace"
      ? backendHeadline === "LIMITED_MEDIA_HISTORY_FOUND"
        ? TRACE_HEADLINE_WEAK
        : backendHeadline === "MEDIA_HISTORY_RECONSTRUCTED"
          ? TRACE_HEADLINE
          : viewerItems.length > 0
            ? TRACE_HEADLINE
            : TRACE_HEADLINE_WEAK
      : (copy?.headline ?? "Result");

  const panelTone =
    status === "CONTEXT_CONFLICT"
      ? "bg-coral/10 ring-coral/30 text-coral"
      : status === "NO_CONFLICT_FOUND"
        ? "bg-evidence/10 ring-evidence/30 text-evidence"
        : "bg-white/70 ring-ink/10 text-ink";

  return (
    <div className="min-h-screen bg-paper text-ink">
      <header className="mx-auto flex max-w-[1280px] items-center justify-between px-5 py-5 sm:px-8">
        <p className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <span aria-hidden="true" className="inline-block h-4 w-4 rounded-full border-2 border-ink" />
          ContextTrail
        </p>
        <button
          type="button"
          onClick={onNewInvestigation}
          className="min-h-[44px] rounded-full bg-ink px-5 py-2 text-sm font-medium text-white transition hover:bg-black"
        >
          New investigation
        </button>
      </header>

      <nav aria-label="Result views" className="border-b border-ink/10">
        <div className="mx-auto flex max-w-[1280px] gap-1 px-5 sm:px-8" role="tablist" aria-label="Result views">
          {TABS.map((t, i) => (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              id={`ct-tab-${t.id}`}
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={`ct-panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => setTab(t.id)}
              onKeyDown={(e) => onTabKeyDown(e, i)}
              className={cn(
                "min-h-[44px] border-b-2 px-4 text-sm font-medium transition",
                tab === t.id
                  ? "border-ink text-ink"
                  : "border-transparent text-ink/55 hover:text-ink",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </nav>

      <main className="mx-auto max-w-[1280px] px-5 py-10 sm:px-8">
        {restoredNotice ? (
          <p role="note" className="mb-6 rounded-xl bg-ink/5 px-4 py-3 text-sm leading-relaxed text-ink/75 ring-1 ring-ink/10">
            {restoredNotice}
          </p>
        ) : null}

        {tab === "overview" && (
          <div
            role="tabpanel"
            id="ct-panel-overview"
            aria-labelledby="ct-tab-overview"
            className="grid gap-10 lg:grid-cols-[1fr_2fr]"
          >
            {/* Result first in DOM and on mobile; submitted material beside it on desktop. */}
            <section aria-label="Investigation result" className="lg:order-2">
              <div className={cn("rounded-2xl p-6 ring-1 sm:p-8", panelTone)}>
                <h1 className="font-serif text-4xl text-balance sm:text-5xl">{headline}</h1>
                {mode === "claim-check" && copy ? (
                  <>
                    <p className="mt-3 leading-relaxed text-ink/75">{copy.support}</p>
                    {copy.note ? (
                      <p className="mt-2 font-semibold text-ink">⚠ {copy.note}</p>
                    ) : null}
                  </>
                ) : mode === "trace" ? (
                  <p className="mt-3 leading-relaxed text-ink/75">
                    The retrieved appearances of this image are arranged below. No claim was
                    submitted, so no context verdict is shown.
                  </p>
                ) : null}
                {limitations.length > 0 ? (
                  <p className="mt-4 border-t border-ink/10 pt-3 text-sm leading-relaxed text-ink/70">
                    <strong>Evidence limits:</strong> {limitations.join(" ")}
                  </p>
                ) : null}
              </div>

              {/* Metrics: at most three, unknowns explicit. */}
              <dl className="mt-6 grid gap-4 sm:grid-cols-3">
                <div className="rounded-xl bg-white/70 p-5 ring-1 ring-ink/10">
                  <dt className="text-sm text-ink/60">Source domains</dt>
                  <dd className="mt-1 font-serif text-4xl">
                    {metrics.sourceDomains ?? "—"}
                  </dd>
                  {metrics.sourceDomains === null ? (
                    <dd className="text-xs text-ink/55">Not reported</dd>
                  ) : null}
                </div>
                <div className="rounded-xl bg-white/70 p-5 ring-1 ring-ink/10">
                  <dt className="text-sm text-ink/60">Observed contexts</dt>
                  <dd className="mt-1 font-serif text-4xl">
                    {metrics.observedContexts === "unresolved" || metrics.observedContexts === null
                      ? "Unresolved"
                      : metrics.observedContexts}
                  </dd>
                </div>
                <div className="rounded-xl bg-white/70 p-5 ring-1 ring-ink/10">
                  <dt className="text-sm text-ink/60">Earliest observed</dt>
                  <dd className="mt-1 font-serif text-4xl">
                    {metrics.earliest
                      ? (occurrenceDate(metrics.earliest) ?? "Date unknown")
                      : "Date unknown"}
                  </dd>
                  {metrics.earliest && occurrenceDatePrecision(metrics.earliest) ? (
                    <dd className="text-xs text-ink/55">{occurrenceDatePrecision(metrics.earliest)}</dd>
                  ) : null}
                </div>
              </dl>

              {takeaways.length > 0 ? (
                <section aria-label="Key takeaways" className="mt-8">
                  <h2 className="text-sm font-semibold tracking-wide text-ink/60 uppercase">
                    Key takeaways
                  </h2>
                  <ol className="mt-3 space-y-3">
                    {takeaways.map((t, i) => (
                      <li key={i} className="flex items-start justify-between gap-4 rounded-xl bg-white/70 p-4 ring-1 ring-ink/10">
                        <div>
                          <p className="text-[15px] leading-relaxed">
                            <span aria-hidden="true" className="mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-signal-ink text-xs font-bold text-white">
                              {i + 1}
                            </span>
                            {t.text}
                          </p>
                          {t.evidenceIds.length === 0 ? (
                            <p className="mt-1 pl-7 text-xs text-ink/55">
                              No supporting evidence was linked to this takeaway in the result.
                            </p>
                          ) : null}
                        </div>
                        {t.evidenceIds.length > 0 ? (
                          <button
                            type="button"
                            onClick={() => openEvidenceById(t.evidenceIds[0], { kind: "takeaway", index: i })}
                            className="min-h-[36px] shrink-0 text-sm font-medium text-signal-ink underline underline-offset-2"
                          >
                            View evidence →
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                </section>
              ) : null}

              <div className="mt-8 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => setTab("timeline")}
                  className="inline-flex min-h-[48px] items-center gap-2 rounded-full bg-ink px-6 py-3 font-medium text-white transition hover:bg-black"
                >
                  View evidence timeline <span aria-hidden="true">→</span>
                </button>
                <button
                  type="button"
                  onClick={() => setTab("sources")}
                  className="inline-flex min-h-[48px] items-center rounded-full px-6 py-3 font-medium ring-1 ring-ink/20 transition hover:ring-ink/50"
                >
                  View sources
                </button>
              </div>
            </section>

            {/* Submitted material — after the result in DOM/mobile, left column on desktop. */}
            <aside aria-label="Submitted material" className="lg:order-1">
              {submittedImageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={submittedImageUrl}
                  alt="The image submitted for this investigation"
                  className="w-full rounded-xl object-cover ring-1 ring-ink/10"
                />
              ) : restoredNotice ? (
                <p className="rounded-xl bg-ink/5 p-6 text-sm leading-relaxed text-ink/60 ring-1 ring-ink/10">
                  Submitted image unavailable after refresh — uploaded images are never stored.
                </p>
              ) : null}
              <p className="mt-3 text-sm font-medium">Submitted image</p>
              {claim ? (
                <p className="mt-2 border-l-2 border-ink/15 pl-3 text-sm leading-relaxed text-ink/75">
                  “{claim}”
                </p>
              ) : (
                <p className="mt-2 text-sm text-ink/55">No claim submitted — trace mode.</p>
              )}
            </aside>
          </div>
        )}

        {tab === "timeline" && (
          <div role="tabpanel" id="ct-panel-timeline" aria-labelledby="ct-tab-timeline">
            <TimelineView
              groups={groups}
              coverageText={coverageText}
              divergence={divergence}
              highlightId={highlightId}
              onInspect={(id) => openEvidenceById(id, divergence && (id === divergence.endpoints.fromId || id === divergence.endpoints.toId) ? { kind: "divergence" } : undefined)}
            />
          </div>
        )}

        {tab === "sources" && (
          <div role="tabpanel" id="ct-panel-sources" aria-labelledby="ct-tab-sources">
            <section aria-label="Sources">
              <h2 className="font-serif text-4xl">Sources</h2>
              <p className="mt-2 max-w-3xl text-sm text-ink/65">
                Every retrieved occurrence in this investigation. Core occurrences are confirmed
                against the submitted image; visual leads are not, and contextual web results
                never depict it as retrieved media. Labels reflect what the evidence supports,
                not independent verification.
              </p>
              {viewerItems.length === 0 ? (
                <p className="mt-6 rounded-xl bg-white/70 p-8 text-center text-sm text-ink/60 ring-1 ring-ink/10">
                  No sources were retrieved.
                </p>
              ) : (
                <ul className="mt-6 space-y-3">
                  {viewerItems.map((o, i) => {
                    const id = viewerIdList[i];
                    const title = str(o, "title") ?? "Untitled result";
                    const domain = str(o, "domain");
                    const url = str(o, "url") ?? str(o, "sourceUrl");
                    const role = occurrenceRole(o, groupOfIndex(i));
                    const identity = identityBasis(o);
                    const showRole = role !== null && role !== (identity?.badge ?? null);
                    const dateKey =
                      str(o, "dateSource") ??
                      str(o, "publicationDateSource") ??
                      str(o, "publishedAtSource");
                    const dateSrc = dateSourceLabel(dateKey);
                    return (
                      <li key={id} className="rounded-xl bg-white/70 p-4 ring-1 ring-ink/10">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-medium" title={title}>{title}</p>
                            <p className="text-sm text-ink/60">
                              {domain ?? "Unknown domain"}
                              {occurrenceDate(o) ? ` · ${occurrenceDate(o)}` : " · date unknown"}
                              {dateSrc ? ` · ${dateSrc}` : ""}
                            </p>
                            <div className="mt-2 flex flex-wrap gap-2">
                              {showRole && role ? <Badge tone="neutral">{role}</Badge> : null}
                              {identity ? (
                                <Badge tone={identity.badge === "Visual lead" ? "neutral" : "link"}>
                                  {identity.badge}
                                </Badge>
                              ) : null}
                            </div>
                            <p className="mt-2 text-xs text-ink/55">
                              {identity ? `Match basis: ${identity.basis}. ` : "Match basis not reported. "}
                              {reportingOriginLabel(o)}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-3">
                            {url ? (
                              <a
                                href={url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex min-h-[36px] items-center text-sm font-medium text-signal-ink underline underline-offset-2"
                              >
                                Open source ↗
                              </a>
                            ) : null}
                            <button
                              type="button"
                              onClick={() => openEvidenceById(id)}
                              className="inline-flex min-h-[36px] items-center text-sm font-medium text-ink underline underline-offset-2"
                            >
                              Inspect →
                            </button>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>
        )}

        {tab === "analysis" && (
          <div role="tabpanel" id="ct-panel-analysis" aria-labelledby="ct-tab-analysis">
            <section aria-label="Analysis">
              <h2 className="font-serif text-4xl">Analysis</h2>
              <p className="mt-2 max-w-3xl text-sm text-ink/65">
                How this investigation ran — real retrieval stages, retrieved counts, comparison
                coverage, reporting-origin checks, and the deterministic reasons behind the
                result. No accuracy percentages or credibility scores exist in v1.
              </p>

              <h3 className="mt-8 text-sm font-semibold tracking-wide text-ink/60 uppercase">
                Retrieval via SerpApi
              </h3>
              {searchCounts.length === 0 ? (
                <p className="mt-2 text-sm text-ink/60">
                  No retrieval counts were preserved with this result.
                </p>
              ) : (
                <>
                  <ul className="mt-2 space-y-1 text-[15px]">
                    {searchCounts.map((c) => (
                      <li key={c.engine}>
                        <Badge tone="link">{c.engine}</Badge>{" "}
                        <span className="text-ink/75">{c.count} {c.count === 1 ? "result" : "results"} retrieved</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-xs text-ink/55">
                    Counts are retrieved results from this investigation. Per-request attempts and
                    search budgets are not part of the result payload.
                  </p>
                </>
              )}

              <h3 className="mt-8 text-sm font-semibold tracking-wide text-ink/60 uppercase">
                Comparison coverage
              </h3>
              <p className="mt-2 text-[15px] text-ink/75">
                {coverageText
                  ? `Context comparisons: ${coverageText}.`
                  : "Comparison coverage was not reported for this investigation."}
              </p>

              <h3 className="mt-8 text-sm font-semibold tracking-wide text-ink/60 uppercase">
                Reporting origins
              </h3>
              {origins.groups === null && origins.unresolved === null ? (
                <p className="mt-2 text-sm text-ink/60">
                  Reporting-origin detail was not included in this result.
                </p>
              ) : (
                <p className="mt-2 text-[15px] text-ink/75">
                  {origins.groups !== null ? `${origins.groups} resolved reporting ${origins.groups === 1 ? "group" : "groups"}` : "Resolved reporting groups not reported"}
                  {origins.unresolved !== null ? ` · ${origins.unresolved} unresolved ${origins.unresolved === 1 ? "candidate" : "candidates"}` : ""}.
                  Shared-origin copies count as one group; unresolved origins cannot support a
                  stronger corroboration finding.
                </p>
              )}

              <h3 className="mt-8 text-sm font-semibold tracking-wide text-ink/60 uppercase">
                Pipeline stages
              </h3>
              {stages.length === 0 ? (
                <p className="mt-2 text-sm text-ink/60">
                  No stage telemetry was preserved with this result.
                </p>
              ) : (
                <ul className="mt-2 space-y-1 text-[15px]">
                  {stages.map((s) => (
                    <li key={s.name} className="text-ink/75">
                      {s.status === "completed" ? "✓" : s.status === "running" ? "●" : "○"}{" "}
                      {s.label}
                      {s.detail ? <span className="text-ink/55"> — {s.detail}</span> : null}
                    </li>
                  ))}
                </ul>
              )}

              {limitations.length > 0 ? (
                <>
                  <h3 className="mt-8 text-sm font-semibold tracking-wide text-ink/60 uppercase">
                    Evidence limits
                  </h3>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-[15px] text-ink/75">
                    {limitations.map((l, i) => (
                      <li key={i}>{l}</li>
                    ))}
                  </ul>
                </>
              ) : null}
            </section>
          </div>
        )}
      </main>

      <footer className="border-t border-ink/10">
        <p className="mx-auto max-w-[1280px] px-5 py-6 text-xs text-ink/50 sm:px-8">
          Investigation results reflect retrieved web evidence only.{" "}
          <Link href="/" className="underline underline-offset-2">Back to home</Link>
        </p>
      </footer>

      <EvidenceViewer
        open={viewerIndex !== null}
        items={viewerItems}
        index={viewerIndex ?? 0}
        submittedImageUrl={submittedImageUrl}
        claim={claim}
        triggerRef={triggerRef}
        entryNote={viewerNote}
        pairId={viewerPairId}
        onJumpToId={jumpToPair}
        onClose={closeViewer}
        onNavigate={setViewerIndex}
      />
    </div>
  );
}
