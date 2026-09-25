/**
 * Streaming API contract (spec §24) and stage vocabulary (§9.2).
 *
 * POST /api/investigate -> application/x-ndjson. No WebSockets, no
 * EventSource. encodeEvent/decodeEventLine are the single encoder/decoder for
 * both the server writer and the client reader so the wire shape cannot drift.
 */

import type {
  ClaimStatus,
  Divergence,
  InvestigationResult,
  PublicEvidenceCandidate,
  PublicJudgment,
  TimelineItem,
} from "./investigation";

/** §9.2 — ordered stage boundaries of the investigation DAG. */
export type Stage =
  | "CLIENT_PREPROCESS"
  | "INITIAL_RETRIEVAL"
  | "NORMALIZE"
  | "VERIFY_MEDIA"
  | "SCREEN_REPORTING_ORIGINS"
  | "FAST_CLASSIFY"
  | "PRELIMINARY"
  | "EXPAND_IF_NEEDED"
  | "DEEP_READ"
  | "REFINED_CLASSIFY"
  | "REFINE_REPORTING_ORIGINS"
  | "CHRONOLOGY"
  | "DIVERGENCE"
  | "FINAL_POLICY"
  | "COMPLETE";

export const STAGES: readonly Stage[] = [
  "CLIENT_PREPROCESS",
  "INITIAL_RETRIEVAL",
  "NORMALIZE",
  "VERIFY_MEDIA",
  "SCREEN_REPORTING_ORIGINS",
  "FAST_CLASSIFY",
  "PRELIMINARY",
  "EXPAND_IF_NEEDED",
  "DEEP_READ",
  "REFINED_CLASSIFY",
  "REFINE_REPORTING_ORIGINS",
  "CHRONOLOGY",
  "DIVERGENCE",
  "FINAL_POLICY",
  "COMPLETE",
];

/** §29 — bounded error codes for `investigation.error`. */
export type InvestigationErrorCode =
  /** Both visual-discovery and exact-match requests failed. Fatal. */
  | "VISUAL_SEARCH_FAILED"
  | "INVALID_REQUEST"
  | "IMAGE_UPLOAD_FAILED"
  | "DEADLINE_EXCEEDED"
  | "INTERNAL_ERROR";

/** §24.2 — the complete NDJSON event union. */
export type InvestigationEvent =
  | { type: "investigation.started"; investigationId: string }
  | { type: "stage.started"; stage: Stage }
  | { type: "stage.completed"; stage: Stage; detail?: string }
  | { type: "search.batch"; engine: string; count: number }
  | { type: "evidence.discovered"; evidence: PublicEvidenceCandidate }
  | { type: "evidence.classified"; id: string; publicJudgment: PublicJudgment }
  | { type: "provenance.partial"; timeline: TimelineItem[] }
  | { type: "verdict.preliminary"; verdict: ClaimStatus }
  | { type: "divergence.detected"; divergence: Divergence }
  | { type: "investigation.completed"; result: InvestigationResult }
  | {
      type: "investigation.error";
      code: InvestigationErrorCode;
      message: string;
    };

export type InvestigationEventType = InvestigationEvent["type"];

export const EVENT_TYPES: readonly InvestigationEventType[] = [
  "investigation.started",
  "stage.started",
  "stage.completed",
  "search.batch",
  "evidence.discovered",
  "evidence.classified",
  "provenance.partial",
  "verdict.preliminary",
  "divergence.detected",
  "investigation.completed",
  "investigation.error",
];

/**
 * Serialize one event as an NDJSON line (terminating newline included).
 */
export function encodeEvent(event: InvestigationEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/**
 * Decode one NDJSON line. Returns null for blank lines and throws on
 * malformed JSON or an unknown event type — a stream consumer must not
 * silently accept shapes outside the contract.
 */
export function decodeEventLine(line: string): InvestigationEvent | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  const parsed: unknown = JSON.parse(trimmed);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { type?: unknown }).type !== "string" ||
    !EVENT_TYPES.includes(
      (parsed as { type: string }).type as InvestigationEventType,
    )
  ) {
    throw new Error("Unknown investigation event shape");
  }
  return parsed as InvestigationEvent;
}

/**
 * Incremental NDJSON reader: feed arbitrary chunks, get back complete events.
 * Partial trailing lines are buffered until their newline arrives.
 */
export class NdjsonEventReader {
  private buffer = "";

  feed(chunk: string): InvestigationEvent[] {
    this.buffer += chunk;
    const events: InvestigationEvent[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      const event = decodeEventLine(line);
      if (event !== null) events.push(event);
    }
    return events;
  }

  /** Events from any remaining complete buffered content at stream end. */
  flush(): InvestigationEvent[] {
    const tail = this.buffer;
    this.buffer = "";
    const event = decodeEventLine(tail);
    return event === null ? [] : [event];
  }
}
