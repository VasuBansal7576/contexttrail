/** Bounded user-supplied material. No URL/path reads, OCR, or authenticity assessment. */
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { PNG } from 'pngjs';
import type { CaseRecord } from '../cases/model';
import { evidenceDigest } from '../watchlists/collection';
import { list, object, unique } from '../watchlists/parse';

export const MATERIAL_LIMITS = { encodedImageBytes: 256 * 1024, imageDimension: 2048, imagePixels: 1024 * 1024, tableBytes: 128 * 1024, tableRows: 1000, tableColumns: 64, tableCells: 10000, versions: 32, retainedBytes: 2 * 1024 * 1024 };
export type MaterialContent =
  | { kind: 'image'; mimeType: 'image/png'; base64: string; width: number; height: number }
  | { kind: 'table'; columns: string[]; rows: string[][] };
export interface RetainedMaterial {
  materialId: string; revision: number; evidenceId: string; evidenceDigest: string; capturedAt: string;
  rights: 'user_provided'; content: MaterialContent; digest: string;
}
export type MaterialHead =
  | { materialId: string; status: 'available'; digest: string; sourceStatus: 'bound' | 'changed' }
  | { materialId: string; status: 'unavailable'; reason: string };
export interface MaterialStore { versions: RetainedMaterial[]; heads: MaterialHead[] }
export type MaterialEdit =
  | { kind: 'retain'; material: RetainedMaterial }
  | { kind: 'withdraw'; materialId: string; reason: string };
