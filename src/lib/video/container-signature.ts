import { VIDEO_LIMITS } from './ingest';
/** Recognition only. The restricted decoder still validates codecs, dimensions and duration. */
const MAX_ATOMS = 4096;
const MAX_DEPTH = 12;
const leadingAtoms = new Set(['ftyp', 'free', 'skip', 'wide', 'moov', 'mdat', 'uuid', 'pnot', 'junk']);
const containers = new Set(['moov', 'trak', 'mdia', 'minf', 'dinf', 'edts', 'mvex', 'moof', 'traf', 'mfra']);
interface Atom { type: string; payload: number; end: number }
/** Recognize bounded ISO BMFF/QuickTime atom layouts, including old MOV without ftyp. */
export function hasSelfContainedMovLayout(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 16 || bytes.byteLength > VIDEO_LIMITS.bytes) return false;
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let count = 0;
  function atom(start: number, end: number, allowZero: boolean): Atom | null {
    if (++count > MAX_ATOMS || end - start < 8) return null;
    let size = data.getUint32(start), header = 8;
    if (size === 1) {
      if (end - start < 16 || data.getUint32(start + 8) !== 0) return null;
      size = data.getUint32(start + 12); header = 16;
    } else if (size === 0) {
      if (!allowZero) return null;
      size = end - start;
    }
    if (size < header || size > end - start) return null;
    const type = String.fromCharCode(bytes[start + 4], bytes[start + 5], bytes[start + 6], bytes[start + 7]);
    return { type, payload: start + header, end: start + size };
  }
  function references(box: Atom): boolean {
    if (box.end - box.payload < 8 || data.getUint32(box.payload) !== 0) return false;
    const entries = data.getUint32(box.payload + 4);
    if (!entries || entries > MAX_ATOMS) return false;
    let offset = box.payload + 8;
    for (let index = 0; index < entries; index++) {
      const entry = atom(offset, box.end, false);
      // Only the empty, self-contained URL reference is admitted. URLs, URNs
      // and QuickTime file aliases with external locations never reach decoding.
      if (!entry || entry.type !== 'url ' || entry.end - entry.payload !== 4 || data.getUint32(entry.payload) !== 1) return false;
      offset = entry.end;
    }
    return offset === box.end;
  }
  function children(start: number, end: number, depth: number): boolean {
    if (depth > MAX_DEPTH) return false;
    let offset = start;
    while (offset < end) {
      const child = atom(offset, end, false);
      if (!child || child.type === 'cmov' || child.type === 'rmra' || child.type === 'rdrf') return false;
      if (child.type === 'dref' && !references(child)) return false;
      if (containers.has(child.type) && !children(child.payload, child.end, depth + 1)) return false;
      offset = child.end;
    }
    return offset === end;
  }
  let offset = 0, movie = false, media = false;
  while (offset < bytes.byteLength) {
    const box = atom(offset, bytes.byteLength, true);
    if (!box || (offset === 0 && !leadingAtoms.has(box.type)) || box.type === 'cmov' || box.type === 'rmra' || box.type === 'rdrf') return false;
    if (box.type === 'ftyp' && (box.end - box.payload < 8 || (box.end - box.payload) % 4 !== 0)) return false;
    if (box.type === 'moov') {
      if (movie || box.end === box.payload || !children(box.payload, box.end, 1)) return false;
      movie = true;
    }
    if (box.type === 'mdat' && box.end > box.payload) media = true;
    offset = box.end;
  }
  return movie && media;
}
