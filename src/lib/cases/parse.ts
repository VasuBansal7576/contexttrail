import {
  CASE_SCHEMA_VERSION, type Assessment, type AssetLocation, type CaseEvidence,
  type CaseRecord, type CaseRelation, type DateObservation, type MediaAsset,
  type MediaOccurrence, type MediaSpan, type NonEmpty, type Provenance,
  type SourcedDate, type TextClaim,
} from './model';
import { safeReferenceParameters } from '../pages/source-reference-policy';
import { parseTopicCandidateAudit } from './topic-candidate-audit';

export class CaseValidationError extends Error {
  constructor(readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'CaseValidationError';
  }
}
const fail = (path: string, message: string): never => { throw new CaseValidationError(path, message); };
function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail(path, 'expected object');
  return value as Record<string, unknown>;
}
function text(value: unknown, path: string, max = 20_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) return fail(path, 'expected bounded non-empty text');
  return value;
}
const id = (value: unknown, path: string) => text(value, path, 256);
function nullableText(value: unknown, path: string): string | null {
  return value === null ? null : text(value, path);
}
function choice<const T extends string>(value: unknown, values: readonly T[], path: string): T {
  for (const item of values) if (value === item) return item;
  return fail(path, 'unsupported value');
}
function integer(value: unknown, path: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) return fail(path, 'expected safe integer');
  return value;
}
function list<T>(value: unknown, path: string, parse: (item: unknown, path: string) => T): T[] {
  if (!Array.isArray(value) || value.length > 1000) return fail(path, 'expected array of at most 1000 items');
  return value.map((item, index) => parse(item, `${path}[${index}]`));
}
function nonEmptyIds(value: unknown, path: string): NonEmpty<string> {
  const values = list(value, path, id);
  const [first, ...rest] = values;
  return first === undefined ? fail(path, 'requires supporting evidence') : [first, ...rest];
}
function url(value: unknown, path: string): string {
  const raw = text(value, path, 4096);
  try {
    const parsed = new URL(raw);
    if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) return raw;
  } catch { /* Rejected below. This parser never fetches the reference. */ }
  return fail(path, 'expected HTTP(S) URL without credentials');
}
function timestamp(value: unknown, path: string): string {
  const raw = text(value, path, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(raw) || !Number.isFinite(Date.parse(raw))) {
    return fail(path, 'expected UTC ISO timestamp');
  }
  if (new Date(raw).toISOString().slice(0, 19) !== raw.slice(0, 19)) return fail(path, 'invalid calendar date');
  return raw;
}
function auditUrl(value: unknown, path: string): string {
  const reference = url(value, path);
  if (!safeReferenceParameters(new URL(reference))) return fail(path, 'credential-bearing source audit URL');
  return reference;
}
function observation(value: unknown, path: string): DateObservation {
  const v = object(value, path);
  const precision = choice(v.precision, ['instant', 'day', 'month', 'year'], `${path}.precision`);
  const date = text(v.value, `${path}.value`, 64);
  const pattern = { instant: /^.+$/, day: /^\d{4}-\d{2}-\d{2}$/, month: /^\d{4}-\d{2}$/, year: /^\d{4}$/ }[precision];
  if (!pattern.test(date)) return fail(`${path}.value`, 'date precision does not match value');
  timestamp(precision === 'instant' ? date : `${date}${precision === 'year' ? '-01-01' : precision === 'month' ? '-01' : ''}T00:00:00Z`, `${path}.value`);
  const source = object(v.source, `${path}.source`);
  const kind = choice(source.kind, ['page_json_ld', 'page_meta', 'page_time', 'search_metadata', 'retrieval_log', 'user_statement'], `${path}.source.kind`);
  const sourceUrl = source.url === null ? null : url(source.url, `${path}.source.url`);
  if (kind !== 'user_statement' && sourceUrl === null) return fail(`${path}.source.url`, 'source-backed date requires a URL');
  return { value: date, precision, source: { kind, url: sourceUrl, recordedValue: text(source.recordedValue, `${path}.source.recordedValue`) } };
}
function date(value: unknown, path: string): SourcedDate {
  const v = object(value, path);
  const status = choice(v.status, ['observed', 'inferred', 'disputed', 'unknown'], `${path}.status`);
  switch (status) {
    case 'observed': return { status, observation: observation(v.observation, `${path}.observation`) };
    case 'inferred': return { status, observation: observation(v.observation, `${path}.observation`), rationale: text(v.rationale, `${path}.rationale`) };
    case 'disputed': return { status, observations: list(v.observations, `${path}.observations`, observation), reason: text(v.reason, `${path}.reason`) };
    case 'unknown': return { status, reason: text(v.reason, `${path}.reason`) };
  }
}
function assessment(value: unknown, path: string): Assessment {
  const v = object(value, path);
  const status = choice(v.status, ['observed', 'inferred', 'unknown'], `${path}.status`);
  if (status === 'unknown') return { status, reason: text(v.reason, `${path}.reason`) };
  const common = { evidenceIds: nonEmptyIds(v.evidenceIds, `${path}.evidenceIds`), method: text(v.method, `${path}.method`) };
  return status === 'observed' ? { status, ...common } : { status, ...common, rationale: text(v.rationale, `${path}.rationale`) };
}
function provenance(value: unknown, path: string): Provenance {
  const v = object(value, path);
  const contentHash = nullableText(v.contentHash, `${path}.contentHash`);
  if (contentHash !== null && !/^sha256:[a-f0-9]{64}$/.test(contentHash)) return fail(`${path}.contentHash`, 'expected sha256 digest');
  return {
    method: choice(v.method, ['user_submission', 'retrieval', 'page_extraction', 'model_assessment', 'manual'], `${path}.method`),
    toolVersion: nullableText(v.toolVersion, `${path}.toolVersion`),
    capturedAt: v.capturedAt === null ? null : timestamp(v.capturedAt, `${path}.capturedAt`),
    retrievedAt: v.retrievedAt === null ? null : timestamp(v.retrievedAt, `${path}.retrievedAt`),
    rights: choice(v.rights, ['unknown', 'user_provided', 'public_reference'], `${path}.rights`),
    retention: choice(v.retention, ['reference_only', 'not_retained'], `${path}.retention`), contentHash,
  };
}
function span(value: unknown, path: string): MediaSpan {
  const v = object(value, path);
  const kind = choice(v.kind, ['whole', 'time'], `${path}.kind`);
  if (kind === 'whole') return { kind };
  const startMs = integer(v.startMs, `${path}.startMs`);
  const durationMs = integer(v.durationMs, `${path}.durationMs`, 1);
  integer(startMs + durationMs, path);
  return { kind, startMs, durationMs };
}
function asset(value: unknown, path: string): MediaAsset {
  const v = object(value, path);
  const location = object(v.location, `${path}.location`);
  const locationKind = choice(location.kind, ['url', 'not_retained'], `${path}.location.kind`);
  const parsedLocation: AssetLocation = locationKind === 'url' ? { kind: locationKind, url: url(location.url, `${path}.location.url`) } : { kind: locationKind };
  const common = { id: id(v.id, `${path}.id`), location: parsedLocation, provenance: provenance(v.provenance, `${path}.provenance`) };
  const kind = choice(v.kind, ['image', 'video', 'audio'], `${path}.kind`);
  return kind === 'image' ? { ...common, kind } : { ...common, kind, durationMs: v.durationMs === null ? null : integer(v.durationMs, `${path}.durationMs`, 1) };
}
function claim(value: unknown, path: string): TextClaim {
  const v = object(value, path);
  return { id: id(v.id, `${path}.id`), kind: choice(v.kind, ['text'], `${path}.kind`), text: text(v.text, `${path}.text`), language: nullableText(v.language, `${path}.language`), provenance: provenance(v.provenance, `${path}.provenance`) };
}
function evidence(value: unknown, path: string): CaseEvidence {
  const v = object(value, path);
  const content = object(v.content, `${path}.content`);
  const kind = choice(content.kind, ['text', 'media', 'reference'], `${path}.content.kind`);
  let parsedContent: CaseEvidence['content'];
  switch (kind) {
    case 'reference': parsedContent = { kind }; break;
    case 'media': parsedContent = { kind, assetId: id(content.assetId, `${path}.content.assetId`), span: span(content.span, `${path}.content.span`) }; break;
    case 'text': parsedContent = { kind, text: text(content.text, `${path}.content.text`), attribution: choice(content.attribution, ['page_quote', 'search_snippet', 'classification_context'], `${path}.content.attribution`) }; break;
  }
  return { id: id(v.id, `${path}.id`), sourceUrl: url(v.sourceUrl, `${path}.sourceUrl`), title: nullableText(v.title, `${path}.title`), content: parsedContent, publicationDate: date(v.publicationDate, `${path}.publicationDate`), provenance: provenance(v.provenance, `${path}.provenance`) };
}
function occurrence(value: unknown, path: string): MediaOccurrence {
  const v = object(value, path);
  return { id: id(v.id, `${path}.id`), assetId: id(v.assetId, `${path}.assetId`), sourceEvidenceId: id(v.sourceEvidenceId, `${path}.sourceEvidenceId`), span: span(v.span, `${path}.span`), identity: assessment(v.identity, `${path}.identity`) };
}
function relation(value: unknown, path: string): CaseRelation {
  const v = object(value, path);
  const common = { id: id(v.id, `${path}.id`), assessment: assessment(v.assessment, `${path}.assessment`) };
  const kind = choice(v.kind, ['evidence_claim', 'claim_claim', 'occurrence_occurrence'], `${path}.kind`);
  switch (kind) {
    case 'evidence_claim': return { ...common, kind, evidenceId: id(v.evidenceId, `${path}.evidenceId`), claimId: id(v.claimId, `${path}.claimId`), relationship: choice(v.relationship, ['supports', 'challenges', 'context'], `${path}.relationship`) };
    case 'claim_claim': return { ...common, kind, fromClaimId: id(v.fromClaimId, `${path}.fromClaimId`), toClaimId: id(v.toClaimId, `${path}.toClaimId`), relationship: choice(v.relationship, ['paraphrase', 'translation', 'contradiction'], `${path}.relationship`) };
    case 'occurrence_occurrence': return { ...common, kind, fromOccurrenceId: id(v.fromOccurrenceId, `${path}.fromOccurrenceId`), toOccurrenceId: id(v.toOccurrenceId, `${path}.toOccurrenceId`), relationship: choice(v.relationship, ['repost', 'quotation', 'source_link', 'similar_media'], `${path}.relationship`) };
  }
}

