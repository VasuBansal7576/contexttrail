import { describe, expect, it } from 'vitest';
import { diagnosticReferenceUrl } from './diagnostic-reference';
import { retainableSourceUrl } from './source-reference';

describe('browser-safe diagnostic URL parity with unchanged server admission', () => {
  it.each([
    'https://PUBLIC.EXAMPLE./Article?id=CaseSensitive#fragment', 'https://public.example:8080/article',
    'https://public.example/article?post=1', 'https://public.example/article?post=2',
    'http://93.184.216.34/article', 'https://[2606:4700:4700::1111]/article', 'https://[2001:4860:4860::8888]/',
    'http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/', 'http://%31%32%37.0.0.1/',
    'http://[::1]/', 'http://[::ffff:93.184.216.34]/', 'http://[::ffff:127.0.0.1]/', 'http://[2002:7f00:1::]/',
    'http://[fe80::1%25eth0]/', 'http://LOCALHOST./', 'http://sub.localhost./', 'http://printer.local./', 'http://host.internal./',
    'http://host.home.arpa./', 'http://singlelabel/', 'http://bad..example/', 'http://-bad.example/', 'http://%6cocalhost./',
    'https://user:synthetic@public.example/', 'https://public.example/?token=synthetic', 'https://public.example/?X-Amz-Signature=synthetic',
    'https://public.example/?api_key=synthetic', 'https://public.example/?post=1&ref=2', 'ftp://public.example/',
    `https://public.example/${'x'.repeat(4096)}`,
  ])('retains the same safe reference for %s', url => expect(diagnosticReferenceUrl(url)).toBe(retainableSourceUrl(url)));

  it('matches server literal-IP subnet edges and deterministic address samples', () => {
    const addresses = ['::', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '64:ff9b::1',
      '1fff:ffff::1', '2000::1', '2001:1ff:ffff::1', '2001:200::1', '2001:db8::1', '2001:db7::1', '2001:db9::1',
      '2002::1', '2003::1', '3ffe:ffff::1', '3fff:fff:ffff::1', '3fff:1000::1', '3fff:ffff::1', '4000::1'];
    const networks = [[0, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24], [0xc0586300, 24], [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24], [0xcb007100, 24], [0xe0000000, 4], [0xf0000000, 4]];
    const values = networks.flatMap(([network, prefix]) => [network - 1, network, network + 2 ** (32 - prefix) - 1, network + 2 ** (32 - prefix)]);
    for (let index = 0; index < 256; index++) values.push((index * 2654435761) >>> 0);
    for (const value of values.filter(value => value >= 0 && value <= 0xffffffff)) addresses.push([24, 16, 8, 0].map(bits => Math.floor(value / 2 ** bits) % 256).join('.'));
    for (const address of addresses) {
      const url = `http://${address.includes(':') ? `[${address}]` : address}/source?id=original`;
      expect(diagnosticReferenceUrl(url), url).toBe(retainableSourceUrl(url));
    }
  });
});
