import { describe, expect, it } from 'vitest';
import { normalizeSearchResponse } from '../serpapi/normalize';
import { documentSurfaceCue, selectTopicSources } from './topic-selection';
it('prioritises a matching document without certifying its authority or privileging an unrelated institution', () => {
  expect(documentSurfaceCue('How did PIX adoption change in Brazil?', { title: 'PIX statistics', snippet: 'Monthly payment statistics', sourceUrl: 'https://centralbank.example.org/publications/report.html' })).toBeGreaterThan(0);
  expect(documentSurfaceCue('How did PIX adoption change in Brazil?', { title: 'Central bank staff holidays', snippet: 'Staff holidays and office hours', sourceUrl: 'https://centralbank.example.org/publications/report.html' })).toBe(0);
  expect(documentSurfaceCue('How did Reef recovery change?', { title: 'Reef recovery statistics', snippet: 'Measured reef recovery', sourceUrl: 'https://research.example.com/blog/reef' })).toBeGreaterThan(0);
});


describe('search-surface relevance before incidental coverage', () => {
  it('does not spend a page slot on a one-word TV or legal result ahead of available entity-specific news', () => {
    const entries = [
      ...normalizeSearchResponse({ organic_results: [{ link: 'https://screen.example.org/series', title: '24 TV series', snippet: 'More information about the series.' }] }, 'google_search', { retrievedAt: '2026-10-04' }).candidates.map(candidate => ({ candidate, dates: {}, search: 0 })),
      ...normalizeSearchResponse({ organic_results: Array.from({ length: 8 }, (_, n) => ({ link: `https://report.example.org/${n}`, title: 'UPI transactions cross 24 billion in August', snippet: 'Monthly payments data from the provider.' })) }, 'google_search', { retrievedAt: '2026-10-04' }).candidates.map(candidate => ({ candidate, dates: {}, search: 1 })),
    ];
    const selected = selectTopicSources('Claim: UPI processed more than 24 billion transactions in August 2026.', entries);
    expect(selected).toHaveLength(8);
    expect(selected.every(entry => entry.candidate.sourceUrl.includes('report.example'))).toBe(true);
  });
});

it('inspects a metadata-poor returned annual report before deciding whether it is relevant', () => {
  const responses = [
    { link: 'https://agency.example.gov/publications/report', title: 'PIX adoption statistics', snippet: 'PIX empirical study' },
    { link: 'https://research.example.org/publication/7', title: 'PIX adoption annual report', snippet: 'PIX adoption study' },
    { link: 'https://bank.example.org/scripts/PublicationsView.aspx?Id=7', title: 'Annual Report' },
    { link: 'https://copies.example.org/doc', title: 'PIX statistics annual report', snippet: 'PIX adoption statistics' },
  ];
  const entries = normalizeSearchResponse({ organic_results: responses }, 'google_search', { retrievedAt: '2026-10-04' }).candidates.map(candidate => ({ candidate, dates: {}, search: 1 }));
  const selected = selectTopicSources('Why did PIX adoption grow quickly?', entries);
  expect(selected[2].candidate.sourceUrl).toContain('bank.example.org');
  expect(selected[2].candidate.snippet).toBeNull();
  expect(selected).toHaveLength(4);
});
