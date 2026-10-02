import { describe, expect, it } from 'vitest';
import { extractPage } from '../../pages/extract';
import { JevClient } from '../../jev/client';
import { runInvestigation, type SearchProvider } from '../run';
import type { InvestigationEvent } from '../contracts/events';

const pageUrl = 'https://source.example/photo';
const foreignUrl = 'https://other.example/unrelated-article';
const publication = { '@type': 'Article', headline: 'Foreign publication metadata', datePublished: '2000-01-01', dateCreated: '1990-01-01' };
const foreignParent = (child: unknown) => ({ '@type': 'WebPage', url: foreignUrl, mainEntity: child });
const html = (jsonLd: unknown) => `<html><head><title>Source photograph</title><script type="application/ld+json">${JSON.stringify(jsonLd)}</script></head><body><article><p>${'This source photograph depicts an event; its own publication date has not been independently established. '.repeat(30)}</p></article></body></html>`;

async function investigate(jsonLd: unknown) {
  let searches = 0;
  let reads = 0;
  let classifications = 0;
  const serpapi: SearchProvider = {
    uploadImage: async () => 'offline-image',
    search: async params => {
      searches += 1;
      return params.type === 'exact_matches'
        ? { exact_matches: [{ position: 1, title: 'Source photograph', link: pageUrl }] } : {};
    },
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
    serpapi, jev, fetchPage: async url => { reads += 1; return { url, html: html(jsonLd) }; },
  });
  const terminal = events.find(event => event.type === 'investigation.completed');
  if (terminal?.type !== 'investigation.completed') throw new Error('Missing completed investigation');
  return { result: terminal.result, searches, reads, classifications };
}

describe('contradictory JSON-LD parent cannot confer publication ownership', () => {
  it.each([
    foreignParent(publication),
    { '@type': 'WebPage', '@id': foreignUrl, mainEntity: publication },
    { '@type': 'WebPage', mainEntityOfPage: { '@id': foreignUrl }, mainEntity: publication },
  ])('rejects a root foreign WebPage mainEntity date and metadata from an unbound article', graph => {
    const extracted = extractPage(html(graph), pageUrl);
    expect(extracted.jsonLdDates).toEqual([]);
    expect(extracted.jsonLdDateBinding).toBeNull();
    expect(extracted.jsonLdMetadata).toEqual([]);
    expect(extracted.rejectedJsonLdDates).toContainEqual({ value: '2000-01-01', reason: 'unbound_nested_entity' });
  });

  it.each([
    foreignParent([publication]),
    { '@type': 'WebPage', url: pageUrl, mainEntity: foreignParent(publication) },
    { '@type': 'WebPage', url: pageUrl, mainEntity: foreignParent({ '@type': 'WebPage', mainEntity: publication }) },
  ])('does not confer ownership through arrays or deeper foreign parents', graph => {
    const extracted = extractPage(html(graph), pageUrl);
    expect(extracted.jsonLdDates).toEqual([]);
    expect(extracted.jsonLdMetadata).toEqual([]);
    expect(extracted.rejectedJsonLdDates).toContainEqual({ value: '2000-01-01', reason: 'unbound_nested_entity' });
  });

  it.each([
    foreignParent({ ...publication, url: pageUrl }),
    { '@type': 'WebPage', url: pageUrl, mainEntity: foreignParent({ ...publication, mainEntityOfPage: { '@id': pageUrl } }) },
    foreignParent({ '@type': 'WebPage', url: pageUrl, mainEntity: publication }),
  ])('preserves independently bound children and their legitimate mainEntity descendants', graph => {
    const extracted = extractPage(html(graph), pageUrl);
    expect(extracted.jsonLdDates).toEqual(['2000-01-01']);
    expect(extracted.jsonLdMetadata).toHaveLength(1);
    expect(extracted.rejectedJsonLdDates).toEqual([]);
    expect(extracted.jsonLdDateBinding).not.toBeNull();
  });

  it('preserves an uncontradicted root mainEntity fallback and an explicitly bound parent', () => {
    for (const parent of [{ '@type': 'WebPage', mainEntity: publication }, { '@type': 'WebPage', url: pageUrl, mainEntity: publication }]) {
      const extracted = extractPage(html(parent), pageUrl);
      expect(extracted.jsonLdDates).toEqual(['2000-01-01']);
      expect(extracted.jsonLdDateBinding).toBe('main_entity');
    }
  });

  it('keeps a foreign publication date out of a same-resource exact-media chronology', async () => {
    const { result, searches, reads, classifications } = await investigate(foreignParent(publication));
    expect(result.earliestObservedOccurrence).toBeNull();
    expect(result.timeline).toEqual([]);
    expect(result.undatedEvidence[0]).toMatchObject({ sourceUrl: pageUrl, mediaRelationship: 'EXACT_MATCH', dateStatus: 'unknown', observedAt: null, dateProvenance: { entityBinding: null } });
    expect(result.undatedEvidence[0].dateProvenance.rejectedCandidates).toContainEqual({ value: '2000-01-01', reason: 'unbound_nested_entity' });
    expect(result.sourceLinkedReport?.pageReads[0]).toMatchObject({ requestedUrl: pageUrl, finalUrl: pageUrl, sourceBinding: 'same_resource', extraction: 'usable_text' });
    expect(result.limitations).toContain('unknown_dates_present');
    expect(result.limitations).toContain('insufficient_dated_occurrences');
    expect({ searches, reads, classifications }).toEqual({ searches: 2, reads: 1, classifications: 2 });
  });

  it('retains a child with independent resource ownership as a dated exact occurrence', async () => {
    const { result, searches, reads, classifications } = await investigate(foreignParent({ ...publication, url: pageUrl }));
    expect(result.earliestObservedOccurrence).toBe('2000-01-01');
    expect(result.timeline[0]).toMatchObject({ sourceUrl: pageUrl, mediaRelationship: 'EXACT_MATCH', observedAt: '2000-01-01', publishedAtSource: 'page_json_ld', dateProvenance: { entityBinding: 'page_url' } });
    expect(result.timeline[0].dateProvenance.rejectedCandidates).toEqual([]);
    expect(result.sourceLinkedReport?.pageReads[0].sourceBinding).toBe('same_resource');
    expect({ searches, reads, classifications }).toEqual({ searches: 2, reads: 1, classifications: 2 });
  });
});
