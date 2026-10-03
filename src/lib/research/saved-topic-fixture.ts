import { assessClaimSource, buildClaimReport } from './claim-report';
import { videoSaveFixture } from './video-save-fixture';
import { parseCaseRecord } from '../cases/parse';
/** Existing synthetic source adapted for saved-topic presentation. No providers or factual verdict. */
export function savedTopicFixture(id: string) {
  const caseRecord = parseCaseRecord(videoSaveFixture().caseRecord);
  caseRecord.id = id;
  caseRecord.coverage.omittedEvidenceCount = 12;
  caseRecord.coverage.limitations = [
    'Bounded web sample; coverage is incomplete.',
    'Primary-source coverage has not been independently established. Original-account cues in titles or snippets guide selection; they do not verify source authority or completeness.',
    'Source 3 could not be read; its original search lead remains.',
    'Source 4 could not be read; its original search lead remains.',
    'Source 5 led to an unrelated, blocked or unsafe destination. Its original search lead remains; destination text and dates were not used.',
    'Some relevance assessments were unavailable; those sources remain unassessed leads.',
  ];
  caseRecord.coverage.sourceReads = [
    { evidenceId: 'source', requestedUrl: 'https://example.com/original', finalUrl: null, sourceBinding: 'not_established', outcome: 'fetch_failed' },
    { evidenceId: 'source-5', requestedUrl: 'https://example.com/other', finalUrl: 'https://example.com/login', sourceBinding: 'blocked_destination', outcome: 'binding_rejected' },
  ];
  const question = 'What changed in the synthetic institution policy?';
  const claimReport = buildClaimReport(question, caseRecord, caseRecord.evidence.map(evidence => assessClaimSource(evidence, null, null)));
  return { kind: 'topic', question, caseRecord, claimReport, limitations: caseRecord.coverage.limitations, frames: [], assessments: caseRecord.evidence.map(evidence => ({ evidenceId: evidence.id, relevance: null, model: null })) };
}
