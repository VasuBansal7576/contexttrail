import { runTopicCoverageBenchmark } from './fixtures/topic-coverage/benchmark';
runTopicCoverageBenchmark().then(result => process.stdout.write(JSON.stringify(result, null, 2) + '\n')).catch(() => { process.stderr.write('Offline topic coverage benchmark failed.\n'); process.exitCode = 1; });
