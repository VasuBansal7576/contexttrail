import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { applyInquiry, findingViews } from './workspace';
import { parseWorkspace } from './parse';
const fixture = (name: string) => JSON.parse(readFileSync(`scripts/fixtures/inquiries/${name}.json`, 'utf8'));
function journey() { const start = applyInquiry(null, fixture('start')); const evidence = applyInquiry(start.workspace, fixture('evidence')); return { start, evidence }; }
describe('open inquiry workflow', () => {
  it('keeps questions and hypotheses separate from assertions, binds exact quotations and restores stale findings', () => {
    const { start, evidence } = journey();
    expect(start.workspace.collection.cases[0].claims).toEqual([]);
    expect(evidence.workspace.subquestions[0].kind).toBe('subquestion');
    expect(evidence.workspace.hypotheses[0].kind).toBe('hypothesis');
    expect(evidence.findings[0].support[0].status).toBe('current');
    const changed = applyInquiry(evidence.workspace, fixture('correction'));
    expect(changed.notices).toHaveLength(1);
    expect(changed.findings[0].reviewStatus).toBe('needs_review');
    expect(changed.findings[0].support[0].status).toBe('changed');
    const restored = parseWorkspace(JSON.parse(JSON.stringify(changed.workspace)));
    expect(findingViews(restored)).toEqual(changed.findings);
    expect(restored.history[1].research.findings[0].finding.support[0].anchor).toEqual({ kind: 'text', start: 0, quote: 'Harbor Bridge reopened on Monday' });
    const replay = applyInquiry(restored, fixture('correction'));
    expect(replay.notices).toEqual([]); expect(replay.workspace.revision).toBe(3);
  });
  it('rejects fake quotes, missing questions, unsupported schema, conflicting operations and stale writers without mutation', () => {
    const { start, evidence } = journey();
    const bad = fixture('evidence'); bad.findings[0].support[0].anchor.quote = 'Made up quotation';
    expect(() => applyInquiry(start.workspace, bad)).toThrow('lacks exact evidence');
    expect(start.workspace.collection.cases[0].evidence).toEqual([]);
    const missing = fixture('evidence'); missing.findings[0].questionId = 'absent';
    expect(() => applyInquiry(start.workspace, missing)).toThrow('question reference');
    expect(() => parseWorkspace({ ...evidence.workspace, schemaVersion: 'future' })).toThrow();
    expect(() => applyInquiry(evidence.workspace, { ...fixture('evidence'), expectedRevision: 2 })).toThrow('Operation ID');
    expect(() => applyInquiry(evidence.workspace, { ...fixture('correction'), expectedRevision: 1 })).toThrow('revision');
  });
  it('preserves evidence after failed retrieval and marks confirmed missing evidence unavailable', () => {
    const { evidence } = journey();
    const request = { kind: 'update', operationId: 'failure', expectedRevision: 2, caseUpdates: { watchlists: [], familyLinks: [], updates: [{ kind: 'retrieval_failed', caseId: 'harbor-bridge', reason: 'Synthetic timeout' }] }, subquestions: [], hypotheses: [], findings: [] };
    const failure = applyInquiry(evidence.workspace, request);
    expect(failure.findings[0].reviewStatus).toBe('current'); expect(failure.failures).toHaveLength(1);
    const c = structuredClone(evidence.workspace.collection.cases[0]); c.revision = 3; c.evidence = []; c.relations = [];
    const removal = { ...request, operationId: 'removal', caseUpdates: { watchlists: [], familyLinks: [], updates: [{ kind: 'snapshot', caseRecord: c, removal: { status: 'confirmed', reason: 'Fixture withdrawal' } }] } };
    expect(applyInquiry(evidence.workspace, removal).findings[0].support[0].status).toBe('unavailable');
  });
  it('does not refresh stale support through identical finding resubmission', () => {
    const { evidence } = journey(); const changed = applyInquiry(evidence.workspace, fixture('correction'));
    const request = { kind: 'update', operationId: 'resubmit', expectedRevision: 3, caseUpdates: { watchlists: [], familyLinks: [], updates: [] }, subquestions: [], hypotheses: [], findings: fixture('evidence').findings };
    expect(applyInquiry(changed.workspace, request).findings[0].reviewStatus).toBe('needs_review');
  });
  it('accepts only precise bounded timed evidence and rejects reference-only citations', () => {
    const { start } = journey(); const request = fixture('evidence'), c = request.caseUpdates.updates[0].caseRecord;
    const provenance = c.evidence[0].provenance;
    c.assets = [{ id: 'video', kind: 'video', durationMs: 3000, location: { kind: 'not_retained' }, provenance }];
    c.evidence[0].content = { kind: 'media', assetId: 'video', span: { kind: 'time', startMs: 1000, durationMs: 500 } };
    request.findings[0].support[0].anchor = { kind: 'time', startMs: 1100, durationMs: 100 };
    expect(applyInquiry(start.workspace, request).findings[0].reviewStatus).toBe('current');
    request.findings[0].support[0].anchor.durationMs = 600;
    expect(() => applyInquiry(start.workspace, request)).toThrow('lacks exact evidence');
    request.findings[0].support[0].evidenceId = 'context';
    expect(() => applyInquiry(start.workspace, request)).toThrow('lacks exact evidence');
  });
});