/** Parse a case at import/restore boundaries; never coerce unsupported versions. */
export function parseCaseRecord(value: unknown): CaseRecord {
  const v = object(value, 'case');
  const coverage = object(v.coverage, 'case.coverage');
  const original = object(coverage.originalPublication, 'case.coverage.originalPublication');
  const result: CaseRecord = {
    schemaVersion: choice(v.schemaVersion, [CASE_SCHEMA_VERSION], 'case.schemaVersion'),
    id: id(v.id, 'case.id'), revision: integer(v.revision, 'case.revision', 1), createdAt: timestamp(v.createdAt, 'case.createdAt'),
    claims: list(v.claims, 'case.claims', claim), assets: list(v.assets, 'case.assets', asset),
    evidence: list(v.evidence, 'case.evidence', evidence), occurrences: list(v.occurrences, 'case.occurrences', occurrence), relations: list(v.relations, 'case.relations', relation),
    coverage: {
      scope: choice(coverage.scope, ['retrieved_evidence'], 'case.coverage.scope'),
      completeness: choice(coverage.completeness, ['partial', 'unknown'], 'case.coverage.completeness'),
      omittedEvidenceCount: integer(coverage.omittedEvidenceCount, 'case.coverage.omittedEvidenceCount'),
      originalPublication: { status: choice(original.status, ['unknown'], 'case.coverage.originalPublication.status'), reason: text(original.reason, 'case.coverage.originalPublication.reason') },
      limitations: list(coverage.limitations, 'case.coverage.limitations', text),
      searches: list(coverage.searches, 'case.coverage.searches', (item, path) => {
        const s = object(item, path);
        return { engine: text(s.engine, `${path}.engine`), attempted: integer(s.attempted, `${path}.attempted`), returned: integer(s.returned, `${path}.returned`), retained: integer(s.retained, `${path}.retained`), searchId: nullableText(s.searchId, `${path}.searchId`) };
      }),
      ...(coverage.sourceReads === undefined ? {} : { sourceReads: list(coverage.sourceReads, 'case.coverage.sourceReads', (item, path) => {
        const read = object(item, path);
        const requestedUrl = auditUrl(read.requestedUrl, `${path}.requestedUrl`);
        const finalUrl = read.finalUrl === null ? null : auditUrl(read.finalUrl, `${path}.finalUrl`);
        const sourceBinding = choice(read.sourceBinding, ['same_resource', 'normalized_resource', 'different_resource', 'blocked_destination', 'not_established', 'reference_destination'], `${path}.sourceBinding`);
        const outcome = choice(read.outcome, ['not_attempted', 'fetch_failed', 'binding_rejected', 'no_readable_text', 'no_matching_quote', 'page_quote'], `${path}.outcome`);
        const reference = read.reference === undefined ? undefined : (() => { const r = object(read.reference, `${path}.reference`); return { fromEvidenceId: id(r.fromEvidenceId, `${path}.reference.fromEvidenceId`), text: text(r.text, `${path}.reference.text`), supportingText: text(r.supportingText, `${path}.reference.supportingText`) }; })();
        if (reference && (reference.text.length > 400 || reference.supportingText.length > 1200)) fail(path, 'reference exceeds its text limits');
        if (sourceBinding === 'reference_destination' && !reference) fail(path, 'reference destination requires an inspected parent reference');
        const bound = (sourceBinding === 'reference_destination' && !!reference) || sourceBinding === 'same_resource' || sourceBinding === 'normalized_resource';
        if (bound && !finalUrl) fail(path, 'bound read requires a final URL');
        if (outcome === 'not_attempted' && (finalUrl || sourceBinding !== 'not_established')) fail(path, 'unattempted read cannot bind a destination');
        if (outcome === 'binding_rejected' && bound) fail(path, 'rejected read cannot claim a bound resource');
        if (['no_readable_text', 'no_matching_quote', 'page_quote'].includes(outcome) && !bound) fail(path, 'extracted read requires a bound resource');
        return { evidenceId: id(read.evidenceId, `${path}.evidenceId`), requestedUrl, finalUrl, sourceBinding, outcome, ...(reference ? { reference } : {}) };
      }) }),
    },
  };
  if (coverage.topicCandidateAudit !== undefined) {
    try { result.coverage.topicCandidateAudit = parseTopicCandidateAudit(coverage.topicCandidateAudit, result.coverage.searches, result.coverage.sourceReads); }
    catch { fail('case.coverage.topicCandidateAudit', 'invalid bounded topic candidate audit'); }
  }
  const unique = <T extends { id: string }>(items: T[], path: string) => {
    const map = new Map<string, T>();
    for (const item of items) {
      if (map.has(item.id)) fail(path, `duplicate id ${item.id}`);
      map.set(item.id, item);
    }
    return map;
  };
  const claims = unique(result.claims, 'case.claims');
  const assets = unique(result.assets, 'case.assets');
  const evidenceById = unique(result.evidence, 'case.evidence');
  const occurrences = unique(result.occurrences, 'case.occurrences');
  unique(result.relations, 'case.relations');
  const requireId = (ids: ReadonlyMap<string, unknown>, value: string, path: string) => {
    if (!ids.has(value)) fail(path, `missing reference ${value}`);
  };
  const checkAssessment = (value: Assessment, path: string) => {
    if (value.status !== 'unknown') for (const evidenceId of value.evidenceIds) requireId(evidenceById, evidenceId, path);
  };
  const checkSpan = (assetId: string, value: MediaSpan, path: string) => {
    const media = assets.get(assetId);
    if (!media) return fail(path, `missing asset ${assetId}`);
    if (value.kind === 'time' && (media.kind === 'image' || (media.durationMs !== null && value.startMs + value.durationMs > media.durationMs))) fail(path, 'time span exceeds media bounds');
  };
  for (const item of result.evidence) if (item.content.kind === 'media') checkSpan(item.content.assetId, item.content.span, `evidence.${item.id}`);
  for (const item of result.occurrences) {
    checkSpan(item.assetId, item.span, `occurrence.${item.id}`);
    requireId(evidenceById, item.sourceEvidenceId, `occurrence.${item.id}`);
    checkAssessment(item.identity, `occurrence.${item.id}.identity`);
  }
  for (const item of result.relations) {
    const path = `relation.${item.id}`;
    checkAssessment(item.assessment, path);
    if (item.kind === 'evidence_claim') {
      requireId(evidenceById, item.evidenceId, path); requireId(claims, item.claimId, path);
    } else {
      const [from, to, ids] = item.kind === 'claim_claim' ? [item.fromClaimId, item.toClaimId, claims] : [item.fromOccurrenceId, item.toOccurrenceId, occurrences];
      requireId(ids, from, path); requireId(ids, to, path);
      if (from === to) fail(path, 'self relations are not allowed');
      if (item.relationship === 'similar_media' && item.assessment.status === 'observed') fail(path, 'similarity is an inference, not an observed transmission link');
    }
  }
  return result;
}

/** Old results legitimately have no case. Malformed additions do not invalidate them. */
export function readCaseFromResult(value: unknown):
  | { status: 'available'; caseRecord: CaseRecord }
  | { status: 'absent' }
  | { status: 'invalid'; reason: string } {
  if (value === null || typeof value !== 'object') return { status: 'absent' };
  if ('caseProjectionError' in value && value.caseProjectionError === 'invalid_source_result') {
    return { status: 'invalid', reason: 'The case could not be validated; the original image report remains available.' };
  }
  if (!('caseRecord' in value)) return { status: 'absent' };
  try { return { status: 'available', caseRecord: parseCaseRecord(value.caseRecord) }; }
  catch (error) {
    if (!(error instanceof CaseValidationError)) throw error;
    return { status: 'invalid', reason: error.message };
  }
}
