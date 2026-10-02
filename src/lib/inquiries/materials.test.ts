import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import fixture from '../../../scripts/fixtures/precise-anchors/synthetic.json';
import { MATERIAL_LIMITS, parseMaterialEdit, parseMaterialStore } from './materials';

const hash = `sha256:${'0'.repeat(64)}`;
const material = () => ({ materialId: 'image', revision: 1, evidenceId: 'image-e', evidenceDigest: hash, capturedAt: '2026-10-01T00:00:00Z', rights: 'user_provided', content: { kind: 'image', mimeType: 'image/png', base64: fixture.image.base64 } });
const parse = (value: unknown) => parseMaterialEdit({ kind: 'retain', material: value });
function crc32(bytes: Buffer): number { let n = 0xffffffff; for (const byte of bytes) { n ^= byte; for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0); } return (n ^ 0xffffffff) >>> 0; }
function chunk(type: string, content: Buffer): Buffer { const bytes = Buffer.alloc(content.length + 12); bytes.writeUInt32BE(content.length); bytes.write(type, 4); content.copy(bytes, 8); bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4); return bytes; }
function alteredHeader(offset: number, value: number) { const bytes = Buffer.from(fixture.image.base64, 'base64'); bytes[offset] = value; bytes.writeUInt32BE(crc32(bytes.subarray(12, 29)), 29); return bytes; }
function encoded(bytes: Buffer) { return { ...material(), content: { ...material().content, base64: bytes.toString('base64') } }; }

describe('bounded retained material parser', () => {
  it('derives dimensions from decoded synthetic PNG and roundtrips digest-checked content', () => {
    const parsed = parse(material());
    expect(parsed.kind).toBe('retain');
    if (parsed.kind !== 'retain') throw new Error('Expected material');
    expect(parsed.material.content).toMatchObject({ width: 8, height: 6, base64: fixture.image.base64 });
    const store = { versions: [parsed.material], heads: [{ materialId: 'image', status: 'available', digest: parsed.material.digest, sourceStatus: 'bound' }] };
    expect(parseMaterialStore(JSON.parse(JSON.stringify(store)))).toEqual(store);
    expect(() => parseMaterialStore({ ...store, versions: [{ ...parsed.material, digest: hash }] })).toThrow('digest mismatch');
    expect(() => parseMaterialStore({ ...store, heads: [{ ...store.heads[0], digest: hash }] })).toThrow('Missing retained');
  });
  it.each([
    ['empty PNG', ''], ['non-base64', 'not base64'], ['noncanonical padding', `${fixture.image.base64}\n`],
    ['too many encoded bytes', Buffer.alloc(MATERIAL_LIMITS.encodedImageBytes + 1).toString('base64')],
    ['not an image', Buffer.from('Synthetic string, not PNG pixels').toString('base64')],
  ])('rejects %s', (_name, base64) => {
    expect(() => parse({ ...material(), content: { ...material().content, base64 } })).toThrow();
  });
  it('rejects fake dimensions, unsupported formats, missing rights and invalid revisions/timestamps', () => {
    expect(() => parse({ ...material(), content: { ...material().content, width: 9 } })).toThrow('dimensions');
    expect(() => parse({ ...material(), content: { ...material().content, mimeType: 'image/jpeg' } })).toThrow('Unsupported image');
    expect(() => parse({ ...material(), rights: 'public_reference' })).toThrow('user_provided');
    expect(() => parse({ ...material(), revision: 0 })).toThrow('revision');
    expect(() => parse({ ...material(), capturedAt: '2026-02-30T00:00:00Z' })).toThrow('timestamp');
  });
  it('rejects oversized declared dimensions before decoding', () => {
    const bytes = Buffer.from(fixture.image.base64, 'base64'); bytes.writeUInt32BE(0x7fffffff, 16);
    expect(() => parse(encoded(bytes))).toThrow('dimensions exceed');
    bytes.writeUInt32BE(2048, 16); bytes.writeUInt32BE(2048, 20);
    expect(() => parse(encoded(bytes))).toThrow('dimensions exceed');
  });
  it.each([[24, 16], [25, 3], [28, 1]])('rejects unsupported PNG header setting %s/%s', (offset, value) => {
    expect(() => parse(encoded(alteredHeader(offset, value)))).toThrow('Unsupported PNG');
  });
  it('rejects corrupt, truncated, animated, repeated-header and trailing PNG data', () => {
    const bytes = Buffer.from(fixture.image.base64, 'base64'), corrupt = Buffer.from(bytes); corrupt[40] ^= 1;
    expect(() => parse(encoded(corrupt))).toThrow();
    expect(() => parse(encoded(bytes.subarray(0, -4)))).toThrow();
    expect(() => parse(encoded(Buffer.concat([bytes, Buffer.from('extra')])))).toThrow('PNG end');
    expect(() => parse(encoded(Buffer.concat([bytes.subarray(0, 33), chunk('acTL', Buffer.alloc(8)), bytes.subarray(33)])))) .toThrow('Animated');
    expect(() => parse(encoded(Buffer.concat([bytes.subarray(0, 33), bytes.subarray(8, 33), bytes.subarray(33)])))).toThrow('repeated-header');
  });
  it('rejects inflated bytes beyond the declared dimensions and invalid scanline filters', () => {
    const header = Buffer.from(fixture.image.base64, 'base64').subarray(0, 33);
    for (const raw of [Buffer.alloc(199), Buffer.alloc(198, 8)]) {
      const bytes = Buffer.concat([header, chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
      expect(() => parse(encoded(bytes))).toThrow(/pixel stream|pixels could not/);
    }
  });
  it('retains literal table values and rejects ragged or oversized tables', () => {
    const parsed = parse({ ...material(), content: fixture.table });
    if (parsed.kind !== 'retain') throw new Error('Expected retained material');
    expect(parsed.material.content).toEqual(fixture.table);
    for (const content of [
      { kind: 'table', columns: [], rows: [] },
      { kind: 'table', columns: ['a'], rows: [['a', 'b']] },
      { kind: 'table', columns: ['a'], rows: [[123]] },
      { kind: 'table', columns: ['a'], rows: [['a'.repeat(20001)]] },
      { kind: 'table', columns: Array(65).fill('a'), rows: [Array(65).fill('x')] },
      { kind: 'table', columns: ['a'], rows: Array(1001).fill(['x']) },
      { kind: 'table', columns: Array(64).fill('a'), rows: Array(157).fill(Array(64).fill('x')) },
      { kind: 'table', columns: ['a'], rows: Array(8).fill(['x'.repeat(20000)]) },
    ]) expect(() => parse({ ...material(), content })).toThrow();
  });
  it('rejects total retained-history size and version count before decoding material', () => {
    expect(() => parseMaterialStore({ versions: Array(33).fill(null), heads: [] })).toThrow('32 versions or 2 MiB');
    expect(() => parseMaterialStore({ versions: [], heads: [{ materialId: 'a', status: 'unavailable', reason: 'x'.repeat(MATERIAL_LIMITS.retainedBytes) }] })).toThrow('32 versions or 2 MiB');
  });
  it('keeps the PNG decoder pinned to its official registry artifact', () => {
    const pkg = JSON.parse(readFileSync('package-lock.json', 'utf8'));
    expect(pkg.packages['node_modules/pngjs'].version).toBe('7.0.0');
    expect(pkg.packages['node_modules/pngjs'].resolved).toBe('https://registry.npmjs.org/pngjs/-/pngjs-7.0.0.tgz');
  });
});