export type MaterialInput = Omit<RetainedMaterial, 'digest' | 'content'> & {
  content: Omit<Extract<MaterialContent, { kind: 'image' }>, 'width' | 'height'> | Extract<MaterialContent, { kind: 'table' }>;
};
export type MaterialEditInput = { kind: 'retain'; material: MaterialInput } | Extract<MaterialEdit, { kind: 'withdraw' }>;

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}
export function materialHash(v: unknown): string { return `sha256:${createHash('sha256').update(canonical(v)).digest('hex')}`; }
function text(v: unknown, max = 256): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new Error('Expected bounded material text');
  return v;
}
export function parseDigest(v: unknown): string { const s = text(v); if (!/^sha256:[a-f0-9]{64}$/.test(s)) throw new Error('Invalid material digest'); return s; }
function timestamp(v: unknown): string {
  const s = text(v, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(s) || !Number.isFinite(Date.parse(s)) || new Date(s).toISOString().slice(0, 19) !== s.slice(0, 19)) throw new Error('Expected UTC material timestamp');
  return s;
}
function cell(v: unknown): string { if (typeof v !== 'string' || v.length > 20000) throw new Error('Expected bounded string table cell'); return v; }
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(base64: unknown): Extract<MaterialContent, { kind: 'image' }> {
  if (typeof base64 !== 'string' || base64.length > 4 * Math.ceil(MATERIAL_LIMITS.encodedImageBytes / 3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw new Error('Expected canonical base64 PNG, at most 256 KiB');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > MATERIAL_LIMITS.encodedImageBytes || bytes.toString('base64') !== base64) throw new Error('Invalid or oversized PNG encoding');
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Unsupported image format. Supply a non-interlaced 8-bit RGB/RGBA PNG.');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20), colorType = bytes[25];
  // Header limits run before either decompressor or decoder allocates image-sized output.
  if (!width || !height || width > MATERIAL_LIMITS.imageDimension || height > MATERIAL_LIMITS.imageDimension || width * height > MATERIAL_LIMITS.imagePixels) throw new Error('PNG dimensions exceed 2048 per axis or 1048576 pixels');
  if (bytes[24] !== 8 || ![2, 6].includes(colorType) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] !== 0) throw new Error('Unsupported PNG. Supply non-interlaced 8-bit RGB/RGBA pixels.');
  const compressed: Buffer[] = [];
  let offset = 8, count = 0, ended = false, dataEnded = false;
  while (offset < bytes.length) {
    if (++count > 1024 || offset + 12 > bytes.length) throw new Error('Malformed PNG chunks');
    const length = bytes.readUInt32BE(offset), end = offset + length + 12;
    if (end > bytes.length) throw new Error('Truncated PNG chunk');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (bytes.readUInt32BE(end - 4) !== crc32(bytes.subarray(offset + 4, end - 4))) throw new Error('PNG checksum mismatch');
    if ((type === 'IHDR' && offset !== 8) || ['acTL', 'fcTL', 'fdAT'].includes(type)) throw new Error('Animated or repeated-header PNG is unsupported');
    if (type === 'IDAT') { if (dataEnded) throw new Error('Noncontiguous PNG image data'); compressed.push(bytes.subarray(offset + 8, end - 4)); }
    else if (compressed.length) dataEnded = true;
    if (type === 'IEND') { if (length || end !== bytes.length || !compressed.length) throw new Error('Malformed PNG end'); ended = true; }
    offset = end;
  }
  if (!ended) throw new Error('Missing PNG end');
  const expectedBytes = (width * (colorType === 6 ? 4 : 3) + 1) * height;
  // pngjs truncates excess inflated bytes. Check the complete bounded stream first.
  let inflated: Buffer;
  try { inflated = inflateSync(Buffer.concat(compressed), { maxOutputLength: expectedBytes }); }
  catch { throw new Error('Invalid or oversized PNG pixel stream'); }
  if (inflated.length !== expectedBytes) throw new Error('PNG pixel stream does not match dimensions');
  try {
    const decoded = PNG.sync.read(bytes, { checkCRC: true });
    if (decoded.width !== width || decoded.height !== height || decoded.data.length !== width * height * 4) throw new Error('PNG dimension mismatch');
  } catch { throw new Error('PNG pixels could not be decoded'); }
  return { kind: 'image', mimeType: 'image/png', base64, width, height };
}
function content(value: unknown): MaterialContent {
  const o = object(value);
  if (o.kind === 'image') {
    if (o.mimeType !== 'image/png') throw new Error('Unsupported image format. Only image/png is supported.');
    const parsed = png(o.base64);
    if ((o.width !== undefined && o.width !== parsed.width) || (o.height !== undefined && o.height !== parsed.height)) throw new Error('Supplied dimensions do not match decoded PNG');
    return parsed;
  }
  if (o.kind !== 'table') throw new Error('Unsupported retained material kind');
  if (!Array.isArray(o.columns) || !o.columns.length || o.columns.length > MATERIAL_LIMITS.tableColumns || !Array.isArray(o.rows) || !o.rows.length || o.rows.length > MATERIAL_LIMITS.tableRows || o.columns.length * o.rows.length > MATERIAL_LIMITS.tableCells) throw new Error('Table exceeds bounds or has no cells');
  const columns = o.columns.map(cell), rows = o.rows.map(value => {
    if (!Array.isArray(value) || value.length !== columns.length) throw new Error('Table rows must match column count');
    return value.map(cell);
  });
  const result = { kind: 'table', columns, rows } satisfies MaterialContent;
  if (Buffer.byteLength(JSON.stringify(result)) > MATERIAL_LIMITS.tableBytes) throw new Error('Retained table exceeds 128 KiB');
  return result;
}
function material(value: unknown, saved: boolean): RetainedMaterial {
  const o = object(value);
  if (o.rights !== 'user_provided') throw new Error('Retaining material requires user_provided rights');
  if (typeof o.revision !== 'number' || !Number.isSafeInteger(o.revision) || o.revision < 1) throw new Error('Expected positive material revision');
  const result = { materialId: text(o.materialId), revision: o.revision, evidenceId: text(o.evidenceId), evidenceDigest: parseDigest(o.evidenceDigest), capturedAt: timestamp(o.capturedAt), rights: 'user_provided', content: content(o.content) } satisfies Omit<RetainedMaterial, 'digest'>;
  if (saved && result.content.kind === 'image') {
    const c = object(o.content);
    if (c.width !== result.content.width || c.height !== result.content.height) throw new Error('Saved PNG dimensions are missing or incorrect');
  }
  const digest = materialHash(result);
  if ((saved || o.digest !== undefined) && parseDigest(o.digest) !== digest) throw new Error('Retained material digest mismatch');
  return { ...result, digest };
}
export function parseMaterialEdit(value: unknown): MaterialEdit {
  const o = object(value);
  if (o.kind === 'retain') return { kind: 'retain', material: material(o.material, false) };
  if (o.kind === 'withdraw') return { kind: 'withdraw', materialId: text(o.materialId), reason: text(o.reason, 20000) };
  throw new Error('Unsupported material edit');
}
export function parseMaterialStore(value: unknown): MaterialStore {
  const o = object(value);
  if (!Array.isArray(o.versions) || o.versions.length > MATERIAL_LIMITS.versions || Buffer.byteLength(JSON.stringify(o)) > MATERIAL_LIMITS.retainedBytes) throw new Error('Retained material history exceeds 32 versions or 2 MiB');
  const versions = unique(o.versions.map(v => material(v, true)), v => v.digest);
  const heads = unique(list(o.heads, value => {
    const h = object(value), materialId = text(h.materialId);
    if (h.status === 'unavailable') return { materialId, status: 'unavailable', reason: text(h.reason, 20000) } satisfies MaterialHead;
    if (h.status !== 'available') throw new Error('Invalid material status');
    const digest = parseDigest(h.digest);
    if (h.sourceStatus !== 'bound' && h.sourceStatus !== 'changed') throw new Error('Invalid retained source status');
    if (!versions.some(v => v.materialId === materialId && v.digest === digest)) throw new Error('Missing retained material version');
    return { materialId, status: 'available', digest, sourceStatus: h.sourceStatus } satisfies MaterialHead;
  }), h => h.materialId);
  unique(versions, v => JSON.stringify([v.materialId, v.revision]));
  for (const version of versions) if (!heads.some(h => h.materialId === version.materialId)) throw new Error('Missing material head');
  for (const head of heads) if (!versions.some(v => v.materialId === head.materialId)) throw new Error('Missing material history');
  return { versions, heads };
}
export function applyMaterialEdits(store: MaterialStore, record: CaseRecord, edits: MaterialEdit[]): MaterialStore {
  const result = { versions: [...store.versions], heads: [...store.heads] };
  for (const edit of edits) {
    if (edit.kind === 'withdraw') {
      if (!result.heads.some(h => h.materialId === edit.materialId)) throw new Error('Cannot withdraw missing material');
      result.heads = [...result.heads.filter(h => h.materialId !== edit.materialId), { materialId: edit.materialId, status: 'unavailable', reason: edit.reason }];
      continue;
    }
    const m = edit.material, evidence = record.evidence.find(e => e.id === m.evidenceId);
    if (!evidence || evidenceDigest(record, evidence) !== m.evidenceDigest) throw new Error('Retained material refers to missing or changed source evidence');
    const previous = result.versions.find(v => v.materialId === m.materialId);
    const head = result.heads.find(h => h.materialId === m.materialId);
    const latestRevision = Math.max(0, ...result.versions.filter(v => v.materialId === m.materialId).map(v => v.revision));
    if (!(head?.status === 'available' && head.sourceStatus === 'bound' && head.digest === m.digest) && m.revision !== latestRevision + 1) throw new Error('Material replacement requires the next revision');
    if (previous && (previous.evidenceId !== m.evidenceId || previous.content.kind !== m.content.kind)) throw new Error('A material ID cannot move to another evidence item or kind');
    if (m.content.kind === 'image') {
      const asset = evidence.content.kind === 'media' ? record.assets.find(a => evidence.content.kind === 'media' && a.id === evidence.content.assetId) : null;
      if (!asset || asset.kind !== 'image') throw new Error('Image material requires image evidence');
      const hash = `sha256:${createHash('sha256').update(Buffer.from(m.content.base64, 'base64')).digest('hex')}`;
      if (asset.provenance.contentHash !== null && asset.provenance.contentHash !== hash) throw new Error('PNG bytes differ from the source asset digest');
    } else if (evidence.content.kind !== 'reference') throw new Error('Table material requires reference evidence; it does not reinterpret a retained passage or media');
    if (!result.versions.some(v => v.digest === m.digest)) result.versions.push(m);
    result.heads = [...result.heads.filter(h => h.materialId !== m.materialId), { materialId: m.materialId, status: 'available', digest: m.digest, sourceStatus: 'bound' }];
  }
  return parseMaterialStore(result);
}

/** Once source content changes, reverting it cannot silently renew an old review. */
export function invalidateMaterialSources(store: MaterialStore, record: CaseRecord): MaterialStore {
  return { ...store, heads: store.heads.map(head => {
    if (head.status !== 'available' || head.sourceStatus === 'changed') return head;
    const material = store.versions.find(m => m.digest === head.digest);
    const evidence = record.evidence.find(e => e.id === material?.evidenceId);
    return material && evidence && material.evidenceDigest === evidenceDigest(record, evidence) ? head : { ...head, sourceStatus: 'changed' };
  }) };
}
