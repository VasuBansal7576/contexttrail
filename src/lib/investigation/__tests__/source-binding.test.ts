import { describe, expect, it } from 'vitest';
import { bindFetchedSource } from '../../pages/source-binding';
import { JevClient } from '../../jev/client';
import { runInvestigation, type SearchProvider } from '../run';
import type { InvestigationEvent } from '../contracts/events';

const requested = 'http://www.source.example/photo/?id=42&utm_source=test';
const content = 'This photograph records an older event with source context and an explicit publication date. '.repeat(30);
const html = (url: string) => `<html><head><title>Source photo</title><script type="application/ld+json">${JSON.stringify({ '@type': 'Article', url, datePublished: '2000-01-01' })}</script></head><body><article><p>${content}</p></article></body></html>`;

async function investigate(final: string | null) {
  let classifications = 0;
  const serpapi: SearchProvider = {
    uploadImage: async () => 'offline-image',
    search: async params => params.type === 'exact_matches'
      ? { exact_matches: [{ position: 1, title: 'Source photo', link: requested }] } : {},
  };
  const jev = new JevClient({ apiKey: 'offline-only', fetchImpl: async () => {
    classifications += 1;
    return Response.json({ model: 'jev-1.13.0', answers: {
      relevance: { type: 'noul', noul: .95 },
      page_role: { type: 'choice', choice: 'REPORTING', probabilities: { REPORTING: 1, FACT_CHECK: 0, SOCIAL_REPOST: 0, AGGREGATOR: 0, COMMENTARY: 0, OTHER: 0 } },
    } });
  } });
  const events: InvestigationEvent[] = [];
  await runInvestigation({ media: new Uint8Array([1]), claim: null, timezone: 'UTC', locale: 'en' }, event => events.push(event), {
    serpapi, jev, fetchPage: async () => {
      if (final === null) throw new Error('Offline unavailable');
      return { url: final, html: html(final) };
    },
  });
  const event = events.find(event => event.type === 'investigation.completed');
  if (event?.type !== 'investigation.completed') throw new Error('Missing completion');
  return { result: event.result, classifications };
}

describe('deep reads bind the original occurrence to the final resource', () => {
  it.each([
    ['https://other.example/unrelated', 'different_resource'],
    ['https://source.example/unrelated', 'different_resource'],
    ['https://source.example/photo?id=43', 'different_resource'],
    ['https://www.facebook.com/unsupportedbrowser', 'blocked_destination'],
    ['http://www.source.example/login', 'blocked_destination'],
  ])('rejects %s before quotes, dates, origin refinement or classification', async (final, binding) => {
    const { result, classifications } = await investigate(final);
    const audit = result.sourceLinkedReport?.pageReads[0];
    expect(audit).toMatchObject({ requestedUrl: requested, finalUrl: final, sourceBinding: binding, fetch: 'succeeded', extraction: 'not_attempted', failureCode: 'source_binding_rejected' });
    expect(result.earliestObservedOccurrence).toBeNull();
    expect(result.sourceLinkedReport?.provenanceCompleteness.unresolvedReportingOrigins).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(content.slice(0, 100));
    expect(classifications).toBe(1);
    expect(result.limitations).toContain('page_fetch_partial_failure');
  });

  it('accepts only explicitly normalized identity, including HTTPS upgrade and tracking removal', async () => {
    const final = 'https://source.example/photo?id=42';
    expect(bindFetchedSource(requested, final)).toBe('normalized_resource');
    const { result, classifications } = await investigate(final);
    expect(result.sourceLinkedReport?.pageReads[0]).toMatchObject({ requestedUrl: requested, finalUrl: final, sourceBinding: 'normalized_resource', extraction: 'usable_text', failureCode: null });
    expect(result.earliestObservedOccurrence).toBe('2000-01-01');
    expect(classifications).toBe(2);
  });

  it('keeps failed reads visibly unbound', async () => {
    const { result, classifications } = await investigate(null);
    expect(result.sourceLinkedReport?.pageReads[0]).toMatchObject({ sourceBinding: 'not_established', finalUrl: null, fetch: 'failed', extraction: 'not_attempted', failureCode: 'unknown' });
    expect(result.earliestObservedOccurrence).toBeNull();
    expect(classifications).toBe(1);
  });

  it('rejects invalid, credential-bearing and sensitive-query destinations and HTTPS downgrades', () => {
    expect(bindFetchedSource(requested, 'https://source.example/photo?token=secret')).toBe('not_established');
    expect(bindFetchedSource(requested, 'https://user:secret@source.example/photo')).toBe('not_established');
    expect(bindFetchedSource('https://source.example/photo', 'http://source.example/photo')).toBe('different_resource');
    expect(bindFetchedSource(requested, 'file:///private')).toBe('not_established');
  });
});
