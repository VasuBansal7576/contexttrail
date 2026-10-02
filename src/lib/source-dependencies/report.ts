/** Local, deterministic inspection. No retrieval, semantic classifier, or truth verdict. */
import { createHash } from 'node:crypto';
import type { CaseEvidence } from '../cases/model';
import { parseCaseRecord } from '../cases/parse';
import { list, object, unique } from '../watchlists/parse';

export interface SuppliedCitation {
  id: string;
  fromEvidenceId: string;
  targetUrl: string;
  /** Caller designation, never verified as the original/primary publication. */
  targetRole: 'primary' | 'unspecified';
  claimId: string | null;
  quote: { text: string; start: number | null } | null;
}
export type Basis =
  | { status: 'observed'; method: string }
  | { status: 'inferred'; method: string; rationale: string }
  | { status: 'unknown'; reason: string };
const unknown = (reason: string): Basis => ({ status: 'unknown', reason });
const observed = (method: string): Basis => ({ status: 'observed', method });
const digest = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const stableId = (kind: string, value: unknown) => `${kind}:${digest(value).slice(7)}`;
const sorted = (values: string[]) => [...values].sort();
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function text(v: unknown, limit = 20_000): string {
  if (typeof v !== 'string' || !v.trim() || v.length > limit) throw new Error('Expected bounded nonempty text');
  return v;
}
function url(v: unknown): string {
  const raw = text(v, 4096), parsed = new URL(raw);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Expected HTTP(S) URL without credentials');
  return raw;
}
/** Only URL parser normalization and fragment removal. Query, scheme and path remain significant. */
function sourceKey(raw: string): string { const parsed = new URL(raw); parsed.hash = ''; return parsed.href; }
function parseCitation(v: unknown): SuppliedCitation {
  const o = object(v);
  if (o.targetRole !== 'primary' && o.targetRole !== 'unspecified') throw new Error('Expected supplied target role');
  let quote: SuppliedCitation['quote'] = null;
  if (o.quote !== null) {
    const q = object(o.quote);
    if (q.start !== null && (typeof q.start !== 'number' || !Number.isSafeInteger(q.start) || q.start < 0)) throw new Error('Expected nonnegative UTF-16 quote offset or null');
    quote = { text: text(q.text), start: q.start };
  }
  return { id: text(o.id, 256), fromEvidenceId: text(o.fromEvidenceId, 256), targetUrl: url(o.targetUrl), targetRole: o.targetRole, claimId: o.claimId === null ? null : text(o.claimId, 256), quote };
}

function quoteCheck(evidence: CaseEvidence, quote: SuppliedCitation['quote']) {
  const common = { evidenceId: evidence.id, evidenceBinding: digest(evidence) };
  if (!quote) return { ...common, result: 'unknown', basis: unknown('No attributed quote supplied'), matchedStart: null };
  if (evidence.content.kind !== 'text') return { ...common, result: 'unknown', basis: unknown('No retained text passage'), matchedStart: null };
  const start = quote.start ?? evidence.content.text.indexOf(quote.text);
  const matched = start >= 0 && evidence.content.text.slice(start, start + quote.text.length) === quote.text;
  return {
    ...common, result: matched ? 'exact_match' : quote.start === null ? 'not_found_in_retained_passage' : 'offset_mismatch',
    basis: observed(quote.start === null ? 'Exact case-sensitive substring in retained text' : 'Exact case-sensitive text at supplied UTF-16 offset'),
    matchedStart: matched ? start : null,
    attribution: evidence.content.attribution,
  };
}

