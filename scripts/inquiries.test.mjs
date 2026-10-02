import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
it('runs the saved question, evidence, correction and reload journey through real CLI processes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'contexttrail-inquiry-'));
  try {
    const build = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '--module', 'commonjs', '--moduleResolution', 'node', '--target', 'ES2020', '--esModuleInterop', '--skipLibCheck', '--strict', '--outDir', dir, 'scripts/inquiries.ts'], { encoding: 'utf8' });
    expect(build.status, build.stdout + build.stderr).toBe(0);
    const state = join(dir, 'state.json'), cli = join(dir, 'scripts/inquiries.js');
    const run = name => spawnSync(process.execPath, [cli, state, name === '--show' ? name : resolve(`scripts/fixtures/inquiries/${name}.json`)], { encoding: 'utf8', env: { ...process.env, NODE_PATH: resolve('node_modules') } });
    for (const name of ['start', 'evidence', 'correction']) { const result = run(name); expect(result.status, result.stderr).toBe(0); }
    const saved = JSON.parse(readFileSync(state, 'utf8'));
    expect(saved.findings[0].reviewStatus).toBe('needs_review');
    expect(JSON.parse(run('--show').stdout)).toEqual(saved);
    const repeat = JSON.parse(run('correction').stdout); expect(repeat.notices).toEqual([]); expect(repeat.replayed).toBe(true);
    const before = readFileSync(state, 'utf8'); writeFileSync(`${state}.lock`, 'synthetic lock');
    expect(run('correction').status).toBe(1); expect(readFileSync(state, 'utf8')).toBe(before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 20000);
