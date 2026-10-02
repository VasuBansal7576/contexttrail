import { createHash } from 'node:crypto';
import type { CaseEvidence, CaseRecord } from '../cases/model';
import { COLLECTION_VERSION, type CaseCollection, type ChangeNotice, type ClaimRef, type EvidenceChange, type EvidenceRef, type FamilyLink, type SavedFamilyLink, type Watchlist } from './model';
import { parseCollection, parseRequest } from './parse';

/** Sort keys for stable equality; array order remains meaningful unless explicitly sorted. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') return `{${Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, value]) => `${JSON.stringify(k)}:${canonical(value)}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}
function hash(v: unknown): string { return `sha256:${createHash('sha256').update(canonical(v)).digest('hex')}`; }
export function emptyCollection(): CaseCollection { return { schemaVersion: COLLECTION_VERSION, cases: [], caseHistory: [], watchlists: [], familyLinks: [], relationReviewRequired: [] }; }

/** Retrieval bookkeeping is not a source correction. Reported publication dates are material. */
function evidenceValue(record: CaseRecord, e: CaseEvidence): unknown {
  const { retrievedAt: _retrieved, capturedAt: _captured, toolVersion: _tool, ...provenance } = e.provenance;
  const asset = e.content.kind === 'media' ? record.assets.find(a => e.content.kind === 'media' && a.id === e.content.assetId) : undefined;
  return { ...e, provenance, asset: asset ? { id: asset.id, kind: asset.kind, location: asset.location, durationMs: 'durationMs' in asset ? asset.durationMs : null, contentHash: asset.provenance.contentHash } : null };
}
export function evidenceDigest(record: CaseRecord, evidence: CaseEvidence): string { return hash(evidenceValue(record, evidence)); }
function normalized(value: string): string { return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
export function matchesWatchlist(w: Watchlist, e: CaseEvidence): boolean {
  if (e.provenance.rights !== 'public_reference' || !w.sourceHosts.includes(new URL(e.sourceUrl).hostname.toLowerCase())) return false;
  const haystack = ` ${normalized(`${e.title ?? ''} ${e.content.kind === 'text' ? e.content.text : ''}`)} `;
  return w.phrases.some(phrase => { const needle = normalized(phrase); return needle.length > 0 && haystack.includes(` ${needle} `); });
}
function claimBinding(cases: CaseRecord[], ref: ClaimRef): string | null {
  const claim = cases.find(c => c.id === ref.caseId)?.claims.find(c => c.id === ref.claimId);
  return claim ? hash({ text: claim.text, language: claim.language }) : null;
}
function supportBinding(cases: CaseRecord[], ref: EvidenceRef): string | null {
  const c = cases.find(c => c.id === ref.caseId), e = c?.evidence.find(e => e.id === ref.evidenceId);
  return c && e ? evidenceDigest(c, e) : null;
}
function bindLink(cases: CaseRecord[], link: FamilyLink): SavedFamilyLink {
  if (canonical(link.from) === canonical(link.to)) throw new Error('A family link must connect different claims');
  const from = claimBinding(cases, link.from), to = claimBinding(cases, link.to);
  if (from === null || to === null) throw new Error('Family link refers to a missing claim');
  const support = link.support.map(ref => {
    const binding = supportBinding(cases, ref);
    if (binding === null) throw new Error('Family link refers to missing supporting evidence');
    return binding;
  });
  return { link, bindings: { from, to, support } };
}
export function familyViews(collection: CaseCollection) {
  return collection.familyLinks.map(({ link, bindings }) => {
    const from = collection.cases.find(c => c.id === link.from.caseId)?.claims.find(c => c.id === link.from.claimId) ?? null;
    const to = collection.cases.find(c => c.id === link.to.caseId)?.claims.find(c => c.id === link.to.claimId) ?? null;
    const changed = claimBinding(collection.cases, link.from) !== bindings.from || claimBinding(collection.cases, link.to) !== bindings.to || link.support.some((ref, i) => supportBinding(collection.cases, ref) !== bindings.support[i]);
    return { link, from, to, reviewStatus: changed ? 'needs_review' : 'current', support: link.support.map(ref => ({ ...ref, evidence: collection.cases.find(c => c.id === ref.caseId)?.evidence.find(e => e.id === ref.evidenceId) ?? null })), limitation: 'This link is an operator assessment. It establishes neither truth, copying, coordination, nor origin. Contradictions remain distinct assertions.' };
  });
}
function upsert<T>(items: T[], value: T, key: (v: T) => string): T[] {
  return [...items.filter(item => key(item) !== key(value)), value].sort((a, b) => key(a).localeCompare(key(b)));
}
export function applyUpdates(collectionInput: unknown, requestInput: unknown) {
  const collection = parseCollection(collectionInput), request = parseRequest(requestInput);
  for (const w of request.watchlists) collection.watchlists = upsert(collection.watchlists, w, w => w.id);
  const notices: ChangeNotice[] = [], failures: Array<{ caseId: string; reason: string }> = [];
  for (const update of request.updates) {
    if (update.kind === 'retrieval_failed') { failures.push({ caseId: update.caseId, reason: update.reason }); continue; }
    const next = update.caseRecord, previous = collection.cases.find(c => c.id === next.id);
    if (previous && next.revision < previous.revision) throw new Error(`Stale case revision: ${next.id}`);
    if (previous && next.revision === previous.revision) {
      if (canonical(previous) !== canonical(next)) throw new Error(`Conflicting case revision: ${next.id}`);
      continue;
    }
    if (previous && previous.createdAt !== next.createdAt) throw new Error('Case creation timestamp cannot change');
    const old = new Map(previous?.evidence.map(e => [e.id, e]) ?? []), fresh = new Map(next.evidence.map(e => [e.id, e]));
    const changes: EvidenceChange[] = [];
    for (const e of next.evidence) {
      const before = old.get(e.id), after = evidenceDigest(next, e);
      if (!before || !previous) changes.push({ kind: 'added', evidenceId: e.id, after });
      else if (evidenceDigest(previous, before) !== after) changes.push({ kind: 'changed', evidenceId: e.id, before: evidenceDigest(previous, before), after });
    }
    for (const e of previous?.evidence ?? []) if (!fresh.has(e.id)) {
      if (update.removal.status !== 'confirmed') throw new Error('Missing evidence requires explicit confirmed removal; failed retrieval is not deletion');
      if (previous) changes.push({ kind: 'removed', evidenceId: e.id, before: evidenceDigest(previous, e), reason: update.removal.reason });
    }
    changes.sort((a, b) => a.evidenceId.localeCompare(b.evidenceId));
    const oldRelations = new Map(previous?.relations.map(r => [r.id, r]) ?? []);
    const newRelations = new Map(next.relations.map(r => [r.id, r]));
    const relationChanges = [...new Set([...oldRelations.keys(), ...newRelations.keys()])].sort().flatMap(relationId => {
      const before = oldRelations.get(relationId) ?? null, after = newRelations.get(relationId) ?? null;
      return canonical(before) === canonical(after) ? [] : [{ relationId, before, after }];
    });
    // Persist stale-support warnings beyond the latest report and no-op replays.
    collection.relationReviewRequired = collection.relationReviewRequired.filter(review => review.caseId !== next.id || (newRelations.has(review.relationId) && !relationChanges.some(change => change.relationId === review.relationId)));
    const changedEvidenceIds = new Set(changes.map(change => change.evidenceId));
    const changedClaims = new Set(next.claims.filter(claim => {
      const oldClaim = previous?.claims.find(c => c.id === claim.id);
      return oldClaim && (oldClaim.text !== claim.text || oldClaim.language !== claim.language);
    }).map(claim => claim.id));
    for (const relation of next.relations) {
      if (!oldRelations.has(relation.id) || relationChanges.some(change => change.relationId === relation.id)) continue;
      const supportChanged = relation.assessment.status !== 'unknown' && relation.assessment.evidenceIds.some(id => changedEvidenceIds.has(id));
      const targetChanged = relation.kind === 'evidence_claim' ? changedEvidenceIds.has(relation.evidenceId) || changedClaims.has(relation.claimId) : relation.kind === 'claim_claim' ? changedClaims.has(relation.fromClaimId) || changedClaims.has(relation.toClaimId) : false;
      if (supportChanged || targetChanged) collection.relationReviewRequired = upsert(collection.relationReviewRequired, { caseId: next.id, relationId: relation.id, reason: 'Referenced evidence or claim content changed without a revised relation assessment.' }, r => JSON.stringify([r.caseId, r.relationId]));
    }
    for (const w of collection.watchlists) {
      const relevant = changes.filter(change => {
        const before = old.get(change.evidenceId), after = fresh.get(change.evidenceId);
        return (before && matchesWatchlist(w, before)) || (after && matchesWatchlist(w, after));
      });
      const relevantRelations = relationChanges.filter(change => [change.before, change.after].some(r => {
        if (!r) return false;
        const ids = [...(r.kind === 'evidence_claim' ? [r.evidenceId] : []), ...(r.assessment.status !== 'unknown' ? r.assessment.evidenceIds : [])];
        return ids.some(id => { const a = old.get(id), b = fresh.get(id); return (a && matchesWatchlist(w, a)) || (b && matchesWatchlist(w, b)); });
      }));
      if (!relevant.length && !relevantRelations.length) continue;
      const ids = new Set(relevant.map(c => c.evidenceId));
      const affectedRelationIds = [...new Set([...(previous?.relations ?? []), ...next.relations].filter(r => (r.kind === 'evidence_claim' && ids.has(r.evidenceId)) || (r.assessment.status !== 'unknown' && r.assessment.evidenceIds.some(id => ids.has(id)))).map(r => r.id))].sort();
      notices.push({ id: hash({ watchlist: w.id, caseId: next.id, revision: next.revision, changes: relevant, relationChanges: relevantRelations }), watchlistId: w.id, caseId: next.id, revision: next.revision, changes: relevant, affectedRelationIds, evidence: relevant.map(c => ({ evidenceId: c.evidenceId, before: old.get(c.evidenceId) ?? null, after: fresh.get(c.evidenceId) ?? null })), relationChanges: relevantRelations, limitation: 'Manual supplied snapshot only. Text matching does not establish a contradiction or a final judgment. Affected relations need review.' });
    }
    if (previous) collection.caseHistory.push(previous);
    collection.cases = upsert(collection.cases, next, c => c.id);
  }
  for (const link of request.familyLinks) {
    const existing = collection.familyLinks.find(l => l.link.id === link.id);
    // Replaying an old link must never clear a stale-support warning.
    if (existing && canonical(existing.link) === canonical(link)) continue;
    collection.familyLinks = upsert(collection.familyLinks, bindLink(collection.cases, link), l => l.link.id);
  }
  parseCollection(collection); // Validate collection bounds before callers persist it.
  return { collection, notices, failures, families: familyViews(collection) };
}
