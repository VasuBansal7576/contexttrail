#!/usr/bin/env node
/** Offline initialization only. No keys are read, and no network calls are made. */
import { constants } from 'node:fs';
import { open, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

function cap(name) {
  const value = process.env[name];
  if (!/^(0|[1-9]\d*)$/.test(value ?? '') || !Number.isSafeInteger(Number(value))) {
    throw new Error('Every allowance must be an explicit, nonnegative safe integer');
  }
  return Number(value);
}

async function initialize() {
  if (process.env.CONTEXTTRAIL_LIVE_DEPLOYMENT !== 'single-host-persistent' ||
      process.env.CONTEXTTRAIL_FREE_ALLOWANCE_ACKNOWLEDGED !== 'true' ||
      ['VERCEL', 'VERCEL_ENV', 'NETLIFY', 'AWS_LAMBDA_FUNCTION_NAME', 'AWS_EXECUTION_ENV',
       'FUNCTIONS_WORKER_RUNTIME', 'K_SERVICE', 'CLOUD_RUN_JOB'].some(key => process.env[key] !== undefined)) {
    throw new Error('Initialization requires acknowledged free allowances and single-host persistent storage; serverless is unsupported');
  }
  if (process.env.TYPESAFE_MODEL !== undefined && process.env.TYPESAFE_MODEL !== 'jev-1.13.0') {
    throw new Error('A nonpinned Jev model is not supported');
  }
  const path = process.env.CONTEXTTRAIL_USAGE_LEDGER_PATH;
  const period = process.env.CONTEXTTRAIL_FREE_ALLOWANCE_PERIOD;
  if (!path || !isAbsolute(path) || path !== resolve(path) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(period ?? '')) {
    throw new Error('An absolute normalized ledger path and explicit period are required');
  }
  const parent = await realpath(dirname(path));
  if (join(parent, basename(path)) !== path ||
      ['/tmp', '/var/tmp', '/dev', '/proc', '/sys', '/run'].some(root => parent === root || parent.startsWith(`${root}/`))) {
    throw new Error('Use an existing persistent local directory, not an ephemeral or symlinked directory');
  }
  // This format is checked against the runtime reader by live-usage.test.ts.
  const header = {
    type: 'contexttrail-live-usage', version: 1, model: 'jev-1.13.0', period,
    allowance: {
      searches: cap('CONTEXTTRAIL_FREE_SERPAPI_SEARCHES'),
      uploads: cap('CONTEXTTRAIL_FREE_SERPAPI_UPLOADS'),
      jevRequests: cap('CONTEXTTRAIL_FREE_JEV_REQUESTS'),
      jevQuestions: cap('CONTEXTTRAIL_FREE_JEV_QUESTIONS'),
    },
  };
  const lockPath = `${path}.lock`;
  const lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const token = randomUUID();
  let ledger;
  let appendStarted = false;
  try {
    await lock.writeFile(token);
    await lock.sync();
    const directory = await open(parent, constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
    ledger = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    appendStarted = true;
    await ledger.writeFile(`${JSON.stringify(header)}\n`);
    await ledger.sync();
    const directoryAfter = await open(parent, constants.O_RDONLY);
    try { await directoryAfter.sync(); } finally { await directoryAfter.close(); }
    await ledger.close();
    ledger = undefined;
    await unlink(lockPath);
    console.info('Created an empty usage ledger. Live use is still controlled by server configuration. No provider balance or billing guarantee was verified.');
  } catch (error) {
    await ledger?.close().catch(() => undefined);
    // Never reset an existing ledger. Uncertain creation leaves the lock intact.
    if (!appendStarted) await unlink(lockPath).catch(() => undefined);
    throw error;
  } finally {
    await lock.close();
  }
}

initialize().catch(() => {
  console.error('Usage ledger initialization refused or failed. Existing state was not reset. Inspect configuration, directory permissions, and any retained lock.');
  process.exitCode = 1;
});
