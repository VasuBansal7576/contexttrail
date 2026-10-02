import type { CaptionFinding, CaptionFindingsView } from '@/lib/research/caption-findings';
import { EvidenceCollection, EvidencePassage, SourceActions } from './EvidenceCollection';
import styles from './CaptionFindings.module.css';

const relations = {
  caption_contradiction: 'Source challenges the supplied caption',
  different_context: 'Source suggests a different event or context',
  different_location: 'Source suggests a different location',
  caption_support: 'Source supports the supplied caption',
};
const identities = {
  unverified: 'Unverified visual lead. This source has not established sampled-frame identity and cannot qualify through the media-identity gate.',
  contextual: 'Contextual source. It does not establish a sighting of this sampled frame and cannot qualify through the media-identity gate.',
  lens_exact_collection: 'The sampled-frame source is recorded as a provider-reported exact occurrence. This does not establish whole-video identity.',
  local_spatial_verification: 'The sampled-frame source is recorded with local spatial verification. This does not establish whole-video identity.',
};
const gates = {
  qualifying_conflicts: 'Enough qualifying caption conflicts',
  corroborating_pair: 'Corroborating pair with identity and separate reporting evidence',
  relevant_core_coverage: 'Enough relevant core media occurrences',
  distinct_domains: 'Enough distinct source domains',
  distinct_reporting_groups: 'Enough separately evidenced reporting groups',
  strong_support: 'Strong caption support',
};
function Finding({ finding }: { finding: CaptionFinding }) {
  return <article className={`source-card ${styles.finding}`}>
    <p className="eyebrow">Model-assessed source relation</p>
    <h4>{finding.title ?? 'Untitled source'}</h4>
    <ul>{finding.signals.map(signal => <li key={signal.kind}>{relations[signal.kind]}.</li>)}</ul>
    <p className="fine-print">{!finding.policyEligibleIdentity && (finding.identityBasis === 'local_spatial_verification' || finding.identityBasis === 'lens_exact_collection') ? 'The recorded identity check did not establish sampled-frame identity. This remains an unverified visual lead and cannot qualify through the media-identity gate.' : identities[finding.identityBasis]}</p>
    <details className={styles.inspection}><summary>Inspect source text and assessment</summary>
      {finding.passage ? <><p className="eyebrow">{finding.passage.kind === 'page_quote' ? 'Retained page excerpt' : finding.passage.kind === 'search_snippet' ? 'Retained search snippet' : 'Retained classification context'}</p><EvidencePassage text={finding.passage.text} /><p className="fine-print">{finding.passage.kind === 'page_quote' ? 'This exact retained excerpt was not separately checked for entailment of the assessment.' : 'This is classifier context, not an extracted page quote. It does not independently establish the caption.'}</p></> : <p className="fine-print">No source excerpt was retained. No page quote can be shown for this finding.</p>}
      {finding.classificationContext ? <><p className="eyebrow">{finding.classificationContext === finding.title ? 'Title used for classification' : 'Text used for classification'}</p><p className={styles.context}>{finding.classificationContext}</p><p className="fine-print">Classification input may contain a title, search snippet or composite page text. It is not presented as a page quote.</p></> : <p className="fine-print">Classification input was not retained.</p>}
      <p className="fine-print">Recorded reporting origin: {finding.reportingOrigin.replaceAll('_', ' ')}. Source authority is not established here. Independent corroboration requires the existing policy gates, including inspectable reporting-origin evidence.</p>
      <details><summary>Inspect model probabilities</summary><p className="fine-print">Model: jev-1.13.0. These probabilities describe the model's source-relation assessment, not factual truth, independent corroboration or verified media identity.</p><ul>{finding.signals.map(signal => <li key={signal.kind}>{relations[signal.kind]}: {signal.probability}</li>)}</ul></details>
    </details>
    <SourceActions url={finding.sourceUrl} />
  </article>;
}
export function CaptionFindings({ view }: { view: CaptionFindingsView }) {
  return <section className={styles.report} aria-label="Source-linked caption leads">
    <h4>Source-linked caption leads</h4>
    <p className="fine-print">These explain retained model assessments of sources that challenge or support the caption, or suggest other context. They do not change the caption result. A source's title or model probability cannot establish media identity, factual truth or independent corroboration. Other frames, audio, original author and capture time remain unverified.</p>
    {view.kind === 'unavailable' ? <p className="fine-print">{view.reason === 'not_retained' ? 'This older report did not retain the source-linked assessment details.' : 'Source-linked assessment details could not be validated for this view.'} The overall caption result and retained source records remain available.</p> : <>
      {view.findings.length ? <EvidenceCollection items={view.findings} label="Caption leads" pageSize={4}>{finding => <Finding key={finding.evidenceId} finding={finding} />}</EvidenceCollection> : <p className="fine-print">No validated source-linked caption leads are available. This does not establish that the caption is true.</p>}
      {view.withheldCount ? <p className="fine-print">{view.withheldCount} retained finding{view.withheldCount === 1 ? ' was' : 's were'} withheld because its assessment, source binding, identity or text could not be validated. The original technical archive retains these details.</p> : null}
      {view.gates.length ? <details className={styles.inspection}><summary>Why a stronger caption result requires more evidence</summary><p className="fine-print">Recorded deterministic gates for this sampled-frame result. Model-assessed leads alone cannot meet identity, coverage and independent-reporting requirements.</p><ul>{view.gates.map(gate => <li key={gate.gate}>{gates[gate.gate]}: {gate.passed ? 'met in the recorded result' : 'not met in the recorded result'}.</li>)}</ul></details> : <p className="fine-print">Detailed policy gates are unavailable in this projection. The cautious caption result is unchanged.</p>}
    </>}
  </section>;
}
