import { canonicalizeUrl } from '../investigation/url';
import { retainableSourceUrl } from './source-reference';

export type SourceBinding = 'same_resource' | 'normalized_resource' | 'different_resource' | 'blocked_destination' | 'not_established';

/** A redirect is not proof that a media occurrence moved to another work.
 * Only the existing conservative URL normalization and HTTPS upgrade bind.
 * Semantic query parameters, paths, cross-host moves and HTTPS downgrades do not.
 */
export function bindFetchedSource(requested: string, final: string): SourceBinding {
  const requestedUrl = retainableSourceUrl(requested);
  const finalUrl = retainableSourceUrl(final);
  if (!requestedUrl || !finalUrl) return 'not_established';
  const target = new URL(finalUrl);
  if (/(?:^|\/)(?:login|log-in|signin|sign-in|auth|unsupportedbrowser|unsupported-browser|browser-support|error|404)(?:\/|$)/i.test(target.pathname)) return 'blocked_destination';
  if (requestedUrl === finalUrl) return 'same_resource';
  const from = canonicalizeUrl(requestedUrl);
  const to = canonicalizeUrl(finalUrl);
  if (!from || !to) return 'not_established';
  const source = new URL(from.canonicalUrl);
  const destination = new URL(to.canonicalUrl);
  if (source.protocol === 'http:' && destination.protocol === 'https:') source.protocol = 'https:';
  return source.toString() === destination.toString() ? 'normalized_resource' : 'different_resource';
}
