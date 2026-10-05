import { ResearchServiceError } from './service';
import { ownerId } from '../hosted/context';
export function requireLocalResearchRequest(request: Request): void {
  try { ownerId(); } catch { throw new ResearchServiceError(401, 'SIGN_IN_REQUIRED', 'Sign in with ChatGPT to investigate and keep your cases.'); }
  const origin = request.headers.get('origin');
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new ResearchServiceError(403, 'ORIGIN_REJECTED', 'Cross-origin research requests are not allowed.');
  }
}
