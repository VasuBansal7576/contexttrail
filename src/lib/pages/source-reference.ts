import { validatedHttpUrl } from './fetch';

/** Preserve query-addressed evidence identity. Omit unsafe links rather than rewrite them into another page. */
export function retainableSourceUrl(raw: string): string | null {
  if (raw.length > 4096) return null;
  const url = validatedHttpUrl(raw);
  if (!url) return null;
  const sensitiveParameter = /^(?:api[-_]?key|key|token|access[-_]?token|refresh[-_]?token|id[-_]?token|auth|authorization|password|passwd|pwd|secret|signature|sig|session(?:id|[-_]id)?|sid|code|samlresponse|x-amz-.+|x-goog-.+)$/i;
  if ([...url.searchParams.keys()].some(name => sensitiveParameter.test(name))) return null;
  const reference = url.toString();
  return reference.length <= 4096 ? reference : null;
}
