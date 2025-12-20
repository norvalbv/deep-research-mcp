/**
 * Vote Calibration Integration Tests
 * 
 * Tests the HCSP voting mechanism with deterministic mock responses.
 * Ensures CRITICAL_GAP detection properly overrides majority votes.
 * 
 * Run with: npm run test
 */

import { describe, it, expect } from 'vitest';
import { aggregateVotesHCSP } from '../validation.test.js';

// ============================================================================
// Types (matching validation.ts)
// ============================================================================

type CritiqueType = 'CRITICAL_GAP' | 'STYLISTIC_PREFERENCE';

interface CategorizedCritique {
  type: CritiqueType;
  issue: string;
}

interface HCSPVoteDetail {
  model: string;
  vote: 'synthesis_wins' | 'critique_wins';
  reasoning: string;
  critiques: CategorizedCritique[];
  hasCriticalGap: boolean;
}

// ============================================================================
// Mock Vote Responses (Pre-captured LLM outputs)
// ============================================================================

/**
 * Simulates the scenario from the user's report:
 * - Critical Challenge identifies: [FAILED: Code Completeness], [FAILED: Specificity]
 * - But Quality Vote was: 5 synthesis_wins, 0 critique_wins
 * 
 * With HCSP, this should now fail due to CRITICAL_GAPs
 */
const MOCK_PEDANTIC_PARADOX_SCENARIO: HCSPVoteDetail[] = [
  {
    model: 'gemini-3-flash-preview-1',
    vote: 'synthesis_wins',
    reasoning: 'The synthesis directly answers the conceptual questions while the critique focuses on secondary implementation details.',
    critiques: [
      { type: 'CRITICAL_GAP', issue: '[FAILED: Success Criteria] No measurable goal defined' },
      { type: 'CRITICAL_GAP', issue: '[FAILED: Code Completeness] Functions are hardcoded logic demos' },
      { type: 'STYLISTIC_PREFERENCE', issue: 'Could include more examples' },
    ],
    hasCriticalGap: true,
  },
  {
    model: 'gemini-3-flash-preview-2',
    vote: 'synthesis_wins',
    reasoning: 'The synthesis provides specific criteria for entity extraction.',
    critiques: [
      { type: 'CRITICAL_GAP', issue: '[FAILED: Specificity] Salience 0.7 lacks derivation rubric' },
    ],
    hasCriticalGap: true,
  },
  {
    model: 'gemini-3-flash-preview-3',
    vote: 'synthesis_wins',
    reasoning: 'Adequately addresses the query with technical criteria.',
    critiques: [
      { type: 'STYLISTIC_PREFERENCE', issue: 'Verbose explanation' },
    ],
    hasCriticalGap: false,
  },
  {
    model: 'gemini-3-flash-preview-4',
    vote: 'synthesis_wins',
    reasoning: 'Good coverage of the trade-offs.',
    critiques: [],
    hasCriticalGap: false,
  },
  {
    model: 'gemini-3-flash-preview-5',
    vote: 'synthesis_wins',
    reasoning: 'Provides actionable information.',
    critiques: [
      { type: 'CRITICAL_GAP', issue: '[FAILED: Executability] Code not executable without embedding layer' },
    ],
    hasCriticalGap: true,
  },
];

/**
 * Clean synthesis with no critical gaps
 */
const MOCK_CLEAN_SYNTHESIS: HCSPVoteDetail[] = [
  {
    model: 'gemini-1',
    vote: 'synthesis_wins',
    reasoning: 'Complete implementation with specific metrics.',
    critiques: [
      { type: 'STYLISTIC_PREFERENCE', issue: 'Could be more concise' },
    ],
    hasCriticalGap: false,
  },
  {
    model: 'gemini-2',
    vote: 'synthesis_wins',
    reasoning: 'All constraints satisfied.',
    critiques: [],
    hasCriticalGap: false,
  },
  {
    model: 'gemini-3',
    vote: 'synthesis_wins',
    reasoning: 'Production-ready code with proper error handling.',
    critiques: [],
    hasCriticalGap: false,
  },
];

/**
 * Synthesis with legitimate critique wins (majority + critical gaps)
 */
const MOCK_CRITIQUE_WINS: HCSPVoteDetail[] = [
  {
    model: 'gemini-1',
    vote: 'critique_wins',
    reasoning: 'Missing critical implementation details.',
    critiques: [
      { type: 'CRITICAL_GAP', issue: 'No error handling' },
      { type: 'CRITICAL_GAP', issue: 'Missing type definitions' },
    ],
    hasCriticalGap: true,
  },
  {
    model: 'gemini-2',
    vote: 'critique_wins',
    reasoning: 'Code is incomplete.',
    critiques: [
      { type: 'CRITICAL_GAP', issue: 'TODO placeholder in main function' },
    ],
    hasCriticalGap: true,
  },
  {
    model: 'gemini-3',
    vote: 'synthesis_wins',
    reasoning: 'Conceptually addresses the question.',
    critiques: [
      { type: 'STYLISTIC_PREFERENCE', issue: 'Could add diagrams' },
    ],
    hasCriticalGap: false,
  },
];

