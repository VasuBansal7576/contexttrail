import { describe, expect, it } from 'vitest';
import { DEEP_READ_AUDIT_LIMIT, parseDeepReadSelectionAudit, type DeepReadSelectionAudit } from '../deep-read-audit';

const sources = Array.from({ length: 6 }, (_, index) => ({ evidenceId: `source-${index}`, sourceUrl: `https://source${index}.example/article?id=original` }));
function fixture(): DeepReadSelectionAudit {
  const reasons = ['core_anchor', 'fact_check', 'current_reporting', 'core_recovery', 'filler'] as const;
  return { schemaVersion: 'deep-read-selection-v1', withheldCandidateCount: 0,
    candidates: sources.map((source, index) => ({ ...source, judgment: { kind: 'assessed', relevance: index === 5 ? .68 : .79, factCheck: index === 1 || index === 5 ? 1 : 0 },
      historicalMediaCue: index === 1 || index === 5, factCheckWinner: index === 1,
      plan: index < reasons.length ? { kind: 'selected', position: index + 1, reason: reasons[index] } : { kind: 'not_selected' },
    })), finalDecision: { kind: 'alternate_fact_check', evidenceId: 'source-5', failedFactCheckId: 'source-1', displacedEvidenceId: 'source-4' } };
}
describe('additive frozen read selection boundary', () => {
  it('roundtrips bounded frozen probabilities, role/cue/plan and a separate adaptive decision', () => {
    const value = fixture(), before = JSON.stringify(value);
    expect(parseDeepReadSelectionAudit(JSON.parse(before), sources)).toEqual(value);
    expect(JSON.stringify(value)).toBe(before);
  });
  it.each([undefined, null, 'legacy', {}, { schemaVersion: 'future' }])('withholds absent/unsupported diagnostics without rejecting an old report: %j', value => {
    expect(parseDeepReadSelectionAudit(value, sources)).toBeNull();
  });
  it.each([
    ['nonfinite relevance', (value: DeepReadSelectionAudit) => { value.candidates[5].judgment = { kind: 'assessed', relevance: NaN, factCheck: 1 }; }],
    ['out of range role', (value: DeepReadSelectionAudit) => { value.candidates[5].judgment = { kind: 'assessed', relevance: .68, factCheck: 1.1 }; }],
    ['duplicate ID', (value: DeepReadSelectionAudit) => { value.candidates[5].evidenceId = 'source-0'; }],
    ['duplicate position', (value: DeepReadSelectionAudit) => { value.candidates[4].plan = { kind: 'selected', position: 1, reason: 'filler' }; }],
    ['missing plan position', (value: DeepReadSelectionAudit) => { value.candidates[2].plan = { kind: 'not_selected' }; }],
    ['different query resource', (value: DeepReadSelectionAudit) => { value.candidates[5].sourceUrl = 'https://source5.example/article?id=other'; }],
    ['unsafe URL', (value: DeepReadSelectionAudit) => { value.candidates[5].sourceUrl = 'http://127.0.0.1/article'; }],
    ['weaker alternate role', (value: DeepReadSelectionAudit) => { value.candidates[5].judgment = { kind: 'assessed', relevance: 1, factCheck: .99 }; }],
    ['protected displaced role', (value: DeepReadSelectionAudit) => { value.candidates[4].plan = { kind: 'selected', position: 5, reason: 'current_reporting' }; }],
    ['missing cue', (value: DeepReadSelectionAudit) => { value.candidates[5].historicalMediaCue = false; }],
    ['unbound final ID', (value: DeepReadSelectionAudit) => { value.finalDecision = { kind: 'inspected_link', evidenceId: 'absent' }; }],
    ['ambiguous winner', (value: DeepReadSelectionAudit) => { value.candidates[5].factCheckWinner = true; }],
    ['unassessed selected source', (value: DeepReadSelectionAudit) => { value.candidates[0].judgment = { kind: 'unassessed' }; }],
    ['oversized audit', (value: DeepReadSelectionAudit) => { value.withheldCandidateCount = DEEP_READ_AUDIT_LIMIT; }],
  ])('withholds malformed diagnostics: %s', (_label, change) => {
    const value = fixture(); change(value);
    expect(parseDeepReadSelectionAudit(value, sources)).toBeNull();
  });
  it('requires a unique source binding and accepts conservative URL spelling normalization', () => {
    const value = fixture(); value.candidates[0].sourceUrl = 'HTTPS://SOURCE0.EXAMPLE.:443/article?id=original#article';
    expect(parseDeepReadSelectionAudit(value, sources)?.candidates[0].sourceUrl).toBe(sources[0].sourceUrl);
    expect(parseDeepReadSelectionAudit(value, [...sources, sources[0]])).toBeNull();
  });
  it('keeps original positions across withheld unsafe references, but withholds a decision referencing that missing source', () => {
    const value = fixture(); value.candidates.splice(1, 1); value.withheldCandidateCount = 1;
    expect(parseDeepReadSelectionAudit(value, sources)).toBeNull();
    value.finalDecision = { kind: 'original_plan', evidenceId: 'source-4' };
    expect(parseDeepReadSelectionAudit(value, sources)?.candidates.flatMap(row => row.plan.kind === 'selected' ? [row.plan.position] : [])).toEqual([1, 3, 4, 5]);
  });
});
