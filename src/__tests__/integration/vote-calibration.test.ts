/**
 * Vote Calibration Integration Tests
 *
 * Deterministic tests for the REAL vote parsing + aggregation logic in `src/validation.ts`.
 * No LLM calls; we validate the threshold + median aggregation behavior.
 *
 * Run with: npm run test
 */

import { describe, it, expect } from 'vitest';
import { parseVoteResponse, aggregateVotesHCSP } from '../../validation.js';

function vote(
  model: string,
  critiques: Array<{ category: 'CRITICAL' | 'MAJOR' | 'MINOR' | 'PEDANTIC'; section?: string; issue: string }>,
  voteValue: 'synthesis_wins' | 'critique_wins' = 'synthesis_wins',
  reasoning: string = 'test'
) {
  return parseVoteResponse(JSON.stringify({ vote: voteValue, reasoning, critiques }), model);
}

describe('Sufficiency vote aggregation (HCSP)', () => {
  it('fails when CRITICAL issues exist even if all models vote synthesis_wins', () => {
    const votes = [
      vote('m1', [{ category: 'CRITICAL', section: 'overview', issue: 'No measurable success criteria' }], 'synthesis_wins'),
      vote('m2', [{ category: 'CRITICAL', section: 'overview', issue: 'Code is not executable' }], 'synthesis_wins'),
      vote('m3', [{ category: 'PEDANTIC', section: 'overview', issue: 'Verbose' }], 'synthesis_wins'),
    ];

    const result = aggregateVotesHCSP(votes);
    expect(result.sufficient).toBe(false);
    expect(result.hasCriticalGap).toBe(true);
    expect(result.criticalGaps).toContain('No measurable success criteria');
    expect(result.criticalGaps).toContain('Code is not executable');
    expect(result.stylisticPreferences).toContain('Verbose');
  });

  it('passes when critiques are only MINOR/PEDANTIC', () => {
    const votes = [
      vote('m1', [{ category: 'MINOR', section: 'overview', issue: 'Could be more concise' }]),
      vote('m2', [{ category: 'PEDANTIC', section: 'overview', issue: 'Typo' }]),
      vote('m3', []),
    ];

    const result = aggregateVotesHCSP(votes);
    expect(result.sufficient).toBe(true);
    expect(result.criticalGaps).toHaveLength(0);
  });

  it('fails when median MAJOR count >= 3 and there are no CRITICAL issues', () => {
    const major3 = [
      { category: 'MAJOR' as const, section: 'q1', issue: 'Gap A' },
      { category: 'MAJOR' as const, section: 'q1', issue: 'Gap B' },
      { category: 'MAJOR' as const, section: 'q1', issue: 'Gap C' },
    ];

    // Median of major counts across [3,3,0] => 3, should fail.
    const votes = [
      vote('m1', major3),
      vote('m2', major3),
      vote('m3', []),
    ];

    const result = aggregateVotesHCSP(votes);
    expect(result.sufficient).toBe(false);
    expect(result.failingSections).toContain('q1');
    expect(result.criticalGaps.length).toBeGreaterThan(0); // populated from MAJOR issues when they cause failure
  });

  it('does not fail due to a single-model MAJOR spike (median aggregation)', () => {
    const major3 = [
      { category: 'MAJOR' as const, section: 'q1', issue: 'Gap A' },
      { category: 'MAJOR' as const, section: 'q1', issue: 'Gap B' },
      { category: 'MAJOR' as const, section: 'q1', issue: 'Gap C' },
    ];

    // Median of major counts across [3,0,0] => 0, should pass.
    const votes = [
      vote('m1', major3),
      vote('m2', []),
      vote('m3', []),
    ];

    const result = aggregateVotesHCSP(votes);
    expect(result.sufficient).toBe(true);
  });

  it('handles empty votes array', () => {
    const result = aggregateVotesHCSP([]);
    expect(result.sufficient).toBe(true);
  });
});


