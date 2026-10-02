import { validatedHttpUrl } from './fetch';
import { safeReferenceParameters } from './source-reference-policy';

/** Preserve query-addressed evidence identity. Omit unsafe links rather than rewrite them into another page. */
export function retainableSourceUrl(raw: string): string | null {
  if (raw.length > 4096) return null;
  const url = validatedHttpUrl(raw);
  if (!url) return null;
  if (!safeReferenceParameters(url)) return null;
  const reference = url.toString();
  return reference.length <= 4096 ? reference : null;
}
