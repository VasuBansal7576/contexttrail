/**
 * Client investigation state machine.
 *
 * Owns the `fetch POST /api/investigate` call (multipart: media, claim,
 * timezone, locale — spec section 24), consumes the NDJSON event stream,
 * and reduces events into renderable state.
 *
 * Honesty rules enforced here:
 * - Only values received in stream events are rendered downstream.
 * - A missing API route, HTTP error, or network failure surfaces as a real
 *   failure state. The client never falls back to fixtures or simulation.
 * - Image and claim stay in browser memory for the active flow; only the
 *   completed result JSON (never image bytes) is cached to sessionStorage.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  KNOWN_STAGES,
  STAGE_LABELS,
  arr,
  asRecord,
  num,
  rec,
  str,
  type InvestigationEvent,
  type JsonRecord,
  type Stage,
} from "./events";
import { readNdjsonStream } from "./ndjson";

export type Phase =
  | "upload"
  | "preparing"
  | "streaming"
  | "completed"
  | "failed"
  | "cancelled";

export type StageStatus =
  | "waiting"
  | "running"
  | "completed"
  | "unavailable"
  | "skipped";

export interface StageState {
  name: string;
  label: string;
  status: StageStatus;
  detail: string | null;
}

export interface SearchCount {
  engine: string;
  count: number;
}

export interface InvestigationFailure {
  code: string;
  message: string;
  /** True when some evidence arrived before the failure. */
  partial: boolean;
}

export interface InvestigationSnapshot {
  phase: Phase;
  investigationId: string | null;
  stages: StageState[];
  searchCounts: SearchCount[];
  evidence: JsonRecord[];
  classifications: Record<string, JsonRecord>;
  partialTimeline: JsonRecord[] | null;
  preliminaryVerdict: string | null;
  divergence: JsonRecord | null;
  result: JsonRecord | null;
  error: InvestigationFailure | null;
}

const INITIAL_SNAPSHOT: InvestigationSnapshot = {
  phase: "upload",
  investigationId: null,
  stages: [],
  searchCounts: [],
  evidence: [],
  classifications: {},
  partialTimeline: null,
  preliminaryVerdict: null,
  divergence: null,
  result: null,
  error: null,
};

const RESULT_CACHE_KEY = "contexttrail.latest-result";

/** Sentinel abort reason distinguishing the client watchdog from an
 *  explicit user cancellation — the caught stream error does not reliably
 *  preserve it (native body cancellation surfaces a bare AbortError). */
const WATCHDOG_REASON = "watchdog";

/**
 * Reduce an aborted/failed stream read to the honest failure state
 * (spec §4.8, §29). Classification reads the owned controller's abort
 * *reason*, never the thrown error's message: watchdog → timed_out
 * (failed, partial evidence preserved); user abort → cancelled; a
 * non-aborted transport failure → failed, with copy that distinguishes
 * interruption after evidence from failure before any arrived.
 */
export function classifyStreamFailure(
  snapshot: InvestigationSnapshot,
  signal: AbortSignal,
): InvestigationSnapshot {
  if (snapshot.phase !== "streaming" && snapshot.phase !== "preparing") {
    return snapshot;
  }
  const partial = snapshot.evidence.length > 0;
  if (signal.aborted) {
    const timedOut =
      signal.reason instanceof Error && signal.reason.message === WATCHDOG_REASON;
    return {
      ...snapshot,
      phase: timedOut ? "failed" : "cancelled",
      error: timedOut
        ? {
            code: "timed_out",
            message:
              "The investigation timed out waiting for the service. Partial evidence, if any, is shown below.",
            partial,
          }
        : snapshot.error,
    };
  }
  return {
    ...snapshot,
    phase: "failed",
    error: {
      code: "network_error",
      message: partial
        ? "The connection to the investigation service was interrupted. The evidence retrieved so far is shown below."
        : "Could not reach the investigation service. Check your connection and try again — no evidence was retrieved.",
      partial,
    },
  };
}

function stageLabel(name: string): string {
  return STAGE_LABELS[name] ?? name;
}

function orderStages(stages: StageState[]): StageState[] {
  const rank = (name: string) => {
    const i = KNOWN_STAGES.indexOf(name as (typeof KNOWN_STAGES)[number]);
    return i === -1 ? KNOWN_STAGES.length : i;
  };
  return [...stages].sort((a, b) => rank(a.name) - rank(b.name));
}

