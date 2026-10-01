import { ResearchServiceError } from './service';

/** Disabled by default. Bind the opt-in server to loopback; this is not hosted multi-user storage. */
export function requireLocalResearchRequest(request: Request): void {
  if (process.env.CONTEXTTRAIL_RESEARCH_LOCAL !== '1') throw new ResearchServiceError(503, 'LOCAL_SERVICE_DISABLED', 'Local research storage is disabled. No case was read or changed.');
  const url = new URL(request.url);
  // Next may rebuild request.url using the bound hostname, so check the original Host too.
  const host = request.headers.get('host') ?? url.host;
  let requestedOrigin: URL;
  try { requestedOrigin = new URL(`${url.protocol}//${host}`); }
  catch { throw new ResearchServiceError(403, 'LOCAL_ONLY', 'Invalid local request host.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'];
  if (!loopback.includes(url.hostname) || !loopback.includes(requestedOrigin.hostname) || requestedOrigin.host.toLowerCase() !== host.toLowerCase() || requestedOrigin.username || requestedOrigin.password || requestedOrigin.pathname !== '/' || requestedOrigin.search || requestedOrigin.hash) throw new ResearchServiceError(403, 'LOCAL_ONLY', 'Research storage is available only through the local loopback server.');
  // Prevent a third-party browser page from reading or changing local cases.
  const origin = request.headers.get('origin');
  if ((origin && origin !== requestedOrigin.origin) || request.headers.get('sec-fetch-site') === 'cross-site') throw new ResearchServiceError(403, 'ORIGIN_REJECTED', 'Cross-origin research requests are not allowed.');
}
