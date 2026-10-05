#!/usr/bin/env node
// Keep verification cases separate; never seed evidence or reset provider allowance.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','3221'], {
  stdio:'inherit', env:{...process.env,CONTEXTTRAIL_RESEARCH_DATA_DIR:resolve('data/judge-live-20261004/cases')}
});
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>child.kill(signal));
child.on('exit',code=>{process.exitCode=code ?? 1;});
