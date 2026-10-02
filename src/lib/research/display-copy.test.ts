import { describe, expect, it } from 'vitest';
import { STAGES } from '../investigation/contracts/events';
import { researchLimitationCopy, researchProgressCopy, researchStageCopy } from './display-copy';

describe('automatic research display copy', () => {
  it('describes every stage without displaying implementation identifiers', () => {
    for (const stage of STAGES) {
      expect(researchStageCopy(stage)).not.toContain(stage);
      expect(researchStageCopy(stage)).not.toContain('unavailable');
      expect(researchProgressCopy(`Examining retrieved frame evidence: ${stage}…`)).toBe(researchStageCopy(stage));
    }
  });
  it('keeps unknown meaning honest and preserves ordinary topic progress and limitation prose', () => {
    expect(researchStageCopy('FUTURE_STAGE')).toContain('Details for this step are unavailable');
    expect(researchProgressCopy('Examining retrieved frame evidence: FUTURE_STAGE…')).toContain('Details for this step are unavailable');
    expect(researchLimitationCopy('new_unknown_limit')).toContain('meaning is unavailable');
    expect(researchLimitationCopy('Only one representative frame was searched.')).toBe('Only one representative frame was searched.');
    expect(researchProgressCopy('Reading source 2 of 6…')).toBe('Reading source 2 of 6…');
  });
});
