import { describe, expect, it } from 'vitest';
import { hasSelfContainedMovLayout } from './container-signature';
import { VIDEO_LIMITS } from './ingest';
function atom(type: string, payload = Buffer.alloc(0), layout: 'normal' | 'extended' | 'terminal' = 'normal') {
  const header = Buffer.alloc(layout === 'extended' ? 16 : 8);
  header.writeUInt32BE(layout === 'terminal' ? 0 : layout === 'extended' ? 1 : header.length + payload.length);
  header.write(type, 4, 4, 'ascii');
  if (layout === 'extended') header.writeBigUInt64BE(BigInt(header.length + payload.length), 8);
  return Buffer.concat([header, payload]);
}
const movie = atom('moov', atom('mvhd', Buffer.alloc(8))), media = atom('mdat', Buffer.from([1, 2, 3]));
const ftyp = atom('ftyp', Buffer.from('qt  \0\0\0\0', 'binary'));
describe('bounded MOV/MP4 atom recognition', () => {
  it('recognizes legacy movie/media layouts, padding before ftyp and extended/terminal atoms', () => {
    for (const layout of [Buffer.concat([movie, media]), Buffer.concat([media, movie]), Buffer.concat([atom('free'), ftyp, movie, media]), Buffer.concat([atom('skip', Buffer.alloc(4), 'extended'), movie, media]), Buffer.concat([movie, atom('mdat', Buffer.from([1]), 'terminal')]), Buffer.concat([movie, media, atom('free', Buffer.alloc(0), 'terminal')])]) expect(hasSelfContainedMovLayout(layout)).toBe(true);
    const backing = Buffer.concat([Buffer.from('prefix'), movie, media]);
    expect(hasSelfContainedMovLayout(backing.subarray(6))).toBe(true);
  });
  it('rejects incomplete, overflowing, non-media and unsupported layouts', () => {
    const oversizedHeader = atom('free', Buffer.alloc(0), 'extended'); oversizedHeader.writeUInt32BE(1, 8);
    const undersizedExtended = atom('free', Buffer.alloc(0), 'extended'); undersizedExtended.writeUInt32BE(8, 12);
    const hugeSize = atom('free'); hugeSize.writeUInt32BE(0xffffffff);
    const invalidSmall = atom('free'); invalidSmall.writeUInt32BE(7);
    const layout = Buffer.concat([ftyp, movie, media]);
    for (const bytes of [
      Buffer.alloc(0), Buffer.from('#EXTM3U\nhttps://example.com/video\n'), Buffer.from('RIFF AVI '),
      ftyp, movie, media, Buffer.concat([ftyp, media]), Buffer.concat([atom('moov'), media]),
      Buffer.concat([movie, atom('mdat')]), Buffer.concat([movie, movie, media]),
      layout.subarray(0, layout.length - 1), Buffer.concat([layout, Buffer.from([0])]),
      Buffer.concat([invalidSmall, movie, media]), Buffer.concat([hugeSize, movie, media]),
      Buffer.concat([oversizedHeader, movie, media]), Buffer.concat([undersizedExtended, movie, media]),
      atom('free', Buffer.alloc(0), 'extended').subarray(0, 12),
      Buffer.concat([atom('junk', Buffer.from([1]), 'terminal'), movie, media]),
      Buffer.concat([atom('moov', atom('trak', Buffer.alloc(0), 'terminal')), media]),
      Buffer.concat([atom('moov', atom('cmov')), media]), Buffer.concat([atom('moov', atom('rmra')), media]),
      new Uint8Array(VIDEO_LIMITS.bytes + 1),
    ]) expect(hasSelfContainedMovLayout(bytes)).toBe(false);
  });
  it('bounds atom counts and nesting rather than scanning arbitrarily deep uploaded metadata', () => {
    let nested = atom('mvhd', Buffer.alloc(8));
    for (let depth = 0; depth < 14; depth++) nested = atom('trak', nested);
    expect(hasSelfContainedMovLayout(Buffer.concat([atom('moov', nested), media]))).toBe(false);
    expect(hasSelfContainedMovLayout(Buffer.concat([movie, media, ...Array.from({ length: 4096 }, () => atom('free'))]))).toBe(false);
  });
  it('admits only empty self-contained URL data references and rejects external URLs, URNs and aliases', () => {
    const referenceLayout = (entry: Buffer) => Buffer.concat([atom('moov', atom('trak', atom('mdia', atom('minf', atom('dinf', atom('dref', Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]), entry]))))))), media]);
    expect(hasSelfContainedMovLayout(referenceLayout(atom('url ', Buffer.from([0, 0, 0, 1]))))).toBe(true);
    for (const entry of [atom('url ', Buffer.concat([Buffer.alloc(4), Buffer.from('https://example.com/private\0')])), atom('url ', Buffer.concat([Buffer.alloc(4), Buffer.from('/private/untrusted.mov\0')])), atom('urn ', Buffer.concat([Buffer.alloc(4), Buffer.from('media\0https://example.com/private\0')])), atom('alis', Buffer.from([0, 0, 0, 0])), atom('url ', Buffer.from([0, 0, 0, 0])), atom('url ', Buffer.from([0, 0, 0, 1, 0]))]) expect(hasSelfContainedMovLayout(referenceLayout(entry))).toBe(false);
  });
});
