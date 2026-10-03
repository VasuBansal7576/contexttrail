import { ProviderError } from '../providers/http';
import type { TopicSearchFailure } from '../cases/topic-candidate-audit';

/** Carries only a classification of an already rejected response, never its body. */
export class TopicSearchResponseError extends Error {
  readonly failure: TopicSearchFailure;
  constructor(response: unknown) {
    super('Topic search response unavailable.');
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      this.failure = { category: 'malformed', httpStatus: null };
      return;
    }
    const metadata = 'search_metadata' in response ? response.search_metadata : null;
    const providerReported = ('error' in response && typeof response.error === 'string' && response.error.length > 0)
      || (metadata && typeof metadata === 'object' && 'status' in metadata && metadata.status === 'Error');
    this.failure = { category: providerReported ? 'provider_reported' : 'unrecognized_surface', httpStatus: null };
  }
}

/** No stringification or copying of messages, causes, URLs or untyped kind fields. */
export function topicSearchFailure(error: unknown): TopicSearchFailure {
  if (error instanceof TopicSearchResponseError) return error.failure;
  if (error instanceof ProviderError) {
    switch (error.kind) {
      case 'http':
        if (typeof error.status === 'number' && Number.isInteger(error.status) && error.status >= 100 && error.status <= 599) {
          return { category: 'http', httpStatus: error.status };
        }
        return { category: 'unknown', httpStatus: null };
      case 'timeout': case 'aborted': case 'network': case 'malformed': case 'unconfigured':
        return { category: error.kind, httpStatus: null };
      default: {
        const exhaustive: never = error.kind; void exhaustive;
        return { category: 'unknown', httpStatus: null };
      }
    }
  }
  return { category: 'unknown', httpStatus: null };
}
