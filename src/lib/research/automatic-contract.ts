import type { VisualScan } from '../video/visual-scan';
import type { MediaTranscript } from '../video/transcript';
import type { ClaimReport } from './claim-report';
import type { CaseRecord } from '../cases/model';
import type { InvestigationResult } from '../investigation/contracts/investigation';

/** Search caps are admission ceilings, never a statement about account balances. */
export const AUTOMATIC_RESEARCH_LIMITS = Object.freeze({ topicSearches: 6, topicSources: 12, topicPageReads: 10, topicCharacters: 500 });
export type AutomaticResearchInput =
  | { kind: 'topic'; topic: string }
  | { kind: 'video' | 'audio'; bytes: Uint8Array; rights: 'user_provided'; claim?: string | null };
export interface AutomaticResearchResult {
  kind: AutomaticResearchInput['kind'];
  question: string;
  caseRecord: CaseRecord;
  frames: Array<{ timestampMs: number; imageResult: InvestigationResult }>;
  limitations: string[];
  claimReport?: ClaimReport;
  transcript?: MediaTranscript;
  visualScan?: VisualScan;
  submittedClaim?: string | null;
  /** Spoken wording is an unreviewed search lead, never a verified user assertion. */
  spokenResearch?: AutomaticResearchResult;
  /** Relevance is model assessment, not factual verification or a truth score. */
  assessments: Array<{ evidenceId: string; relevance: number | null; model: string | null }>;
}
export type AutomaticResearchEvent =
  | { type: 'research.progress'; message: string }
  | { type: 'research.completed'; result: AutomaticResearchResult }
  | { type: 'research.error'; message: string };