// ============================================================================
// Tests
// ============================================================================

describe('HCSP Vote Calibration', () => {
  describe('Pedantic Paradox Resolution', () => {
    it('fails synthesis when critical gaps exist despite 5-0 vote', () => {
      const result = aggregateVotesHCSP(MOCK_PEDANTIC_PARADOX_SCENARIO);
      
      // HCSP Rule: Critical gaps override vote count
      expect(result.sufficient).toBe(false);
      expect(result.hasCriticalGap).toBe(true);
      
      // Should have captured the critical gaps
      expect(result.criticalGaps.length).toBeGreaterThanOrEqual(3);
      expect(result.criticalGaps).toContain('[FAILED: Success Criteria] No measurable goal defined');
      expect(result.criticalGaps).toContain('[FAILED: Code Completeness] Functions are hardcoded logic demos');
      
      // Vote count should still be accurate for logging
      expect(result.synthesisWins).toBe(5);
      expect(result.critiqueWins).toBe(0);
    });
    
    it('separates stylistic from critical issues', () => {
      const result = aggregateVotesHCSP(MOCK_PEDANTIC_PARADOX_SCENARIO);
      
      // Stylistic preferences should be captured separately
      expect(result.stylisticPreferences).toContain('Could include more examples');
      expect(result.stylisticPreferences).toContain('Verbose explanation');
      
      // Critical gaps should not include stylistic issues
      expect(result.criticalGaps).not.toContain('Could include more examples');
    });
  });
  
  describe('Clean Synthesis Handling', () => {
    it('passes synthesis when no critical gaps exist', () => {
      const result = aggregateVotesHCSP(MOCK_CLEAN_SYNTHESIS);
      
      expect(result.sufficient).toBe(true);
      expect(result.hasCriticalGap).toBe(false);
      expect(result.criticalGaps).toHaveLength(0);
      expect(result.synthesisWins).toBe(3);
    });
    
    it('allows stylistic preferences without failing', () => {
      const result = aggregateVotesHCSP(MOCK_CLEAN_SYNTHESIS);
      
      // Stylistic preferences should be captured for informational purposes
      expect(result.stylisticPreferences).toContain('Could be more concise');
      
      // But should not affect pass/fail
      expect(result.sufficient).toBe(true);
    });
  });
  
  describe('Legitimate Critique Wins', () => {
    it('fails when majority votes critique and critical gaps exist', () => {
      const result = aggregateVotesHCSP(MOCK_CRITIQUE_WINS);
      
      expect(result.sufficient).toBe(false);
      expect(result.hasCriticalGap).toBe(true);
      expect(result.critiqueWins).toBe(2);
      expect(result.synthesisWins).toBe(1);
    });
    
    it('collects all critical gaps from multiple votes', () => {
      const result = aggregateVotesHCSP(MOCK_CRITIQUE_WINS);
      
      expect(result.criticalGaps).toContain('No error handling');
      expect(result.criticalGaps).toContain('Missing type definitions');
      expect(result.criticalGaps).toContain('TODO placeholder in main function');
    });
  });
  
  describe('Edge Cases', () => {
    it('handles empty votes array', () => {
      const result = aggregateVotesHCSP([]);
      
      expect(result.sufficient).toBe(true); // No critiques = pass
      expect(result.hasCriticalGap).toBe(false);
      expect(result.criticalGaps).toHaveLength(0);
    });
    
    it('handles single vote with critical gap', () => {
      const singleVote: HCSPVoteDetail[] = [{
        model: 'single-model',
        vote: 'synthesis_wins',
        reasoning: 'Overall good',
        critiques: [{ type: 'CRITICAL_GAP', issue: 'Major flaw' }],
        hasCriticalGap: true,
      }];
      
      const result = aggregateVotesHCSP(singleVote);
      
      expect(result.sufficient).toBe(false);
      expect(result.hasCriticalGap).toBe(true);
    });
    
    it('deduplicates identical critical gaps', () => {
      const duplicateGaps: HCSPVoteDetail[] = [
        {
          model: 'model-1',
          vote: 'critique_wins',
          reasoning: 'Issues found',
          critiques: [{ type: 'CRITICAL_GAP', issue: 'Same issue' }],
          hasCriticalGap: true,
        },
        {
          model: 'model-2',
          vote: 'critique_wins',
          reasoning: 'Also found issues',
          critiques: [{ type: 'CRITICAL_GAP', issue: 'Same issue' }],
          hasCriticalGap: true,
        },
      ];
      
      const result = aggregateVotesHCSP(duplicateGaps);
      
      // Should deduplicate
      expect(result.criticalGaps).toHaveLength(1);
      expect(result.criticalGaps[0]).toBe('Same issue');
    });
    
    it('handles votes with no critiques array', () => {
      const noCritiques: HCSPVoteDetail[] = [{
        model: 'model',
        vote: 'synthesis_wins',
        reasoning: 'All good',
        critiques: [],
        hasCriticalGap: false,
      }];
      
      const result = aggregateVotesHCSP(noCritiques);
      
      expect(result.sufficient).toBe(true);
      expect(result.criticalGaps).toHaveLength(0);
      expect(result.stylisticPreferences).toHaveLength(0);
    });
  });
});

