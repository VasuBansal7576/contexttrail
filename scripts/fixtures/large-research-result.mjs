import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** Synthetic data for bounded-rendering QA. Never calls a provider or opens a URL. */
export function createLargeResearchResult() {
  const evidence = Array.from({ length: 103 }, (_, index) => ({
    id: `offline-source-${index}`,
    sourceUrl: `https://example.com/offline/${index}?retained=${'x'.repeat(300)}`,
    title: `Offline source ${index + 1} — ${index === 0 ? 'VeryLongUnbrokenSourceTitle'.repeat(12) : 'A retained report with an inspectable source address'}`,
    content: {
      kind: 'text',
      text: 'Long retained source passage for offline layout verification. '.repeat(220) + ` FINAL RECORD ${index + 1}`,
      attribution: 'search_snippet',
    },
    publicationDate: { status: 'unknown', reason: 'Synthetic offline fixture.' },
    provenance: { method: 'retrieval', toolVersion: null, capturedAt: null, retrievedAt: null, rights: 'public_reference', retention: 'reference_only', contentHash: null },
  }));
  return {
    kind: 'topic',
    question: 'Offline layout verification: 103 sources and long retained passages',
    caseRecord: {
      schemaVersion: 'contexttrail-case-v1', id: 'offline-large-collection', revision: 1,
      createdAt: '2026-10-02T00:00:00Z', claims: [], assets: [], evidence, occurrences: [], relations: [],
      coverage: {
        scope: 'retrieved_evidence', completeness: 'partial', omittedEvidenceCount: 0,
        originalPublication: { status: 'unknown', reason: 'Offline layout fixture; no retrieval performed.' },
        limitations: ['Synthetic offline layout fixture. Not live research evidence.'], searches: [],
      },
    },
    frames: [], assessments: [], limitations: ['Synthetic offline fixture. No provider calls.'],
  };
}

// Emit on demand for browser QA: node scripts/fixtures/large-research-result.mjs > /tmp/large-research-result.json
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify(createLargeResearchResult(), null, 2) + '\n');
}
