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

import { motion, useReducedMotion } from "framer-motion";
import { KNOWN_STAGES, STAGE_LABELS, str, type JsonRecord } from "@/lib/stream/events";
import type { SearchCount, StageState } from "@/lib/stream/useInvestigation";
import { Badge, StatusDot } from "@/components/ui";
import { cn } from "@/components/cn";

function stageTone(status: StageState["status"]): "ok" | "active" | "idle" | "bad" | "muted" {
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

function stageStateLabel(status: StageState["status"]): string {
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
  const rel = (str(evidence, "mediaRelationship") ?? str(evidence, "relationship") ?? "").toUpperCase();
  if (rel.includes("EXACT")) return { label: "Exact match · reported by Google Lens", tone: "info" };
  if (rel.includes("NEAR")) return { label: "Near match · locally verified", tone: "info" };
  return { label: "Visual lead · not verified", tone: "neutral" };
}

interface InvestigationViewProps {
  stages: StageState[];
  searchCounts: SearchCount[];
  evidence: JsonRecord[];
  error: { code: string; message: string; partial: boolean } | null;
  onCancel: () => void;
}

export default function InvestigationView({ stages, searchCounts, evidence, error, onCancel }: InvestigationViewProps) {
  const reduce = useReducedMotion();
  const fullStages = mergeStageList(stages);

  const domains = new Set(evidence.map((e) => str(e, "domain")).filter((d): d is string => d !== null));

  // Compact current-work summary for narrow screens: the running stage, else
  // the most recently completed one, else the next waiting stage.
  const currentStage =
    fullStages.find((s) => s.status === "running") ??
    [...fullStages].reverse().find((s) => s.status === "completed") ??
    fullStages.find((s) => s.status === "waiting") ??
    null;

  return (
    <div className="min-h-screen bg-deep text-white">
      <header className="mx-auto flex max-w-[1280px] items-center justify-between px-5 py-5 sm:px-8">
        <p className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <span aria-hidden="true" className="inline-block h-4 w-4 rounded-full border-2 border-white" />
          ContextTrail
        </p>
        <button
          type="button"
          onClick={onCancel}
          className="min-h-[44px] rounded-full px-4 py-2 text-sm text-white/70 ring-1 ring-white/25 transition hover:text-white hover:ring-white/50"
        >
          Cancel investigation
        </button>
      </header>

      <main className="mx-auto max-w-[1280px] px-5 pb-20 sm:px-8">
        <h1 className="font-serif text-5xl">Tracing the web…</h1>
        <p className="mt-3 max-w-2xl text-white/65">
          Searching live web evidence to find where this image has appeared and how its context has changed.
        </p>

        {error ? (
          <div role="alert" className="mt-6 rounded-xl bg-coral/10 p-5 ring-1 ring-coral/30">
            <p className="font-semibold text-coral">⚠ Investigation interrupted — {error.code}</p>
            <p className="mt-1 text-sm leading-relaxed text-white/75">{error.message}</p>
            {error.partial ? (
              <p className="mt-2 text-sm text-white/60">
                Evidence that arrived before the failure is kept visible below.
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="mt-10 grid gap-10 lg:grid-cols-[40%_60%]">
          {/* Compact current-stage summary first on mobile; full list below evidence. */}
          {currentStage ? (
            <p aria-live="polite" className="rounded-xl bg-white/5 px-4 py-3 text-sm text-white/80 ring-1 ring-white/10 lg:hidden">
              <StatusDot kind={stageTone(currentStage.status)} label={`${currentStage.label}: ${stageStateLabel(currentStage.status)}`} />
              {currentStage.detail ? (
                <span className="mt-1 block truncate text-white/55" title={currentStage.detail}>
                  {currentStage.detail}
                </span>
              ) : null}
            </p>
          ) : null}

          {/* Progressive evidence — first in DOM and on mobile, right column on desktop. */}
          <section aria-label="Evidence arriving live" aria-live="polite" className="lg:order-2">
            {evidence.length === 0 ? (
              <p className="rounded-xl bg-white/5 p-8 text-center text-sm text-white/55 ring-1 ring-white/10">
                Waiting for the first evidence from this investigation…
              </p>
            ) : (
              <>
                <p className="text-sm text-white/60">
                  {evidence.length} {evidence.length === 1 ? "candidate" : "candidates"} found ·{" "}
                  {domains.size} {domains.size === 1 ? "source domain" : "source domains"} · preliminary, may
                  change after page reading or classification
                </p>
                <ul className="mt-4 grid gap-4 sm:grid-cols-2">
                  {evidence.map((item, i) => {
                    const note = relationshipNote(item);
                    const title = str(item, "title");
                    const domain = str(item, "domain");
                    const image = str(item, "imageUrl") ?? str(item, "thumbnailUrl");
                    const key = str(item, "id") ?? `evidence-${i}`;
                    return (
                      <motion.li
                        key={key}
                        initial={reduce ? false : { opacity: 0, y: 16 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.35 }}
                        className="overflow-hidden rounded-xl bg-white/5 ring-1 ring-white/10"
                      >
                        {image ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={image} alt="" className="aspect-video w-full object-cover" loading="lazy" />
                        ) : null}
                        <div className="p-4">
                          <Badge tone={note.tone}>{note.label}</Badge>
                          <p className="mt-2 line-clamp-2 text-sm font-medium">{title ?? "Untitled result"}</p>
                          {domain ? <p className="mt-1 text-xs text-white/55">{domain}</p> : null}
                        </div>
                      </motion.li>
                    );
                  })}
                </ul>
              </>
            )}
          </section>

          {/* Stage list — below evidence in DOM and on mobile, left column on desktop. */}
          <section aria-label="Investigation stages" className="lg:order-1">
            <ol className="space-y-1">
              {fullStages.map((stage) => (
                <li
                  key={stage.name}
                  aria-label={`${stage.label}: ${stageStateLabel(stage.status)}${stage.detail ? ` — ${stage.detail}` : ""}`}
                  className="flex items-start gap-3 rounded-lg px-2 py-2"
                >
                  <span className={cn("mt-0.5", stage.status === "running" && "text-signal")}>
                    <StatusDot kind={stageTone(stage.status)} label="" />
                  </span>
                  <div className={cn("min-w-0", stage.status === "waiting" && "opacity-45")}>
                    <p className="text-[15px] font-medium">{stage.label}</p>
                    {stage.detail ? (
                      <p className="truncate text-sm text-white/55" title={stage.detail}>
                        {stage.detail}
                      </p>
                    ) : null}
                    {stage.status === "running" && !stage.detail ? (
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
            <p className="mt-6 text-xs leading-relaxed text-white/40">
              Canceling stops new work where possible. Requests already sent may still consume provider credits.
            </p>
          </section>
        </div>
      </main>
    </div>
  );
}
