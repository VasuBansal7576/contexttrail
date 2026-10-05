export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startWatchWorker } = await import('./lib/monitor/service');
    startWatchWorker();
  }
}
