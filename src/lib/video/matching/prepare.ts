import { createHash } from 'node:crypto';
import { prepareVideo, sampleTimes, VIDEO_LIMITS } from '../ingest';
import { decodeMatchImage } from './decode';
import { FrameMatchError, MATCH_LIMITS, type LocalMediaInput, type PreparedMatchMedia } from './model';

/** Rights attestation comes from the caller, not from content analysis. No input path reaches a decoder. */
export async function prepareMatchMedia(input: LocalMediaInput, options: { signal?: AbortSignal } = {}): Promise<PreparedMatchMedia> {
  if (input.rights !== 'user_provided') throw new FrameMatchError('rights_required');
  if (input.kind !== 'image' && input.kind !== 'video') throw new FrameMatchError('invalid_image');
  if (input.bytes.byteLength > (input.kind === 'video' ? VIDEO_LIMITS.bytes : MATCH_LIMITS.imageBytes)) throw new FrameMatchError('limit_exceeded');
  if (options.signal?.aborted) throw new FrameMatchError('cancelled');
  // Snapshot before awaiting so caller mutation cannot change the bytes behind a hash.
  const bytes = Buffer.from(input.bytes);
  if (input.kind === 'image') {
    const decoded = await decodeMatchImage(bytes, options.signal);
    const contentHash = createHash('sha256').update(bytes).digest('hex'), mediaId = `image:sha256:${contentHash}`;
    return { mediaId, contentHash, coverage: { kind: 'still_image', fullImageDecoded: true }, frames: [{ ...decoded, mediaId, frameId: `${mediaId}:still`, timestampMs: null, contentHash, bytes }] };
  }
  const video = await prepareVideo(bytes, options), frames = [];
  for (const frame of video.frames) {
    const decoded = await decodeMatchImage(frame.bytes, options.signal);
    frames.push({ ...decoded, mediaId: frame.mediaId, frameId: frame.id, contentHash: frame.contentHash, timestampMs: frame.timestampMs, bytes: frame.bytes });
  }
  const times = frames.map(frame => frame.timestampMs), endpoints = [0, ...times, video.durationMs];
  return {
    mediaId: video.mediaId, contentHash: video.contentHash, frames,
    coverage: { kind: 'sampled_video', durationMs: video.durationMs, requestedTimestampsMs: sampleTimes(video.durationMs), decodedTimestampsMs: times, sampleCount: times.length, largestUnsampledGapMs: Math.max(...endpoints.slice(1).map((time, index) => time - endpoints[index])), temporalCoverageFraction: null, audioAnalyzed: false },
  };
}