/** Unknown input is validated and detached; CaseRecord v1 and inquiry envelopes are unchanged. */
export function sourceDependencyReport(input: unknown) {
  const o = object(input), record = parseCaseRecord(o.caseRecord);
  const citations = unique(list(o.citations, parseCitation), item => item.id).sort((a, b) => compare(a.id, b.id));
  for (const citation of citations) {
    if (!record.evidence.some(e => e.id === citation.fromEvidenceId)) throw new Error(`Unknown citing evidence: ${citation.fromEvidenceId}`);
    if (citation.claimId !== null && !record.claims.some(c => c.id === citation.claimId)) throw new Error(`Unknown claim: ${citation.claimId}`);
  }
  const evidence = [...record.evidence].sort((a, b) => compare(a.id, b.id));
  const sources = new Map<string, CaseEvidence[]>();
  const passages = new Map<string, CaseEvidence[]>();
  for (const item of evidence) {
    const key = sourceKey(item.sourceUrl); sources.set(key, [...(sources.get(key) ?? []), item]);
    if (item.content.kind === 'text') {
      // Entire retained passages, with no whitespace, punctuation or language normalization.
      const passage = item.content.text; passages.set(passage, [...(passages.get(passage) ?? []), item]);
    }
  }
  const targetCheckCount = citations.reduce((count, citation) => count + (sources.get(sourceKey(citation.targetUrl))?.length ?? 0), 0);
  if (targetCheckCount > 10_000) throw new Error('Report exceeds 10000 citation-target checks; split the supplied inspection scope');
  const citationChecks = citations.map(citation => {
    const key = sourceKey(citation.targetUrl), targets = sources.get(key) ?? [];
    return {
      id: stableId('citation', [record.id, citation.id]), citation,
      citationExistence: observed('Citation supplied by caller; not independently verified in the source document'),
      documentCitationExistence: unknown('No source-document link extraction or retrieval performed'),
      sourceIdentity: targets.length ? observed('Conservative normalized URL equality; document authorship and primary status unverified') : unknown('No retained evidence with this normalized target URL'),
      targetSourceId: stableId('source', key), targetEvidenceIds: targets.map(e => e.id),
      claim: record.claims.find(c => c.id === citation.claimId) ?? null,
      quoteChecks: targets.map(e => quoteCheck(e, citation.quote)),
      quoteCoverage: targets.length ? observed('Checks limited to matched retained evidence items') : unknown('Citation target text unavailable'),
      entailment: unknown('Text occurrence and citation existence do not establish claim entailment or truth; requires contextual review'),
    };
  });
  const byTarget = new Map<string, SuppliedCitation[]>();
  for (const citation of citations) {
    const key = sourceKey(citation.targetUrl); byTarget.set(key, [...(byTarget.get(key) ?? []), citation]);
  }
  const sharedCitations = [...byTarget].sort(([a], [b]) => compare(a, b)).flatMap(([key, links]) => {
    const evidenceIds = sorted([...new Set(links.map(c => c.fromEvidenceId))]);
    if (evidenceIds.length < 2) return [];
    return [{
      id: stableId('shared-citation', [record.id, key, evidenceIds]), targetSourceId: stableId('source', key), targetUrl: key,
      evidenceIds, citationIds: sorted(links.map(c => c.id)),
      observation: observed('Distinct evidence items have supplied citations to the same normalized URL'),
      dependency: { status: 'inferred', method: 'Shared supplied citation target', rationale: 'The items may rely on a common source. Citation alone does not establish dependence for any particular assertion.' } satisfies Basis,
      primaryStatus: unknown('Primary designations are caller supplied; original publication and independence are unverified'),
    }];
  });
  const duplicatePassages = [...passages].filter(([, items]) => items.length > 1).map(([passage, items]) => ({
    id: stableId('duplicate-passage', [record.id, digest(passage), items.map(e => e.id)]),
    evidenceIds: items.map(e => e.id), passage, observation: observed('Entire retained text passages are byte-for-byte equivalent UTF-8 strings'),
    copying: unknown('Identical wording does not establish copying, direction, syndication rights, or independence'),
  })).sort((a, b) => compare(a.id, b.id));
  return {
    schemaVersion: 'contexttrail-source-dependencies-v1', caseId: record.id, caseRevision: record.revision,
    retainedEvidence: evidence,
    evidenceBindings: evidence.map(e => ({ evidenceId: e.id, binding: digest(e) })),
    sources: [...sources].sort(([a], [b]) => compare(a, b)).map(([key, items]) => ({ id: stableId('source', key), url: key, evidenceIds: items.map(e => e.id), identity: observed('Same conservative URL key; not proof of same author, work, or edition') })),
    citationChecks, sharedCitations, duplicatePassages,
    independence: unknown('No independent-source count can be established from domains, citation links, or passage equality'),
    limits: [
      'Only supplied citations and retained case evidence are inspected; no network or model calls.',
      'Distinct URLs may identify the same work; identical URLs may change over time. Redirects and canonical aliases are not resolved.',
      'Same-domain documents may be independent; different-domain documents may share sources.',
      'Paraphrase, translation, partial overlap, contradiction and actual claim entailment are not inferred.',
      'A missing quote applies only to the retained passage or supplied offset, never to the full source or claim truth.',
      'Search snippets and classification context remain labeled; an exact match does not upgrade them to primary-source text.',
      'Reports are snapshot-bound. Recompute after corrections and review old results against evidence bindings.',
    ],
  };
}
export type SourceDependencyReport = ReturnType<typeof sourceDependencyReport>;
