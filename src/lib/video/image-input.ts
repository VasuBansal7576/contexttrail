import type { InvestigationInput } from '../investigation/contracts/investigation';
import type { VideoFrame } from './ingest';

/** Prepare one image request without running it or inheriting public-URL bypasses.
 * Callers must apply the existing provider consent/usage checks separately to
 * every frame; three sampled frames do not create three independent sources.
 */
export function imageInputForFrame(frame: VideoFrame, context: Pick<InvestigationInput, 'claim' | 'timezone' | 'locale'>): {
  input: InvestigationInput;
  source: { mediaId: string; frameId: string; timestampMs: number; contentHash: string };
} {
  return {
    input: { media: frame.bytes, claim: context.claim, timezone: context.timezone, locale: context.locale },
    source: { mediaId: frame.mediaId, frameId: frame.id, timestampMs: frame.timestampMs, contentHash: frame.contentHash },
  };
}
