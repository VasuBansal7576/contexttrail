import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { TopicCandidateAuditView } from './TopicCandidateAuditView';
import { SavedInvestigationCoverage } from './SavedInvestigationCoverage';
import { savedTopicFixture } from '@/lib/research/saved-topic-fixture';
import type { TopicCandidateAudit } from '@/lib/cases/topic-candidate-audit';
import type { TopicSearchFailure } from '@/lib/cases/topic-candidate-audit';

const audit: TopicCandidateAudit = { schemaVersion: 'contexttrail-topic-candidate-audit-v1', uniqueNormalizedCount: 104, safeReferenceCount: 103, withheldReferenceCount: 1, retainedCount: 1, notRetainedCount: 102, uncapturedSafeReferenceCount: 3,
  searches: [{ searchIndex: 0, outcome: 'succeeded', normalizedCount: 104, droppedBeforeNormalizationCount: 1, duplicateCount: 0 }],
  references: Array.from({ length: 100 }, (_, index) => ({ candidateId: index === 0 ? 'source' : `omitted-${index}`, sourceUrl: index === 0 ? 'https://example.com/original?id=1' : `https://example.com/omitted?id=${index + 1}`, searchIndex: 0, providerRank: index === 0 ? 1 : null, disposition: index === 0 ? 'retained' : 'not_retained' })) };
it('renders bounded audit and truncation honestly without authority or ranking claims', () => {
  vi.stubGlobal('React', React);
  try {
    const html = renderToStaticMarkup(React.createElement(TopicCandidateAuditView, { audit }));
    expect(html).toContain('103 safe references'); expect(html).toContain('3 safe references were not captured');
    expect(html).toContain('not verified sources, authority or answers'); expect(html).toContain('cannot replay lexical ranking');
    expect(html).toContain('https://example.com/omitted?id=2'); expect(html).toContain('Not retained as evidence');
    expect(html).not.toContain(' open=');
  } finally { vi.unstubAllGlobals(); }
});

it('explains captured failure categories and keeps old missing diagnoses explicitly unknown', () => {
  vi.stubGlobal('React', React);
  try {
    const failures: TopicSearchFailure[] = [
      { category: 'timeout', httpStatus: null }, { category: 'aborted', httpStatus: null },
      { category: 'http', httpStatus: 429 }, { category: 'network', httpStatus: null },
      { category: 'malformed', httpStatus: null }, { category: 'provider_reported', httpStatus: null },
      { category: 'unrecognized_surface', httpStatus: null }, { category: 'unconfigured', httpStatus: null },
      { category: 'unknown', httpStatus: null },
    ];
    const copies = ['search operation timed out', 'provider request was aborted', 'HTTP 429', 'network request could not complete', 'response was malformed', 'provider reported a search error', 'recognized completed result collection', 'provider configuration was unavailable', 'failure cause is unknown'];
    for (const [index, failure] of failures.entries()) {
      const snapshot = savedTopicFixture('original').caseRecord;
      snapshot.coverage.topicCandidateAudit = { ...audit, searches: [{ searchIndex: 0, outcome: 'unavailable', normalizedCount: null, droppedBeforeNormalizationCount: null, duplicateCount: null, failure }] };
      const live = renderToStaticMarkup(React.createElement(TopicCandidateAuditView, { audit: snapshot.coverage.topicCandidateAudit }));
      const saved = renderToStaticMarkup(React.createElement(SavedInvestigationCoverage, { snapshot, historical: true }));
      expect(live).toContain(copies[index]); expect(saved).toContain(copies[index]);
      expect(live).toContain('normalization and duplicate counts unknown');
    }
    const old = { ...audit, searches: [{ searchIndex: 0, outcome: 'unavailable', normalizedCount: null, droppedBeforeNormalizationCount: null, duplicateCount: null }] } satisfies TopicCandidateAudit;
    const html = renderToStaticMarkup(React.createElement(TopicCandidateAuditView, { audit: old }));
    expect(html).toContain('failure cause was not captured and remains unknown');
    expect(html).not.toContain('timed out');
  } finally { vi.unstubAllGlobals(); }
});
it('keeps older absent audit unknown, and displays only the supplied original snapshot', () => {
  vi.stubGlobal('React', React);
  try {
    const legacy = renderToStaticMarkup(React.createElement(TopicCandidateAuditView, { audit: undefined }));
    expect(legacy).toContain('omitted source pool remains unknown');
    const snapshot = savedTopicFixture('original').caseRecord; snapshot.coverage.topicCandidateAudit = audit;
    const historical = renderToStaticMarkup(React.createElement(SavedInvestigationCoverage, { snapshot, historical: true }));
    expect(historical).toContain('original historical report'); expect(historical).toContain('https://example.com/omitted?id=2');
    const unavailable = renderToStaticMarkup(React.createElement(SavedInvestigationCoverage, { snapshot: null, historical: true }));
    expect(unavailable).toContain('original investigation coverage snapshot was not retained'); expect(unavailable).not.toContain('https://example.com/omitted');
  } finally { vi.unstubAllGlobals(); }
});
