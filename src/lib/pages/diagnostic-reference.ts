import { safeReferenceParameters } from './source-reference-policy';

// Browser validation for retained diagnostics only. Network admission still
// uses fetch.ts's DNS resolution, public-address checks and pinned sockets.
// Parity tests pin these special-use exclusions to that existing policy.
const blockedV4 = [
  [0, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8],
  [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24],
  [0xc0586300, 24], [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24],
  [0xcb007100, 24], [0xe0000000, 4], [0xf0000000, 4],
] as const;
function publicLiteral(host: string): boolean {
  if (host.includes(':')) {
    const pieces = host.split('::');
    const left = pieces[0].split(':').filter(Boolean);
    const right = (pieces[1] ?? '').split(':').filter(Boolean);
    const words = [...left, ...Array.from({ length: 8 - left.length - right.length }, () => '0'), ...right].map(word => Number.parseInt(word, 16));
    if (words.length !== 8 || words.some(word => !Number.isInteger(word) || word < 0 || word > 65535)) return false;
    const [first, second] = words;
    return first >= 0x2000 && first <= 0x3fff
      && !(first === 0x2001 && (second < 0x0200 || second === 0x0db8))
      && first !== 0x2002 && !(first === 0x3fff && second < 0x1000);
  }
  const octets = host.split('.').map(Number);
  const value = octets.reduce((total, octet) => total * 256 + octet, 0);
  return octets.length === 4 && octets.every(octet => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    && !blockedV4.some(([network, prefix]) => Math.floor(value / 2 ** (32 - prefix)) === Math.floor(network / 2 ** (32 - prefix)));
}

/** Preserve semantic queries; reject unsafe references rather than rewrite identity. */
export function diagnosticReferenceUrl(raw: string): string | null {
  if (raw.length > 4096) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !safeReferenceParameters(url)) return null;
  const host = url.hostname.toLowerCase().replace(/\.+$/, '');
  const literal = host.replace(/^\[|\]$/g, '');
  if (host.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    if (!publicLiteral(literal)) return null;
  } else if (!host.includes('.') || host.length > 253 || host.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    || ['localhost', 'local', 'internal', 'home.arpa'].some(name => host === name || host.endsWith(`.${name}`))) return null;
  url.hostname = host; url.hash = '';
  const result = url.toString();
  return result.length <= 4096 ? result : null;
}
