/** Coverage is outside the claim evidence binding; fallback evidence is not original coverage. */
export type ClaimReportCaseOrigin = 'retained_snapshot' | 'legacy_fallback';
export function claimReportCaseOrigin(value: unknown, hasSnapshot: boolean): ClaimReportCaseOrigin {
  if (value === undefined) return hasSnapshot ? 'retained_snapshot' : 'legacy_fallback';
  if (value !== 'retained_snapshot' && value !== 'legacy_fallback') throw new Error('Invalid claim report case origin');
  if (value === 'retained_snapshot' && !hasSnapshot) throw new Error('Retained claim report case origin requires a snapshot');
  return value;
}
