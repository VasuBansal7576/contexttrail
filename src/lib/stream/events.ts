/**
 * Tolerant public event shape for `POST /api/investigate` NDJSON stream.
 *
 * Mirrors spec section 24.2. The backend (parallel evidence worker) owns the
 * authoritative detail; this module accepts every documented event and ignores
 * unknown event types so later backend detail never breaks the frontend.
 *
 * Rendering rule: only values actually present in a received event are shown.
 * Nothing here fabricates publishers, dates, counts, or excerpts.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonRecord = { [key: string]: JsonValue };

/** Pipeline stages from spec section 9.2. Kept open so new stages render. */
export const KNOWN_STAGES = [
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
] as const;

export type Stage = (typeof KNOWN_STAGES)[number] | (string & {});

/** Human-readable stage labels for the investigation screen. */
export const STAGE_LABELS: Record<string, string> = {
  CLIENT_PREPROCESS: "Preparing image",
  INITIAL_RETRIEVAL: "Finding visual leads with Google Lens",
  NORMALIZE: "Checking exact matches",
  VERIFY_MEDIA: "Verifying media identity",
  SCREEN_REPORTING_ORIGINS: "Checking image history",
  FAST_CLASSIFY: "Classifying evidence",
  PRELIMINARY: "Searching the web",
  EXPAND_IF_NEEDED: "Searching current news",
  DEEP_READ: "Reading key sources",
  REFINED_CLASSIFY: "Refining classification",
  REFINE_REPORTING_ORIGINS: "Refining reporting origins",
  CHRONOLOGY: "Building provenance timeline",
  DIVERGENCE: "Comparing contexts",
  FINAL_POLICY: "Finalizing result",
  COMPLETE: "Complete",
};

/** Claim-check statuses from spec section 1.7. */
export const CLAIM_STATUSES = [
  "CONTEXT_CONFLICT",
  "POSSIBLE_CONTEXT_CONFLICT",
  "NO_CONFLICT_FOUND",
  "INSUFFICIENT_EVIDENCE",
] as const;

export type ClaimStatus = (typeof CLAIM_STATUSES)[number] | (string & {});

export interface BaseEvent {
  type: string;
  [key: string]: JsonValue | undefined;
}

export interface InvestigationStartedEvent extends BaseEvent {
  type: "investigation.started";
  investigationId: string;
}

export interface StageStartedEvent extends BaseEvent {
  type: "stage.started";
  stage: Stage;
}

export interface StageCompletedEvent extends BaseEvent {
  type: "stage.completed";
  stage: Stage;
  detail?: string;
}

export interface SearchBatchEvent extends BaseEvent {
  type: "search.batch";
  engine: string;
  count: number;
}

export interface EvidenceDiscoveredEvent extends BaseEvent {
  type: "evidence.discovered";
  evidence: JsonRecord;
}

export interface EvidenceClassifiedEvent extends BaseEvent {
  type: "evidence.classified";
  id: string;
  publicJudgment: JsonRecord;
}

export interface ProvenancePartialEvent extends BaseEvent {
  type: "provenance.partial";
  timeline: JsonRecord[];
}

export interface VerdictPreliminaryEvent extends BaseEvent {
  type: "verdict.preliminary";
  verdict: ClaimStatus;
}

export interface DivergenceDetectedEvent extends BaseEvent {
  type: "divergence.detected";
  divergence: JsonRecord;
}

export interface InvestigationCompletedEvent extends BaseEvent {
  type: "investigation.completed";
  result: JsonRecord;
}

export interface InvestigationErrorEvent extends BaseEvent {
  type: "investigation.error";
  code: string;
  message: string;
}

export type InvestigationEvent =
  | InvestigationStartedEvent
  | StageStartedEvent
  | StageCompletedEvent
  | SearchBatchEvent
  | EvidenceDiscoveredEvent
  | EvidenceClassifiedEvent
  | ProvenancePartialEvent
  | VerdictPreliminaryEvent
  | DivergenceDetectedEvent
  | InvestigationCompletedEvent
  | InvestigationErrorEvent
  | BaseEvent;

const KNOWN_EVENT_TYPES = new Set([
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
]);

/**
 * Parse one NDJSON line into an event. Returns null for blank lines,
 * malformed JSON, or payloads without a string `type`.
 */
export function parseEventLine(line: string): InvestigationEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.type !== "string") return null;
  return record as InvestigationEvent;
}

export function isKnownEventType(type: string): boolean {
  return KNOWN_EVENT_TYPES.has(type);
}

/* ------------------------------------------------------------------ */
/* Defensive field accessors. Backend detail may evolve; views must    */
/* render fallbacks ("Date unknown", "No excerpt available", …)       */
/* instead of crashing or inventing values.                           */
/* ------------------------------------------------------------------ */

export function asRecord(value: JsonValue | undefined): JsonRecord | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as JsonRecord;
  }
  return null;
}

export function str(record: JsonRecord | null | undefined, key: string): string | null {
  if (!record) return null;
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function num(record: JsonRecord | null | undefined, key: string): number | null {
  if (!record) return null;
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function arr(
  record: JsonRecord | null | undefined,
  key: string,
): JsonValue[] | null {
  if (!record) return null;
  const value = record[key];
  return Array.isArray(value) ? (value as JsonValue[]) : null;
}

export function rec(
  record: JsonRecord | null | undefined,
  key: string,
): JsonRecord | null {
  if (!record) return null;
  return asRecord(record[key]);
}
