import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

describe('manual watchlist CLI', () => {
  it('persists a correction, suppresses replay, keeps state on error and respects writer lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'contexttrail-watchlist-test-'));
    try {
      const build = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '--module', 'commonjs', '--moduleResolution', 'node', '--target', 'ES2020', '--esModuleInterop', '--skipLibCheck', '--strict', '--outDir', dir, 'scripts/watchlists.ts'], { encoding: 'utf8' });
      expect(build.status, build.stdout + build.stderr).toBe(0);
      const cli = join(dir, 'scripts/watchlists.js'), state = join(dir, 'state.json');
      const run = request => spawnSync(process.execPath, [cli, state, request], { encoding: 'utf8' });
      const first = run(resolve('scripts/fixtures/watchlists/initial.json'));
      expect(first.status, first.stderr).toBe(0); expect(JSON.parse(first.stdout).notices).toHaveLength(1);
      const correction = run(resolve('scripts/fixtures/watchlists/correction.json'));
      expect(correction.status, correction.stderr).toBe(0); expect(JSON.parse(correction.stdout).notices).toHaveLength(1);
      const saved = JSON.parse(readFileSync(state, 'utf8'));
      expect(saved.collection.caseHistory).toHaveLength(1); expect(saved.notices[0].evidence[0].after.content.text).toContain('Correction:');
      expect(JSON.parse(run('--show').stdout)).toEqual(saved);
      const repeat = run(resolve('scripts/fixtures/watchlists/correction.json'));
      expect(repeat.status).toBe(0); expect(JSON.parse(repeat.stdout).notices).toEqual([]);
      const before = readFileSync(state, 'utf8');
      const stale = run(resolve('scripts/fixtures/watchlists/initial.json'));
      expect(stale.status).toBe(1); expect(readFileSync(state, 'utf8')).toBe(before);
      writeFileSync(`${state}.lock`, 'test lock');
      expect(run(resolve('scripts/fixtures/watchlists/correction.json')).status).toBe(1);
      expect(readFileSync(state, 'utf8')).toBe(before);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 20000);
});