/** Exported for focused reducer tests. */
export function applyEvent(snapshot: InvestigationSnapshot, event: InvestigationEvent): InvestigationSnapshot {
  switch (event.type) {
    case "investigation.started": {
      const id = typeof event.investigationId === "string" ? event.investigationId : null;
      return { ...snapshot, investigationId: id };
    }
    case "stage.started": {
      const name = String(event.stage);
      const stages = snapshot.stages.some((s) => s.name === name)
        ? snapshot.stages.map((s) => (s.name === name ? { ...s, status: "running" as StageStatus } : s))
        : [...snapshot.stages, { name, label: stageLabel(name), status: "running" as StageStatus, detail: null }];
      return { ...snapshot, stages: orderStages(stages) };
    }
    case "stage.completed": {
      const name = String(event.stage);
      const detail = typeof event.detail === "string" ? event.detail : null;
      const stages = snapshot.stages.some((s) => s.name === name)
        ? snapshot.stages.map((s) =>
            s.name === name ? { ...s, status: "completed" as StageStatus, detail } : s,
          )
        : [...snapshot.stages, { name, label: stageLabel(name), status: "completed" as StageStatus, detail }];
      return { ...snapshot, stages: orderStages(stages) };
    }
    case "search.batch": {
      if (typeof event.engine !== "string" || typeof event.count !== "number") return snapshot;
      const engine = event.engine;
      const existing = snapshot.searchCounts.find((c) => c.engine === engine);
      const searchCounts = existing
        ? snapshot.searchCounts.map((c) => (c.engine === engine ? { ...c, count: event.count as number } : c))
        : [...snapshot.searchCounts, { engine, count: event.count as number }];
      return { ...snapshot, searchCounts };
    }
    case "evidence.discovered": {
      const evidence = asRecord(event.evidence);
      if (!evidence) return snapshot;
      // One entry per evidence id — a repeated discovery enriches the
      // existing row rather than duplicating it (unique React keys).
      const id = str(evidence, "id");
      if (id !== null && snapshot.evidence.some((e) => str(e, "id") === id)) {
        return {
          ...snapshot,
          evidence: snapshot.evidence.map((e) => (str(e, "id") === id ? { ...e, ...evidence } : e)),
        };
      }
      return { ...snapshot, evidence: [...snapshot.evidence, evidence] };
    }
    case "evidence.classified": {
      const judgment = asRecord(event.publicJudgment);
      if (typeof event.id !== "string" || !judgment) return snapshot;
      return {
        ...snapshot,
        classifications: { ...snapshot.classifications, [event.id]: judgment },
      };
    }
    case "provenance.partial": {
      if (!Array.isArray(event.timeline)) return snapshot;
      const items = event.timeline
        .map((item) => (typeof item === "object" && item !== null && !Array.isArray(item) ? (item as JsonRecord) : null))
        .filter((item): item is JsonRecord => item !== null);
      return { ...snapshot, partialTimeline: items };
    }
    case "verdict.preliminary": {
      if (typeof event.verdict !== "string") return snapshot;
      return { ...snapshot, preliminaryVerdict: event.verdict };
    }
    case "divergence.detected": {
      const divergence = asRecord(event.divergence);
      if (!divergence) return snapshot;
      return { ...snapshot, divergence };
    }
    case "investigation.completed": {
      const result = asRecord(event.result);
      if (!result) return snapshot;
      try {
        sessionStorage.setItem(RESULT_CACHE_KEY, JSON.stringify(result));
      } catch {
        // Cache is best-effort; an active investigation never depends on it.
      }
      return { ...snapshot, phase: "completed", result };
    }
    case "investigation.error": {
      const code = typeof event.code === "string" ? event.code : "investigation_failed";
      const message =
        typeof event.message === "string" && event.message.length > 0
          ? event.message
          : "The investigation could not be completed.";
      return {
        ...snapshot,
        phase: "failed",
        error: { code, message, partial: snapshot.evidence.length > 0 },
      };
    }
    default:
      // Unknown future event types are tolerated and ignored.
      return snapshot;
  }
}

function httpErrorMessage(status: number): { code: string; message: string } {
  if (status === 404) {
    return {
      code: "service_unavailable",
      message:
        "The investigation service is not available (POST /api/investigate returned 404). No investigation was run and no evidence was retrieved.",
    };
  }
  if (status === 413) {
    return {
      code: "payload_too_large",
      message: "The processed image was rejected as too large. Try a smaller image.",
    };
  }
  if (status >= 500) {
    return {
      code: "server_error",
      message: `The investigation service failed (HTTP ${status}). No fabricated evidence is shown; try again.`,
    };
  }
  return {
    code: "request_failed",
    message: `The investigation request failed (HTTP ${status}). No investigation was run.`,
  };
}

