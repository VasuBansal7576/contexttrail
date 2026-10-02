import { videoSaveFixture } from './video-save-fixture';
import type { CaseEvidence } from '../cases/model';
/** Synthetic relationships only; never a fact check or a provider response. */
export function captionFindingsFixture() {
  const base = videoSaveFixture();
  const rows = [
    { evidenceId: 'title-lead', sourceUrl: 'https://example.com/article?id=old-context', title: 'Synthetic fact-check title: an older demolition in another location', excerpt: null, excerptSource: null, classificationContext: 'Synthetic fact-check title: an older demolition in another location', identityBasis: 'unverified', mediaRelationship: 'VISUAL_LEAD', signals: [{ kind: 'caption_contradiction', probability: .85 }, { kind: 'different_context', probability: .84 }, { kind: 'different_location', probability: .78 }] },
    { evidenceId: 'snippet-lead', sourceUrl: 'https://context.example.net/story', title: 'Synthetic contextual lead', excerpt: 'Synthetic search snippet about another event.', excerptSource: 'serp_snippet', classificationContext: 'Synthetic contextual lead. Synthetic search snippet about another event.', identityBasis: 'contextual', mediaRelationship: null, signals: [{ kind: 'caption_contradiction', probability: .93 }] },
    { evidenceId: 'support-lead', sourceUrl: 'https://support.example.org/report', title: 'Synthetic supporting source', excerpt: 'Synthetic retained page sentence describing the supplied caption.', excerptSource: 'page_text', classificationContext: 'Synthetic supporting source. Synthetic retained page sentence describing the supplied caption.', identityBasis: 'lens_exact_collection', mediaRelationship: 'EXACT_MATCH', signals: [{ kind: 'caption_support', probability: .88 }] },
  ];
  const evidence: CaseEvidence[] = rows.map(row => ({ ...base.caseRecord.evidence[0], id: row.evidenceId, sourceUrl: row.sourceUrl, title: row.title, content: row.excerpt === null ? { kind: 'reference' } : { kind: 'text', attribution: row.excerptSource === 'page_text' ? 'page_quote' : 'search_snippet', text: row.excerpt } }));
  const image = base.frames[0].imageResult;
  const supportIds: string[] = [];
  return { ...base, caseRecord: { ...base.caseRecord, id: 'offline-caption-findings', evidence }, assessments: evidence.map(item => ({ evidenceId: item.id, relevance: null, model: null })), frames: [{ timestampMs: 1000, imageResult: { ...image,
    undatedEvidence: rows.map(({ signals: _signals, ...row }) => ({ ...row, dateStatus: 'unknown', observedAt: null })),
    sourceLinkedReport: { version: 'source-linked-report-v1', captionFindings: rows.map(row => ({ evidenceId: row.evidenceId, sourceUrl: row.sourceUrl.split('?')[0], assessment: 'model_assessed_source_relation', signals: row.signals, mediaIdentity: { basis: row.identityBasis, verificationStatus: row.identityBasis === 'lens_exact_collection' ? 'provider_reported' : 'unavailable', hashDistance: null, verifierVersion: null, verifierConfigId: null, comparisonMetrics: null }, policyEligibleIdentity: row.identityBasis === 'lens_exact_collection', authority: 'not_established', independentCorroboration: 'see_existing_policy_gates', excerpt: row.excerpt, excerptSource: row.excerptSource, classificationContext: row.classificationContext, excerptEntailment: 'not_separately_verified', model: 'jev-1.13.0', reportingOrigin: 'unresolved' })) },
    policyReasons: [{ gate: 'qualifying_conflicts', passed: false, supportIds, detail: 'Synthetic sources do not qualify for a conflict verdict.' }],
  } }] };
}
