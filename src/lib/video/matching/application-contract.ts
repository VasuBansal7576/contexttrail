/** Browser-safe response types. No decoder, storage or provider implementation is imported. */
import type { FrameMatchReport, FrameReference, PreparedMatchFrame } from './model';

export type LocalComparisonFrame = FrameReference & Pick<PreparedMatchFrame, 'mimeType' | 'width' | 'height'> & { base64: string };
export type LocalComparisonResponse = {
  schemaVersion: 'contexttrail-local-media-comparison-v1';
  report: FrameMatchReport;
  frames: { left: LocalComparisonFrame[]; right: LocalComparisonFrame[] };
  persistence: { status: 'not_saved'; reason: string };
};
