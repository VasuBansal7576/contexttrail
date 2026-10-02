import type { EvidenceCandidate } from './contracts/evidence';
import type { SourceLink } from '../pages/source-links';
import { canonicalizeUrl } from './url';
import { registrableDomain } from './domain';
import { unresolvedOrigin } from './reporting-origins';
import { retainableSourceUrl } from '../pages/source-reference';

/** A link proves an inspectable reference, never the identity of linked media.
 * Parent text/year/title is not the linked resource's snippet or publication date.
 */
export function candidateFromSourceLink(link: SourceLink, retrievedAt: string): EvidenceCandidate | null {
  const url = retainableSourceUrl(link.url);
  if (!url) return null;
  const canonical = canonicalizeUrl(url);
  if (!canonical) return null;
  const id = `link-${crypto.randomUUID()}`;
  return {
    id, retrievalKind: 'source_link', sourceUrl: url, canonicalUrl: canonical.canonicalUrl,
    domain: canonical.hostname, registrableDomain: registrableDomain(canonical.hostname) ?? canonical.hostname,
    title: null, snippet: null, serpPosition: null, serpSearchId: null,
    publishedAt: null, publishedAtSource: null, datePrecision: 'unknown', dateStatus: 'unknown',
    thumbnailUrl: null, resultImageUrl: null, mediaRelationship: null,
    identityEvidence: { basis: 'contextual', hashDistance: null, verifierVersion: null, verifierConfigId: null, verificationStatus: 'unavailable', comparisonMetrics: null },
    reportingOrigin: unresolvedOrigin(id), excerptSource: null, pageText: null, judgment: null,
    retrievals: [{ kind: 'source_link', searchId: null, resultType: 'source_link', retrievedAt }],
  };
}
