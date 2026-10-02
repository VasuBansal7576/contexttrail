import { describe, expect, it } from 'vitest';
import { parseAutomaticResearchResult } from './automatic-client';
import { captionFindingsFixture } from './caption-findings-fixture';
import { savedVideoView, parseSavedVideoReport } from './saved-video';
import { projectCaptionFindings } from './caption-findings';

function view(input: unknown) { return parseAutomaticResearchResult(input).frames[0].imageResult; }
function changedFinding(change: Record<string, unknown>) {
  const fixture = captionFindingsFixture(), image = fixture.frames[0].imageResult;
  image.sourceLinkedReport.captionFindings[0] = { ...image.sourceLinkedReport.captionFindings[0], ...change };
  return fixture;
}
describe('readable automatic caption findings', () => {
  it('exposes bound challenge/context/support leads without selecting a stronger status or inventing a quote', () => {
    const fixture = captionFindingsFixture(), projected = view(fixture);
    expect(projected.captionComparison?.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(projected.captionFindings.kind).toBe('available');
    if (projected.captionFindings.kind !== 'available') throw new Error('Missing explanatory view');
    expect(projected.captionFindings.withheldCount).toBe(0);
    expect(projected.captionFindings.findings).toHaveLength(3);
    expect(projected.captionFindings.findings[0]).toMatchObject({ sourceUrl: 'https://example.com/article?id=old-context', passage: null, classificationContext: fixture.caseRecord.evidence[0].title, identityBasis: 'unverified', policyEligibleIdentity: false });
    expect(projected.captionFindings.findings[1].passage?.kind).toBe('search_snippet');
    expect(projected.captionFindings.findings[2].passage?.kind).toBe('page_quote');
    expect(projected.captionFindings.findings[2].signals[0].kind).toBe('caption_support');
    expect(projected.captionFindings.gates).toEqual([{ gate: 'qualifying_conflicts', passed: false }]);
  });
  it('projects older intact saved archives through the new view without changing raw findings', () => {
    const fixture = captionFindingsFixture();
    const saved = parseSavedVideoReport({ schemaVersion: 'contexttrail-video-report-v1', result: fixture });
    expect(saved.result).toEqual(fixture);
    expect(savedVideoView(saved).frames[0].imageResult.captionFindings).toEqual(view(fixture).captionFindings);
    expect(savedVideoView(saved).frames[0].imageResult.captionComparison?.status).toBe('INSUFFICIENT_EVIDENCE');
  });
  it.each([
    { evidenceId: 'missing' }, { sourceUrl: 'javascript:alert(1)' }, { sourceUrl: 'https://example.com/wrong' }, { sourceUrl: 'https://user:secret@example.com/article' },
    { model: 'jev-latest' }, { assessment: 'verified_truth' }, { authority: 'established' }, { independentCorroboration: 'verified' }, { excerptEntailment: 'verified' },
    { signals: [{ kind: 'true', probability: .9 }] }, { signals: [{ kind: 'caption_support', probability: 1.01 }] }, { signals: [{ kind: 'caption_support', probability: .74 }] }, { signals: [] },
    { signals: [{ kind: 'caption_support', probability: .8 }, { kind: 'caption_support', probability: .9 }] },
    { mediaIdentity: { basis: 'lens_exact_collection', verificationStatus: 'provider_reported' }, policyEligibleIdentity: true }, { policyEligibleIdentity: true }, { reportingOrigin: 'independent_by_domain' },
    { excerpt: 'Fabricated page quote.', excerptSource: 'page_text' }, { classificationContext: 'Invented classifier input.' },
  ])('withholds a malformed, unbound or promoted finding while preserving the archive and cautious result: %j', change => {
    const fixture = changedFinding(change), projected = view(fixture);
    expect(projected.captionComparison?.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(projected.captionFindings).toMatchObject({ kind: 'available', withheldCount: 1 });
    const retained = parseAutomaticResearchResult(fixture).retainedResult;
    expect(retained?.frames).toEqual(fixture.frames);
  });
  it('rejects non-finite signals at the explanatory boundary and keeps invalid report payload non-fatal', () => {
    const fixture = captionFindingsFixture(), projected = view(fixture), image = fixture.frames[0].imageResult;
    const sources = projected.undatedEvidence;
    for (const probability of [NaN, Infinity, -Infinity, -1]) {
      const report = { ...image.sourceLinkedReport, captionFindings: [{ ...image.sourceLinkedReport.captionFindings[0], signals: [{ kind: 'caption_contradiction', probability }] }] };
      expect(projectCaptionFindings(report, sources, fixture.caseRecord.evidence, image.policyReasons)).toMatchObject({ kind: 'available', findings: [], withheldCount: 1 });
    }
    for (const sourceLinkedReport of [null, [], {}, { version: 'other', captionFindings: [] }, { version: 'source-linked-report-v1', captionFindings: null }]) {
      expect(view({ ...fixture, frames: [{ timestampMs: 1000, imageResult: { ...image, sourceLinkedReport } }] }).captionFindings).toEqual({ kind: 'unavailable', reason: 'invalid_report' });
    }
    const { sourceLinkedReport: _report, ...legacy } = image;
    expect(view({ ...fixture, frames: [{ timestampMs: 1000, imageResult: legacy }] }).captionFindings).toEqual({ kind: 'unavailable', reason: 'not_retained' });
  });
  it('withholds duplicate IDs, missing retained evidence, and different query-addressed frame resources', () => {
    const fixture = captionFindingsFixture(), image = fixture.frames[0].imageResult;
    image.sourceLinkedReport.captionFindings.push(image.sourceLinkedReport.captionFindings[0]);
    expect(view(fixture).captionFindings).toMatchObject({ kind: 'available', withheldCount: 2 });
    const missing = captionFindingsFixture(); missing.caseRecord.evidence = missing.caseRecord.evidence.slice(1); missing.assessments = missing.assessments.slice(1);
    expect(view(missing).captionFindings).toMatchObject({ kind: 'available', withheldCount: 1 });
    const changed = captionFindingsFixture(); changed.caseRecord.evidence[0].sourceUrl = 'https://example.com/article?id=different-resource';
    expect(view(changed).captionFindings).toMatchObject({ kind: 'available', withheldCount: 1 });
  });
  it('keeps fragment and host normalization while preserving the exact semantic query in live and saved links', () => {
    const fixture = captionFindingsFixture();
    expect(fixture.frames[0].imageResult.undatedEvidence[0].sourceUrl).toBe('HTTPS://EXAMPLE.COM.:443/article?id=old-context#article');
    expect(fixture.caseRecord.evidence[0].sourceUrl).toBe('https://example.com/article?id=old-context');
    const live = view(fixture).captionFindings;
    expect(live).toMatchObject({ kind: 'available', withheldCount: 0, findings: [{ sourceUrl: 'https://example.com/article?id=old-context' }, {}, {}] });
    const saved = parseSavedVideoReport({ schemaVersion: 'contexttrail-video-report-v1', result: fixture });
    expect(savedVideoView(saved).frames[0].imageResult.captionFindings).toEqual(live);
  });
  it('withholds passed gates without their minimum unique safe bound support', () => {
    const fixture = captionFindingsFixture(), image = fixture.frames[0].imageResult;
    for (const gate of ['qualifying_conflicts', 'corroborating_pair', 'relevant_core_coverage', 'distinct_domains', 'distinct_reporting_groups', 'strong_support']) {
      for (const supportIds of [[], ['support-lead', 'support-lead']]) {
        if (gate === 'strong_support' && supportIds.length) continue;
        image.policyReasons = [{ gate, passed: true, supportIds, detail: 'Malformed passed gate.' }];
        expect(view(fixture).captionFindings).toMatchObject({ kind: 'available', gates: [] });
        expect(view(fixture).captionComparison?.status).toBe('INSUFFICIENT_EVIDENCE');
      }
    }
    image.policyReasons = [{ gate: 'corroborating_pair', passed: false, supportIds: [], detail: 'No corroborating pair.' }];
    expect(view(fixture).captionFindings).toMatchObject({ kind: 'available', gates: [{ gate: 'corroborating_pair', passed: false }] });
    image.policyReasons = [{ gate: 'strong_support', passed: true, supportIds: ['support-lead'], detail: 'One bound recorded support.' }];
    expect(view(fixture).captionFindings).toMatchObject({ kind: 'available', gates: [{ gate: 'strong_support', passed: true }] });
  });
  it('does not reclassify snippets/composites as page quotes or accept forged policy gates', () => {
    const fixture = captionFindingsFixture(), image = fixture.frames[0].imageResult;
    image.sourceLinkedReport.captionFindings[1].excerptSource = 'page_text';
    image.policyReasons = [{ gate: 'corroborating_pair', passed: true, supportIds: ['missing'], detail: 'Forged independent corroboration.' }];
    expect(view(fixture).captionFindings).toMatchObject({ kind: 'available', withheldCount: 1, gates: [] });
  });
  it.each(['lens_exact_collection', 'local_spatial_verification'])('withholds contradictory %s basis when verification did not pass', basis => {
    const fixture = captionFindingsFixture(), image = fixture.frames[0].imageResult;
    image.undatedEvidence[0].identityBasis = basis;
    image.undatedEvidence[0].mediaRelationship = basis === 'lens_exact_collection' ? 'EXACT_MATCH' : 'NEAR_MATCH';
    image.sourceLinkedReport.captionFindings[0].mediaIdentity = { basis, verificationStatus: 'failed', hashDistance: null, verifierVersion: null, verifierConfigId: null, comparisonMetrics: null };
    image.sourceLinkedReport.captionFindings[0].policyEligibleIdentity = false;
    expect(view(fixture).captionFindings).toMatchObject({ kind: 'available', withheldCount: 1 });
  });
  it('keeps a failed spatial check as an ineligible visual lead, while rejecting hash-only near identity', () => {
    const fixture = captionFindingsFixture(), image = fixture.frames[0].imageResult;
    image.undatedEvidence[0].identityBasis = 'local_spatial_verification';
    image.sourceLinkedReport.captionFindings[0].mediaIdentity = { basis: 'local_spatial_verification', verificationStatus: 'failed', hashDistance: null, verifierVersion: null, verifierConfigId: null, comparisonMetrics: null };
    expect(view(fixture).captionFindings).toMatchObject({ kind: 'available', withheldCount: 0, findings: [{ identityBasis: 'local_spatial_verification', policyEligibleIdentity: false }, {}, {}] });
    image.undatedEvidence[0].mediaRelationship = 'NEAR_MATCH';
    image.sourceLinkedReport.captionFindings[0].mediaIdentity.verificationStatus = 'passed';
    image.sourceLinkedReport.captionFindings[0].policyEligibleIdentity = true;
    expect(view(fixture).captionFindings).toMatchObject({ kind: 'available', withheldCount: 1 });
  });
});
