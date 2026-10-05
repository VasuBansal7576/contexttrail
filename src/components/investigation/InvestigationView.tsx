/**
 * Screen 3 — Investigation (spec sections 3.5, 4.8).
 *
 * Dark immersive layout: stage list left, progressive evidence right. Renders
 * only values actually received in this investigation — real counts, real
 * cards, real failures. No percentage-complete meter, no simulated progress.
 * In DOM and on mobile, the compact current-stage summary comes first, then
 * arriving evidence, then the full stage list.
 */
"use client";

import { CasebookShell } from "../casebook/CasebookShell";
import { EvidenceCollection } from "../casebook/EvidenceCollection";
import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useState, type Ref, type ReactNode } from "react";
import { KNOWN_STAGES, STAGE_LABELS, str, type JsonRecord } from "@/lib/stream/events";
import { progressRelationshipNote } from "@/components/result/evidence-display";
import type { SearchCount, StageState } from "@/lib/stream/useInvestigation";
import { Badge, StatusDot } from "@/components/ui";
import { cn } from "@/components/cn";

function stageTone(status: StageState["status"], stopped = false): "ok" | "active" | "idle" | "bad" | "muted" {
  if (stopped && status === "running") return "bad";
  if (stopped && status === "waiting") return "muted";
  switch (status) {
    case "completed":
      return "ok";
    case "running":
      return "active";
    case "unavailable":
      return "bad";
    case "skipped":
      return "muted";
    default:
      return "idle";
  }
}

function stageStateLabel(status: StageState["status"], stopped = false): string {
  if (stopped && status === "running") return "Interrupted";
  if (stopped && status === "waiting") return "No start recorded";
  switch (status) {
    case "completed":
      return "Completed";
    case "running":
      return "Running";
    case "unavailable":
      return "Unavailable";
    case "skipped":
      return "Skipped";
    default:
      return "Waiting";
  }
}

export function mergeStageList(seen: StageState[]): StageState[] {
  const byName = new Map(seen.map((s) => [s.name, s]));
  return KNOWN_STAGES.filter((name) => name !== "COMPLETE").map((name) =>
    byName.get(name) ?? { name, label: STAGE_LABELS[name], status: "waiting", detail: null },
  );
}

function relationshipNote(evidence: JsonRecord): { label: string; tone: "info" | "neutral" } {
  return progressRelationshipNote(evidence);
}

interface InvestigationViewProps {
  stages: StageState[];
  searchCounts: SearchCount[];
  evidence: JsonRecord[];
  error: { code: string; message: string; partial: boolean } | null;
  onCancel: () => void;
  headingRef?: Ref<HTMLHeadingElement>;
  recoveryActions?: ReactNode;
}