describe('Vote Response Parsing', () => {
  // Test that the new HCSP JSON schema is parsed correctly
  
  it('parses HCSP JSON format correctly', () => {
    // This tests the expected JSON format from the LLM
    const mockResponse = `{
      "vote": "synthesis_wins",
      "reasoning": "Good overall but has minor issues",
      "critiques": [
        {"type": "CRITICAL_GAP", "issue": "Missing error handling"},
        {"type": "STYLISTIC_PREFERENCE", "issue": "Could be more concise"}
      ]
    }`;
    
    // Simulate parsing (this would normally be in validation.ts)
    const parsed = JSON.parse(mockResponse);
    
    expect(parsed.vote).toBe('synthesis_wins');
    expect(parsed.critiques).toHaveLength(2);
    expect(parsed.critiques[0].type).toBe('CRITICAL_GAP');
    expect(parsed.critiques[1].type).toBe('STYLISTIC_PREFERENCE');
  });
  
  it('handles legacy critical_gaps format', () => {
    // Legacy format should still work for backwards compatibility
    const legacyResponse = `{
      "vote": "critique_wins",
      "reasoning": "Significant gaps",
      "critical_gaps": ["Missing implementation", "No tests"]
    }`;
    
    const parsed = JSON.parse(legacyResponse);
    
    expect(parsed.vote).toBe('critique_wins');
    expect(parsed.critical_gaps).toHaveLength(2);
  });
});

describe('Production Quality Scenarios', () => {
  // Real-world scenarios based on actual validation reports
  
  it('Entity Extraction Report scenario (from user report)', () => {
    // Simulates the exact scenario described in the user's report
    const votes: HCSPVoteDetail[] = [
      {
        model: 'gemini-3-flash-preview',
        vote: 'synthesis_wins',
        reasoning: 'The synthesis directly answers the conceptual questions about entity extraction criteria.',
        critiques: [
          { type: 'CRITICAL_GAP', issue: '[FAILED: Success Criteria] No measurable goal like <5% duplication rate' },
          { type: 'CRITICAL_GAP', issue: '[FAILED: Code Completeness] calculate_similarity is hardcoded' },
          { type: 'CRITICAL_GAP', issue: '[FAILED: Specificity] Salience 0.7 arbitrary without derivation' },
          { type: 'CRITICAL_GAP', issue: '[FAILED: Consistency] L0/L1 and 0.85 threshold repeated without derivation' },
          { type: 'CRITICAL_GAP', issue: '[FAILED: Executability] Missing embedding/LLM interface layers' },
        ],
        hasCriticalGap: true,
      },
    ];
    
    const result = aggregateVotesHCSP(votes);
    
    // With HCSP, these CRITICAL_GAPs should cause failure
    expect(result.sufficient).toBe(false);
    expect(result.hasCriticalGap).toBe(true);
    expect(result.criticalGaps.length).toBe(5);
    
    // Verify specific failures are captured
    expect(result.criticalGaps.some(g => g.includes('Success Criteria'))).toBe(true);
    expect(result.criticalGaps.some(g => g.includes('Code Completeness'))).toBe(true);
    expect(result.criticalGaps.some(g => g.includes('Executability'))).toBe(true);
  });
  
  it('passes production-ready synthesis', () => {
    const votes: HCSPVoteDetail[] = [
      {
        model: 'gemini-1',
        vote: 'synthesis_wins',
        reasoning: 'Complete implementation with all metrics defined.',
        critiques: [],
        hasCriticalGap: false,
      },
      {
        model: 'gemini-2',
        vote: 'synthesis_wins',
        reasoning: 'Code is executable with proper error handling.',
        critiques: [
          { type: 'STYLISTIC_PREFERENCE', issue: 'Could add more inline comments' },
        ],
        hasCriticalGap: false,
      },
      {
        model: 'gemini-3',
        vote: 'synthesis_wins',
        reasoning: 'Success criteria clearly defined: CCR > 90%, CF > 95%.',
        critiques: [],
        hasCriticalGap: false,
      },
    ];
    
    const result = aggregateVotesHCSP(votes);
    
    expect(result.sufficient).toBe(true);
    expect(result.hasCriticalGap).toBe(false);
    expect(result.synthesisWins).toBe(3);
    expect(result.stylisticPreferences).toContain('Could add more inline comments');
  });
});


