import { parseCaseRecord } from '../cases/parse';
import type { NonEmpty } from '../cases/model';
import { COLLECTION_VERSION, type CaseCollection, type ClaimRef, type EvidenceRef, type FamilyLink, type SavedFamilyLink, type UpdateRequest, type Watchlist } from './model';

export function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Expected object');
  return v as Record<string, unknown>;
}
function text(v: unknown): string {
  if (typeof v !== 'string' || !v.trim() || v.length > 4000) throw new Error('Expected nonempty text, at most 4000 characters');
  return v;
}
function id(v: unknown): string {
  const result = text(v);
  if (result.length > 256) throw new Error('ID exceeds 256 characters');
  return result;
}
export function list<T>(v: unknown, parse: (v: unknown) => T): T[] {
  if (!Array.isArray(v) || v.length > 1000) throw new Error('Expected array of at most 1000 items');
  return v.map(parse);
}
function nonempty<T>(v: unknown, parse: (v: unknown) => T): NonEmpty<T> {
  const [first, ...rest] = list(v, parse);
  if (first === undefined) throw new Error('Expected at least one item');
  return [first, ...rest];
}
function choice<const T extends string>(v: unknown, choices: readonly T[]): T {
  for (const c of choices) if (v === c) return c;
  throw new Error('Unsupported value');
}
export function unique<T>(items: T[], key: (v: T) => string): T[] {
  if (new Set(items.map(key)).size !== items.length) throw new Error('Duplicate identifier');
  return items;
}
function claimRef(v: unknown): ClaimRef {
  const o = object(v); return { caseId: id(o.caseId), claimId: id(o.claimId) };
}
function evidenceRef(v: unknown): EvidenceRef {
  const o = object(v); return { caseId: id(o.caseId), evidenceId: id(o.evidenceId) };
}
function watchlist(v: unknown): Watchlist {
  const o = object(v), s = object(o.scope);
  return {
    id: id(o.id), scope: { kind: choice(s.kind, ['public_topic', 'public_organization', 'product', 'incident', 'research_question']), label: text(s.label), description: text(s.description) },
    phrases: nonempty(o.phrases, text), sourceHosts: nonempty(o.sourceHosts, value => {
      const host = text(value).toLowerCase();
      if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) throw new Error('Expected exact public source hostname');
      return host;
    }),
  };
}
function familyLink(v: unknown): FamilyLink {
  const o = object(v), a = object(o.assessment);
  const status = choice(a.status, ['reviewed', 'inferred']);
  const rationale = text(a.rationale);
  return {
    id: id(o.id), familyId: id(o.familyId), from: claimRef(o.from), to: claimRef(o.to),
    relationship: choice(o.relationship, ['paraphrase', 'translation', 'contradiction']),
    assessment: status === 'reviewed' ? { status, rationale, reviewer: text(a.reviewer) } : { status, rationale, method: text(a.method) },
    support: nonempty(o.support, evidenceRef),
  };
}
function digest(v: unknown): string {
  const s = text(v); if (!/^sha256:[a-f0-9]{64}$/.test(s)) throw new Error('Invalid content binding'); return s;
}
function savedLink(v: unknown): SavedFamilyLink {
  const o = object(v), b = object(o.bindings), link = familyLink(o.link);
  const support = list(b.support, digest);
  if (support.length !== link.support.length) throw new Error('Support bindings do not match references');
  return { link, bindings: { from: digest(b.from), to: digest(b.to), support } };
}
export function parseCollection(v: unknown): CaseCollection {
  const o = object(v);
  return {
    schemaVersion: choice(o.schemaVersion, [COLLECTION_VERSION]),
    cases: unique(list(o.cases, parseCaseRecord), c => c.id),
    caseHistory: unique(list(o.caseHistory, parseCaseRecord), c => JSON.stringify([c.id, c.revision])),
    watchlists: unique(list(o.watchlists, watchlist), w => w.id),
    familyLinks: unique(list(o.familyLinks, savedLink), l => l.link.id),
    relationReviewRequired: unique(list(o.relationReviewRequired, value => {
      const r = object(value); return { caseId: id(r.caseId), relationId: id(r.relationId), reason: text(r.reason) };
    }), r => JSON.stringify([r.caseId, r.relationId])),
  };
}
export function parseRequest(v: unknown): UpdateRequest {
  const o = object(v);
  return {
    watchlists: unique(list(o.watchlists, watchlist), w => w.id),
    familyLinks: unique(list(o.familyLinks, familyLink), l => l.id),
    updates: list(o.updates, value => {
      const u = object(value), kind = choice(u.kind, ['snapshot', 'retrieval_failed']);
      if (kind === 'retrieval_failed') return { kind, caseId: id(u.caseId), reason: text(u.reason) };
      const r = object(u.removal), status = choice(r.status, ['confirmed', 'not_confirmed']);
      return { kind, caseRecord: parseCaseRecord(u.caseRecord), removal: status === 'confirmed' ? { status, reason: text(r.reason) } : { status } };
    }),
  };
}
