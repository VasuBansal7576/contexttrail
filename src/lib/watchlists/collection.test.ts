import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { applyUpdates, emptyCollection, familyViews } from './collection';
import { parseRequest } from './parse';

function fixture(name: string) { return parseRequest(JSON.parse(readFileSync(`scripts/fixtures/watchlists/${name}.json`, 'utf8'))); }
function initial() { return applyUpdates(emptyCollection(), fixture('initial')); }
function correction() { return fixture('correction'); }
function snapshot() {
  const request = correction(), update = request.updates[0];
  if (update.kind !== 'snapshot') throw new Error('Fixture must contain snapshot');
  return { request, update, c: update.caseRecord };
}
describe('local watchlists and claim families', () => {
  it('imports saved cases and exposes exact correction with both source quotes and changed assessment', () => {
    const first = initial(), result = applyUpdates(first.collection, correction());
    expect(first.notices).toHaveLength(1);
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0].changes.map(c => c.kind)).toEqual(['changed']);
    expect(result.notices[0].evidence[0].before?.content).toMatchObject({ text: expect.stringContaining('reopened') });
    expect(result.notices[0].evidence[0].after?.content).toMatchObject({ text: expect.stringContaining('Correction:') });
    expect(result.notices[0].relationChanges[0].after).toMatchObject({ relationship: 'challenges', assessment: { status: 'inferred' } });
    expect(result.notices[0].affectedRelationIds).toEqual(['supports-open']);
    expect(result.collection.caseHistory).toEqual(first.collection.cases);
    expect(result.families[0].reviewStatus).toBe('needs_review');
    expect(result.families[0].from?.text).not.toEqual(result.families[0].to?.text);
  });
  it('is deterministic and idempotent across serialized restarts and duplicate batch updates', () => {
    const first = initial();
    expect(applyUpdates(JSON.parse(JSON.stringify(first.collection)), fixture('initial')).notices).toEqual([]);
    const req = correction(); req.updates.push(req.updates[0]);
    const result = applyUpdates(first.collection, req);
    expect(result.notices).toEqual(applyUpdates(first.collection, correction()).notices);
    expect(applyUpdates(result.collection, correction()).notices).toEqual([]);
  });
  it('ignores retrieval timestamp and revision-only changes but detects publication changes', () => {
    const first = initial(), c = structuredClone(first.collection.cases[0]); c.revision++;
    c.evidence[0].provenance.retrievedAt = '2026-10-02T00:00:00Z';
    const req = { watchlists: [], familyLinks: [], updates: [{ kind: 'snapshot', caseRecord: c, removal: { status: 'not_confirmed' } }] };
    expect(applyUpdates(first.collection, req).notices).toEqual([]);
    c.evidence[0].publicationDate = { status: 'observed', observation: { value: '2026-09-30', precision: 'day', source: { kind: 'user_statement', url: null, recordedValue: '2026-09-30' } } };
    expect(applyUpdates(first.collection, req).notices[0].changes[0].kind).toBe('changed');
  });
  it('does not report failed retrieval or an incomplete snapshot as deletion', () => {
    const first = initial();
    const failed = applyUpdates(first.collection, { watchlists: [], familyLinks: [], updates: [{ kind: 'retrieval_failed', caseId: 'harbor-bridge', reason: 'Timeout' }] });
    expect(failed.collection).toEqual(first.collection); expect(failed.notices).toEqual([]); expect(failed.failures).toHaveLength(1);
    const { request, c, update } = snapshot(); c.evidence.pop();
    expect(() => applyUpdates(first.collection, request)).toThrow('confirmed removal');
    update.removal = { status: 'confirmed', reason: 'Operator confirmed removal from this saved case; no claim of website deletion.' };
    const result = applyUpdates(first.collection, request);
    expect(result.notices[0].changes.map(c => c.kind)).toEqual(['removed', 'changed']);
  });
  it('requires a stable case identity, rejects conflicting/stale versions and duplicate evidence', () => {
    const first = initial(), { request, c } = snapshot(); c.revision = 1;
    expect(() => applyUpdates(first.collection, request)).toThrow('Conflicting');
    expect(() => applyUpdates(applyUpdates(first.collection, correction()).collection, fixture('initial'))).toThrow('Stale');
    c.revision = 2; c.createdAt = '2026-10-02T00:00:00Z';
    expect(() => applyUpdates(first.collection, request)).toThrow('creation timestamp');
    c.createdAt = first.collection.cases[0].createdAt; c.evidence.push(c.evidence[0]);
    expect(() => applyUpdates(first.collection, request)).toThrow('duplicate id');
  });
  it('uses literal phrase boundaries and exact approved source hosts, never substring/domain similarity', () => {
    const req = fixture('initial'); req.watchlists[0].phrases = ['Harbor']; req.watchlists[0].sourceHosts = ['wrong.example.org'];
    expect(applyUpdates(emptyCollection(), req).notices).toEqual([]);
    req.watchlists[0].sourceHosts = ['example.org']; req.watchlists[0].phrases = ['Har'];
    expect(applyUpdates(emptyCollection(), req).notices).toEqual([]);
    req.watchlists[0].phrases = ['harbor bridge']; expect(applyUpdates(emptyCollection(), req).notices).toHaveLength(1);
  });
  it('preserves uncertain paraphrases and does not infer any family from similar wording', () => {
    const req = fixture('initial'); req.familyLinks = [];
    expect(applyUpdates(emptyCollection(), req).families).toEqual([]);
    req.familyLinks = fixture('initial').familyLinks; req.familyLinks[0].relationship = 'paraphrase';
    const result = applyUpdates(emptyCollection(), req);
    expect(result.families[0].link.assessment.status).toBe('inferred');
    expect(result.families[0].reviewStatus).toBe('current');
    expect(result.families[0].limitation).toContain('neither truth, copying, coordination, nor origin');
  });
  it('requires supporting evidence and preserves stale warning when the same old link is replayed', () => {
    const first = initial(), next = applyUpdates(first.collection, correction());
    expect(applyUpdates(next.collection, { watchlists: [], updates: [], familyLinks: fixture('initial').familyLinks }).families[0].reviewStatus).toBe('needs_review');
    const req = fixture('initial'); req.familyLinks[0].support[0].evidenceId = 'missing';
    expect(() => applyUpdates(emptyCollection(), req)).toThrow('missing supporting evidence');
    const bad = { ...fixture('initial').familyLinks[0], support: [] };
    expect(() => applyUpdates(emptyCollection(), { ...fixture('initial'), familyLinks: [bad] })).toThrow('at least one');
  });
  it('marks links for review after claim wording changes even when source evidence does not change', () => {
    const first = initial(), c = structuredClone(first.collection.cases[0]); c.revision++; c.claims[0].text += ' At noon.';
    const result = applyUpdates(first.collection, { watchlists: [], familyLinks: [], updates: [{ kind: 'snapshot', caseRecord: c, removal: { status: 'not_confirmed' } }] });
    expect(familyViews(result.collection)[0].reviewStatus).toBe('needs_review');
  });
  it('retains stale relation warnings across restart and replay until an assessment is revised', () => {
    const first = initial(), { request, c } = snapshot();
    c.relations = structuredClone(first.collection.cases[0].relations);
    const result = applyUpdates(first.collection, request);
    expect(result.collection.relationReviewRequired).toHaveLength(1);
    const replay = applyUpdates(JSON.parse(JSON.stringify(result.collection)), request);
    expect(replay.notices).toEqual([]); expect(replay.collection.relationReviewRequired).toHaveLength(1);
    c.revision++; c.relations[0].assessment = { status: 'unknown', reason: 'Source corrected; interpretation requires fresh review.' };
    expect(applyUpdates(replay.collection, request).collection.relationReviewRequired).toEqual([]);
  });
  it('reports newly supplied contradiction relations without requiring a source-text edit', () => {
    const first = initial(), c = structuredClone(first.collection.cases[0]); c.revision++; c.relations[0] = { ...c.relations[0], assessment: { status: 'unknown', reason: 'Entailment challenged on manual review.' } };
    const result = applyUpdates(first.collection, { watchlists: [], familyLinks: [], updates: [{ kind: 'snapshot', caseRecord: c, removal: { status: 'not_confirmed' } }] });
    expect(result.notices[0].changes).toEqual([]); expect(result.notices[0].relationChanges).toHaveLength(1);
  });
});
