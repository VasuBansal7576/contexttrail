import { readFileSync, statSync } from 'node:fs';
import { sourceDependencyReport } from '../src/lib/source-dependencies/report';
try {
  const [path, ...rest] = process.argv.slice(2);
  if (!path || rest.length) throw new Error('Usage: npm run source-dependencies -- INPUT.json');
  if (statSync(path).size > 20 * 1024 * 1024) throw new Error('Input exceeds 20 MiB');
  const input: unknown = JSON.parse(readFileSync(path, 'utf8'));
  process.stdout.write(`${JSON.stringify(sourceDependencyReport(input), null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Source inspection failed'}\n`);
  process.exitCode = 1;
}
