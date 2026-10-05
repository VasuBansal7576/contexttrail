import type { CaseEvidence, CaseRecord } from '../cases/model';
import type { ClaimReport, ClaimSourceAssessment } from './claim-report';
import { selectClaimQuotePassage } from './claim-quote-passage';

export interface AccountSource {
  evidence: CaseEvidence;
  assessment: ClaimSourceAssessment;
  passage: string;
  attribution: 'page_quote' | 'search_snippet' | 'classification_context';
}

/** A reading account derived from retained evidence. No new factual assertion or model call. */
export function researchAccount(report: ClaimReport, record: CaseRecord) {
  const sources: AccountSource[] = [];
  for (const assessment of report.sources) {
    const evidence = record.evidence.find(item => item.id === assessment.evidenceId);
    if (!evidence || assessment.relevance === null || assessment.relevance < 0.5) continue;
    const selected = selectClaimQuotePassage(assessment.quote, evidence);
    if (!selected.quote) continue;
    sources.push({ evidence, assessment, passage: selected.quote.text, attribution: selected.quote.attribution });
  }
  sources.sort((a, b) => {
    const readDifference = Number(b.attribution === 'page_quote') - Number(a.attribution === 'page_quote');
    return readDifference || (b.assessment.relevance ?? 0) - (a.assessment.relevance ?? 0);
  });
  const supporting = sources.filter(source => source.assessment.relation === 'support');
  const challenging = sources.filter(source => source.assessment.relation === 'challenge');
  const readCount = record.evidence.filter(evidence => evidence.content.kind === 'text' && evidence.content.attribution === 'page_quote').length;
  const headline = report.mode === 'source_assertions' ? 'What the sources say.'
    : supporting.length && challenging.length ? 'The retained excerpts disagree.'
    : challenging.length ? 'There is evidence against this claim.'
    : supporting.length ? 'There is evidence supporting this claim.'
    : 'The claim is still unresolved.';
  return { sources, supporting, challenging, readCount, leadCount: record.evidence.length - readCount, headline };
}
