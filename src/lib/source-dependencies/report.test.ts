import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sample from '../../../scripts/fixtures/source-dependencies/sample.json';
import { sourceDependencyReport } from './report';
const fresh = () => structuredClone(sample);

describe('source dependency inspection on synthetic held-out evidence', () => {
  it('reports shared supplied citations and exact duplicate passages without declaring copying or independence', () => {
    const report = sourceDependencyReport(fresh());
    expect(report.sharedCitations).toHaveLength(1);
    expect(report.sharedCitations[0]?.evidenceIds).toEqual(['syndicated-a', 'syndicated-b']);
    expect(report.sharedCitations[0]?.dependency.status).toBe('inferred');
    expect(report.duplicatePassages).toHaveLength(1);
    expect(report.duplicatePassages[0]?.evidenceIds).toEqual(['syndicated-a', 'syndicated-b']);
    expect(report.duplicatePassages[0]?.copying.status).toBe('unknown');
    expect(report.independence.status).toBe('unknown');
  });
  it('keeps same-domain distinct documents separate and translated possible copying unknown', () => {
    const report = sourceDependencyReport(fresh());
    expect(report.sources.filter(s => s.url.startsWith('https://news-a.example/'))).toHaveLength(2);
    expect(report.duplicatePassages.some(g => g.evidenceIds.includes('translation'))).toBe(false);
    expect(report.limits.join(' ')).toContain('translation');
    expect(report.sources.find(s => s.url === 'https://study.example/results')?.evidenceIds).toEqual(['correction', 'study']);
  });
  it('separates exact quote support from contradictory context and claim entailment', () => {
    const report = sourceDependencyReport(fresh());
    const atOffset = report.citationChecks.find(c => c.citation.id === 'syndication-a');
    expect(atOffset?.quoteChecks.find(q => q.evidenceId === 'study')?.result).toBe('exact_match');
    expect(atOffset?.quoteChecks.find(q => q.evidenceId === 'correction')?.result).toBe('offset_mismatch');
    const anywhere = report.citationChecks.find(c => c.citation.id === 'syndication-b');
    expect(anywhere?.quoteChecks.find(q => q.evidenceId === 'correction')?.result).toBe('exact_match');
    expect(anywhere?.entailment.status).toBe('unknown');
    expect(anywhere?.documentCitationExistence.status).toBe('unknown');
  });
  it('returns unknown for reference-only targets, absent targets, and unsupplied quotes', () => {
    const report = sourceDependencyReport(fresh());
    expect(report.citationChecks.find(c => c.citation.id === 'appendix')?.quoteChecks[0]?.result).toBe('unknown');
    const missing = report.citationChecks.find(c => c.citation.id === 'missing');
    expect(missing?.sourceIdentity.status).toBe('unknown');
    expect(missing?.quoteCoverage.status).toBe('unknown');
    const input = fresh(); input.citations = input.citations.map(c => ({ ...c, quote: null }));
    expect(sourceDependencyReport(input).citationChecks.every(c => c.quoteChecks.every(q => q.result === 'unknown'))).toBe(true);
  });
  it('preserves literal offsets, case, whitespace and source query parameters', () => {
    const input = fresh();
    input.citations = [{ id: 'literal', fromEvidenceId: 'syndicated-a', targetUrl: 'https://study.example/results?edition=2', targetRole: 'primary', claimId: 'growth', quote: { text: 'every seed grew.', start: 0 } }];
    expect(sourceDependencyReport(input).citationChecks[0]?.sourceIdentity.status).toBe('unknown');
    const citation = input.citations[0];
    if (!citation) throw new Error('Missing fixture');
    citation.targetUrl = 'https://study.example/results';
    expect(sourceDependencyReport(input).citationChecks[0]?.quoteChecks.every(q => q.result === 'offset_mismatch')).toBe(true);
  });
  it('binds source corrections and keeps ids stable across reordered input', () => {
    const input = fresh(), before = sourceDependencyReport(input);
    input.caseRecord.evidence.reverse(); input.citations.reverse();
    expect(sourceDependencyReport(input)).toEqual(before);
    const study = input.caseRecord.evidence.find(e => e.id === 'study');
    if (!study || study.content.kind !== 'text') throw new Error('Missing fixture');
    study.content.text = 'Correction: only one seed grew.'; input.caseRecord.revision++;
    const after = sourceDependencyReport(input);
    expect(after.evidenceBindings.find(e => e.evidenceId === 'study')?.binding).not.toBe(before.evidenceBindings.find(e => e.evidenceId === 'study')?.binding);
    expect(after.citationChecks.find(c => c.citation.id === 'syndication-a')?.quoteChecks.find(q => q.evidenceId === 'study')?.result).toBe('offset_mismatch');
    expect(after.sharedCitations.map(g => g.id)).toEqual(before.sharedCitations.map(g => g.id));
  });
  it('rejects malformed citations and dangling references, without mutating input', () => {
    const input = fresh(), snapshot = JSON.stringify(input); sourceDependencyReport(input); expect(JSON.stringify(input)).toBe(snapshot);
    expect(() => sourceDependencyReport({ ...input, citations: [...input.citations, input.citations[0]] })).toThrow('Duplicate');
    for (const change of [{ fromEvidenceId: 'absent' }, { claimId: 'absent' }, { targetUrl: 'file:///tmp/x' }, { targetUrl: 'https://secret:password@example.org' }, { quote: { text: 'x', start: -1 } }, { quote: { text: '', start: 0 } }]) {
      expect(() => sourceDependencyReport({ ...input, citations: [{ ...input.citations[0], ...change }] })).toThrow();
    }
  });
  it('checks held-out literal excerpts without treating snippets or negation as proof', () => {
    const input = fresh();
    input.caseRecord.evidence = input.caseRecord.evidence.filter(e => e.id === 'study');
    const source = input.caseRecord.evidence[0];
    if (!source) throw new Error('Missing fixture');
    source.content = { kind: 'text', text: '🌱 The assertion "all flowers opened" is incorrect.', attribution: 'search_snippet' };
    input.citations = [{ id: 'held-out', fromEvidenceId: 'study', targetUrl: source.sourceUrl, targetRole: 'unspecified', claimId: 'growth', quote: { text: 'all flowers opened', start: 18 } }];
    const report = sourceDependencyReport(input);
    const check = report.citationChecks[0];
    expect(check?.quoteChecks[0]?.result).toBe('exact_match');
    expect(check?.quoteChecks[0]?.matchedStart).toBe(18);
    expect(check?.quoteChecks[0]).toHaveProperty('attribution', 'search_snippet');
    expect(check?.entailment.status).toBe('unknown');
    input.citations = input.citations.map(c => ({ ...c, quote: { text: 'all  flowers opened', start: null } }));
    expect(sourceDependencyReport(input).citationChecks[0]?.quoteChecks[0]?.result).toBe('not_found_in_retained_passage');
  });
  it('bounds expanded citation-to-target comparisons before producing an oversized report', () => {
    const input = fresh(), source = input.caseRecord.evidence[0], citation = input.citations[0];
    if (!source || !citation) throw new Error('Missing fixture');
    input.caseRecord.evidence = Array.from({ length: 101 }, (_, i) => ({ ...source, id: `target-${i}` }));
    input.citations = Array.from({ length: 100 }, (_, i) => ({ ...citation, id: `citation-${i}`, fromEvidenceId: 'target-0' }));
    expect(() => sourceDependencyReport(input)).toThrow('10000 citation-target checks');
  });
  it('runs the real CLI and returns inspectable JSON identical to the API', () => {
    const dir = mkdtempSync(join(tmpdir(), 'source-dependency-cli-'));
    try {
      execFileSync('node_modules/.bin/tsc', ['--module', 'commonjs', '--moduleResolution', 'node', '--target', 'ES2020', '--esModuleInterop', '--skipLibCheck', '--strict', '--outDir', dir, 'scripts/source-dependencies.ts']);
      const output = execFileSync(process.execPath, [join(dir, 'scripts/source-dependencies.js'), 'scripts/fixtures/source-dependencies/sample.json'], { encoding: 'utf8' });
      expect(JSON.parse(output)).toEqual(sourceDependencyReport(JSON.parse(readFileSync('scripts/fixtures/source-dependencies/sample.json', 'utf8'))));
      const savedInput = join(dir, 'saved-input.json'), savedReport = join(dir, 'saved-report.json');
      writeFileSync(savedInput, JSON.stringify(fresh())); writeFileSync(savedReport, output);
      const restoredOutput = execFileSync(process.execPath, [join(dir, 'scripts/source-dependencies.js'), savedInput], { encoding: 'utf8' });
      expect(JSON.parse(restoredOutput)).toEqual(JSON.parse(readFileSync(savedReport, 'utf8')));
      const corrected = fresh();
      const study = corrected.caseRecord.evidence.find(e => e.id === 'study');
      if (!study || study.content.kind !== 'text') throw new Error('Missing synthetic study');
      study.content.text = 'Correction: only one seed grew.'; corrected.caseRecord.revision++;
      writeFileSync(savedInput, JSON.stringify(corrected));
      const correctedOutput = execFileSync(process.execPath, [join(dir, 'scripts/source-dependencies.js'), savedInput], { encoding: 'utf8' });
      expect(JSON.parse(correctedOutput)).toEqual(sourceDependencyReport(corrected));
      expect(correctedOutput).not.toBe(restoredOutput);
      // Rechecking a corrected input does not mutate the previously saved report.
      expect(readFileSync(savedReport, 'utf8')).toBe(output);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);
});
