/** Browser-safe part of the persisted URL policy. No credential-bearing audit URLs. */
export function safeReferenceParameters(url: URL): boolean {
  const sensitiveParameter = /^(?:api[-_]?key|key|token|access[-_]?token|refresh[-_]?token|id[-_]?token|auth|authorization|password|passwd|pwd|secret|signature|sig|session(?:id|[-_]id)?|sid|code|samlresponse|x-amz-.+|x-goog-.+)$/i;
  return ![...url.searchParams.keys()].some(name => sensitiveParameter.test(name));
}