export default function InvestigationView({ stages, searchCounts, evidence, error, onCancel, headingRef, recoveryActions }: InvestigationViewProps) {
  const reduce = useReducedMotion();
  const fullStages = mergeStageList(stages);
  const stopped = error !== null;
  // Mounted flag (U2): SSR and reduced-motion render the visible final
  // state; hidden initial states apply only after mount with motion allowed.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const domains = new Set(evidence.map((e) => str(e, "domain")).filter((d): d is string => d !== null));

  // Compact current-work summary for narrow screens: the running stage, else
  // the most recently completed one, else the next waiting stage.
  const currentStage =
    fullStages.find((s) => s.status === "running") ??
    [...fullStages].reverse().find((s) => s.status === "completed") ??
    fullStages.find((s) => s.status === "waiting") ??
    null;

  return (
    <CasebookShell chapter="image" dark><div className={cn("investigation-progress", stopped && "investigation-stopped")}>
      <div className="casebook-main result-toolbar"><p className="eyebrow">01 / Image investigation</p>
        {!error ? <button
          type="button"
          onClick={onCancel}
          className="paper-button"
        >
          Cancel investigation
        </button> : null}
      </div>

      <main id="main" tabIndex={-1} className="casebook-main">
        <h1 ref={headingRef} tabIndex={-1} className="font-serif text-5xl">{error ? "Investigation interrupted." : "Tracing the web…"}</h1>
        <p className="mt-3 max-w-2xl text-white/65">
          {error ? "The investigation stopped. Review the interruption and any retained evidence below." : "Searching live web evidence to find where this image has appeared and how its context has changed."}
        </p>

        {error ? (
          <div role="alert" className="investigation-failure mt-6 p-5">
            <p className="investigation-failure-title font-semibold">⚠ Investigation interrupted — {error.code}</p>
            <p className="mt-1 text-sm leading-relaxed">{error.message}</p>
            {error.partial ? (
              <p className="mt-2 text-sm">
                Evidence that arrived before the failure is kept visible below.
              </p>
            ) : null}
          </div>
        ) : null}

        {recoveryActions}

        <div className="investigation-work-grid mt-10 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-10 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          {/* Compact current-stage summary first on mobile; full list below evidence. */}
          {!stopped && currentStage ? (
            <p aria-live="polite" className="rounded-xl bg-white/5 px-4 py-3 text-sm text-white/80 ring-1 ring-white/10 lg:hidden">
              <StatusDot kind={stageTone(currentStage.status)} label={`${currentStage.label}: ${stageStateLabel(currentStage.status)}`} />
              {currentStage.detail ? (
                <span className="investigation-detail mt-1 block text-white/55" title={currentStage.detail}>
                  {currentStage.detail}
                </span>
              ) : null}
            </p>
          ) : null}

          {/* Progressive evidence — first in DOM and on mobile, right column on desktop. */}
          <section aria-label={stopped ? "Evidence retained before interruption" : "Evidence arriving live"} aria-live={stopped ? "off" : "polite"} className="min-w-0 lg:order-2">
            {evidence.length === 0 ? (
              <p className="rounded-xl bg-white/5 p-8 text-center text-sm text-white/55 ring-1 ring-white/10">
                {stopped ? "No evidence was received before this investigation stopped." : "Waiting for the first evidence from this investigation…"}
              </p>
            ) : (
              <>
                <p className="text-sm text-white/60">
                  {evidence.length} {evidence.length === 1 ? "candidate" : "candidates"} found ·{" "}
                  {domains.size} {domains.size === 1 ? "source domain" : "source domains"} · {stopped ? "retained before interruption; assessment may be incomplete" : "preliminary, may change after page reading or classification"}
                </p>
                <div className="mt-4 progress-evidence">
                  <EvidenceCollection items={evidence} label="Candidates">{(item, i) => {
                    const note = relationshipNote(item);
                    const title = str(item, "title");
                    const domain = str(item, "domain");
                    const image = str(item, "imageUrl") ?? str(item, "thumbnailUrl");
                    const key = str(item, "id") ?? `evidence-${i}`;
                    return (
                      <motion.article
                        key={key}
                        initial={mounted && !reduce ? { opacity: 0, transform: "translateY(8px)" } : false}
                        animate={{ opacity: 1, transform: "translateY(0)" }}
                        transition={{ duration: mounted && !reduce ? 0.2 : 0, ease: [0.23, 1, 0.32, 1] }}
                        className="min-w-0 rounded-xl bg-white/5 ring-1 ring-white/10"
                      >
                        {image ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={image} alt="" className="aspect-video w-full object-cover" loading="lazy" />
                        ) : null}
                        <div className="p-4">
                          <Badge
                            tone={note.tone}
                            className={
                              note.tone === "neutral"
                                ? "bg-white/10 text-white/85 ring-white/20"
                                : undefined
                            }
                          >
                            {note.label}
                          </Badge>
                          <p className="investigation-candidate-title mt-2 text-sm font-medium">{title ?? "Untitled result"}</p>
                          {domain ? <p className="mt-1 text-xs text-white/55">{domain}</p> : null}
                        </div>
                      </motion.article>
                    );
                  }}</EvidenceCollection>
                </div>
              </>
            )}
          </section>

          {/* Stage list — below evidence in DOM and on mobile, left column on desktop. */}
          <section aria-label="Investigation stages" className="min-w-0 lg:order-1">
            <ol className="space-y-1">
              {fullStages.map((stage) => (
                <li
                  key={stage.name}
                  aria-label={`${stage.label}: ${stageStateLabel(stage.status, stopped)}${stage.detail ? ` — ${stage.detail}` : ""}`}
                  className="flex items-start gap-3 rounded-lg px-2 py-2"
                >
                  <span className={cn("mt-0.5 shrink-0", !stopped && stage.status === "running" && "text-signal")}>
                    <StatusDot kind={stageTone(stage.status, stopped)} label="" />
                  </span>
                  <div className={cn("min-w-0 flex-1", !stopped && stage.status === "waiting" && "opacity-45")}>
                    <p className="text-[15px] font-medium">{stage.label}</p>
                    {stopped ? <p className="text-sm">{stageStateLabel(stage.status, true)}</p> : null}
                    {stage.detail ? (
                      <p className="investigation-detail text-sm text-white/55" title={stage.detail}>
                        {stopped ? `Last reported detail: ${stage.detail}` : stage.detail}
                      </p>
                    ) : null}
                    {!stopped && stage.status === "running" && !stage.detail ? (
                      <p className="text-sm text-white/55">In progress…</p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
            {searchCounts.length > 0 ? (
              <ul aria-label="Retrieval counts from this investigation" className="mt-6 space-y-1 text-sm text-white/70">
                {searchCounts.map((c) => (
                  <li key={c.engine}>
                    ✓ {c.engine} — {c.count} {c.count === 1 ? "result" : "results"}
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="mt-6 text-xs leading-relaxed text-white/60">
              {stopped ? "No further work is scheduled in this investigation. Requests sent before it stopped may have consumed provider credits." : "Canceling stops new work where possible. Requests already sent may still consume provider credits."}
            </p>
          </section>
        </div>
      </main>
    </div></CasebookShell>
  );
}
