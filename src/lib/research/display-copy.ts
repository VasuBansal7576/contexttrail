import type { Stage } from '../investigation/contracts/events';
import type { LimitationCode } from '../investigation/contracts/investigation';

const stages: Record<Stage, string> = {
  CLIENT_PREPROCESS: 'Preparing the sampled frame…',
  INITIAL_RETRIEVAL: 'Finding appearances of the sampled frame…',
  NORMALIZE: 'Organizing retrieved source leads…',
  VERIFY_MEDIA: 'Reviewing visual match information…',
  SCREEN_REPORTING_ORIGINS: 'Checking where reports came from…',
  FAST_CLASSIFY: 'Assessing initial source context…',
  PRELIMINARY: 'Preparing an initial evidence overview…',
  EXPAND_IF_NEEDED: 'Checking for additional source leads…',
  DEEP_READ: 'Reading source pages…',
  REFINED_CLASSIFY: 'Assessing context in retrieved passages…',
  REFINE_REPORTING_ORIGINS: 'Reviewing source attribution…',
  CHRONOLOGY: 'Organizing source-backed dates…',
  DIVERGENCE: 'Comparing context across sources…',
  FINAL_POLICY: 'Checking what the evidence can support…',
  COMPLETE: 'Preparing the research result…',
};

const limits: Record<LimitationCode, string> & Record<string, string> = {
  exact_match_retrieval_unavailable: 'Exact-match search was unavailable. Earlier appearances may have been missed.',
  no_exact_occurrences_returned: 'No exact appearances were returned by the search. This does not establish originality.',
  web_context_unavailable: 'Web context search was unavailable.',
  news_unavailable: 'News search was unavailable.',
  about_this_image_unavailable: 'Additional image-history information was unavailable.',
  semantic_classification_unavailable: 'Source context could not be assessed. Retrieved leads remain unassessed.',
  semantic_classification_partial: 'Only some source context could be assessed.',
  reporting_origins_unresolved: 'The original reporting sources remain unresolved. Separate links may repeat the same report.',
  unverified_visual_leads_present: 'Some visual leads have not been verified as matches.',
  near_match_verifier_disabled: 'Similar-looking images were not independently checked as matches.',
  page_fetch_partial_failure: 'Some source pages could not be read.',
  analysis_time_limit_reached: 'The investigation reached its time limit. Some checks may be incomplete.',
  insufficient_dated_occurrences: 'Too few appearances have usable dates to establish a chronology.',
  comparison_coverage_incomplete: 'Only some source contexts were compared. Differences may have been missed.',
  claim_date_unresolved: 'The date asserted in the claim could not be established.',
  disputed_dates_present: 'Some retrieved publication dates disagree.',
  unknown_dates_present: 'Some sources have no usable publication date.',
  image_investigation_only: 'This investigation concerns one image, not the wider event.',
  source_snapshots_not_retained: 'Source snapshots were not retained. Linked pages may change.',
  unsafe_source_urls_omitted: 'Unsafe source links were omitted.',
  capture_times_unknown: 'The time the image or video was captured remains unknown.',
  case_reference_omitted_invalid_source: 'A source reference could not be retained safely.',
};

/** Presentation only: the retained code, status and evidence bindings stay intact. */
export function researchLimitationCopy(value: string): string {
  if (Object.hasOwn(limits, value)) return limits[value];
  if (/^[a-zA-Z][a-zA-Z0-9_:-]*$/.test(value.trim())) return 'An additional investigation limit was reported, but its meaning is unavailable. Inspect technical details for the retained value.';
  return value;
}

export function researchStageCopy(value: string): string {
  for (const [stage, label] of Object.entries(stages)) if (stage === value) return label;
  return 'The investigation is continuing. Details for this step are unavailable.';
}

/** Older stream messages may still include the original stage identifier. */
export function researchProgressCopy(message: string): string {
  const stage = /^Examining retrieved frame evidence: (.+?)(?:…|\.{3})?$/.exec(message);
  if (stage) return researchStageCopy(stage[1]);
  if (/^[A-Z][A-Z0-9_]+$/.test(message.trim())) return researchStageCopy(message.trim());
  return message;
}