/** Watchdog: treat a hung connection as a real failure, not a silent stall. */
const STREAM_WATCHDOG_MS = 90_000;

export interface StartInvestigationInput {
  media: Blob;
  claim: string | null;
}

export function useInvestigation() {
  const [snapshot, setSnapshot] = useState<InvestigationSnapshot>(INITIAL_SNAPSHOT);
  const abortRef = useRef<AbortController | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);

  useEffect(() => () => {
    abortRef.current?.abort();
    if (watchdogRef.current) clearTimeout(watchdogRef.current);
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    clearWatchdog();
    setSnapshot((prev) =>
      prev.phase === "streaming" || prev.phase === "preparing"
        ? { ...prev, phase: "cancelled" }
        : prev,
    );
  }, [clearWatchdog]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    clearWatchdog();
    abortRef.current = null;
    setSnapshot(INITIAL_SNAPSHOT);
  }, [clearWatchdog]);

  const start = useCallback(
    async (input: StartInvestigationInput) => {
      abortRef.current?.abort();
      clearWatchdog();
      const controller = new AbortController();
      abortRef.current = controller;

      setSnapshot({ ...INITIAL_SNAPSHOT, phase: "preparing" });
      watchdogRef.current = setTimeout(() => controller.abort(new Error(WATCHDOG_REASON)), STREAM_WATCHDOG_MS);

      const fail = (code: string, message: string, partial = false) => {
        clearWatchdog();
        setSnapshot((prev) => ({
          ...prev,
          phase: prev.phase === "cancelled" ? prev.phase : "failed",
          error: { code, message, partial: partial || prev.evidence.length > 0 },
        }));
      };

      try {
        const form = new FormData();
        form.set("media", input.media, "investigation-image");
        if (input.claim && input.claim.trim().length > 0) {
          form.set("claim", input.claim.trim());
        }
        try {
          form.set("timezone", Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC");
        } catch {
          form.set("timezone", "UTC");
        }
        form.set("locale", typeof navigator !== "undefined" ? navigator.language : "en");

        setSnapshot((prev) => ({ ...prev, phase: "streaming" }));

        const response = await fetch("/api/investigate", {
          method: "POST",
          body: form,
          signal: controller.signal,
        });

        if (!response.ok) {
          const { code, message } = httpErrorMessage(response.status);
          fail(code, message);
          return;
        }
        if (!response.body) {
          fail("empty_response", "The investigation service returned an empty response. No evidence was retrieved.");
          return;
        }

        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("ndjson") && !contentType.includes("json") && !contentType.includes("octet-stream")) {
          // Tolerate missing content-type from dev servers, but a plain HTML
          // error page (e.g. framework 404 page) must not be parsed as events.
          if (contentType.includes("html")) {
            fail(
              "service_unavailable",
              "The investigation service did not return an event stream. No investigation was run.",
            );
            return;
          }
        }

        for await (const event of readNdjsonStream(response.body, controller.signal)) {
          setSnapshot((prev) => {
            if (prev.phase !== "streaming") return prev;
            return applyEvent(prev, event);
          });
        }

        clearWatchdog();
        setSnapshot((prev) => {
          if (prev.phase !== "streaming") return prev;
          // Stream ended without a terminal event: honest failure, keep evidence.
          if (prev.error) return { ...prev, phase: "failed" };
          if (!prev.result) {
            return {
              ...prev,
              phase: "failed",
              error: {
                code: "stream_terminated",
                message:
                  "The investigation stream ended before a result arrived. Whatever evidence arrived is shown below; nothing was fabricated to fill the gap.",
                partial: prev.evidence.length > 0,
              },
            };
          }
          return prev;
        });
      } catch {
        clearWatchdog();
        setSnapshot((prev) => classifyStreamFailure(prev, controller.signal));
        return;
      }
    },
    [clearWatchdog],
  );

  return useMemo(
    () => ({ ...snapshot, start, cancel, reset }),
    [snapshot, start, cancel, reset],
  );
}

/** Read the cached completed result (spec 5.4: latest JSON only, never images). */
export function readCachedResult(): JsonRecord | null {
  try {
    const raw = sessionStorage.getItem(RESULT_CACHE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return asRecord(parsed as JsonRecord) ?? (parsed as JsonRecord);
  } catch {
    return null;
  }
}

/* Re-export defensive accessors used by result views. */
export { arr, rec, str, num, asRecord };
export type { JsonRecord, Stage };
