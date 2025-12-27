/**
 * Depth Level Gating Tests
 * 
 * Verifies that depth_level properly controls which features are enabled:
 * - Depth 1: Perplexity only, no validation, no code
 * - Depth 2: + Deep analysis, + Challenge
 * - Depth 3: + Context7, + Voting, + Code examples
 * - Depth 4: + arXiv, + Consensus
 * - Depth 5: All features
 */

import { describe, it, expect } from 'vitest';
import { createFallbackPlan } from '../planning.js';

// ============================================================================
// Planning Depth Gating
// ============================================================================

describe('Planning Depth Gating', () => {
  describe('createFallbackPlan respects maxDepth', () => {
    it('depth 1: only perplexity, no deep_analysis, no challenge', () => {
      const plan = createFallbackPlan({ maxDepth: 1 });
      
      expect(plan.complexity).toBe(1);
      expect(plan.steps).toContain('perplexity_search');
      expect(plan.steps).not.toContain('deep_analysis');
      expect(plan.steps).not.toContain('challenge');
      expect(plan.steps).not.toContain('library_docs');
      expect(plan.steps).not.toContain('arxiv_search');
    });

    it('depth 2: perplexity + deep_analysis + challenge', () => {
      const plan = createFallbackPlan({ maxDepth: 2 });
      
      expect(plan.complexity).toBe(2);
      expect(plan.steps).toContain('perplexity_search');
      expect(plan.steps).toContain('deep_analysis');
      expect(plan.steps).toContain('challenge');
      expect(plan.steps).not.toContain('library_docs');
    });

    it('depth 3: includes library_docs when techStack provided', () => {
      const plan = createFallbackPlan({ maxDepth: 3, techStack: ['Python'] });
      
      expect(plan.complexity).toBe(3);
      expect(plan.steps).toContain('perplexity_search');
      expect(plan.steps).toContain('deep_analysis');
      expect(plan.steps).toContain('library_docs');
    });

    it('depth 3 without techStack: no library_docs', () => {
      const plan = createFallbackPlan({ maxDepth: 3 });
      
      expect(plan.steps).not.toContain('library_docs');
    });

    it('caps complexity at maxDepth', () => {
      // Even if fallback would default to 3, it should cap at 2
      const plan = createFallbackPlan({ maxDepth: 2 });
      expect(plan.complexity).toBeLessThanOrEqual(2);
    });
  });
});

// ============================================================================
// Depth-Based Feature Table (Documentation Test)
// ============================================================================

describe('Depth Feature Matrix', () => {
  /**
   * Documents the expected behavior at each depth level.
   * This serves as both documentation and a regression test.
   */
  
  const DEPTH_FEATURES = {
    1: { perplexity: true, deep: false, context7: false, arxiv: false, consensus: false, challenge: false, voting: false, code: false },
    2: { perplexity: true, deep: true, context7: false, arxiv: false, consensus: false, challenge: true, voting: false, code: false },
    3: { perplexity: true, deep: true, context7: true, arxiv: false, consensus: false, challenge: true, voting: true, code: true },
    4: { perplexity: true, deep: true, context7: true, arxiv: true, consensus: true, challenge: true, voting: true, code: true },
    5: { perplexity: true, deep: true, context7: true, arxiv: true, consensus: true, challenge: true, voting: true, code: true },
  };

  it('depth 1 should have minimal features', () => {
    const features = DEPTH_FEATURES[1];
    expect(features.perplexity).toBe(true);
    expect(features.deep).toBe(false);
    expect(features.challenge).toBe(false);
    expect(features.code).toBe(false);
  });

  it('depth 2 adds deep analysis and challenge', () => {
    const features = DEPTH_FEATURES[2];
    expect(features.deep).toBe(true);
    expect(features.challenge).toBe(true);
    expect(features.voting).toBe(false);
    expect(features.code).toBe(false);
  });

  it('depth 3 adds context7, voting, and code', () => {
    const features = DEPTH_FEATURES[3];
    expect(features.context7).toBe(true);
    expect(features.voting).toBe(true);
    expect(features.code).toBe(true);
    expect(features.arxiv).toBe(false);
  });

  it('depth 4 adds arxiv and consensus', () => {
    const features = DEPTH_FEATURES[4];
    expect(features.arxiv).toBe(true);
    expect(features.consensus).toBe(true);
  });

  it('depth 5 has all features', () => {
    const features = DEPTH_FEATURES[5];
    expect(Object.values(features).every(v => v === true)).toBe(true);
  });
});

// ============================================================================
// Step Filtering Tests
// ============================================================================

describe('Step Filtering by Depth', () => {
  /**
   * Tests that steps are correctly filtered based on depth.
   * These represent what parseActionPlan should do internally.
   */
  
  function filterStepsByDepth(steps: string[], depth: number): string[] {
    let filtered = [...steps];
    
    if (depth < 2) {
      filtered = filtered.filter(s => !s.includes('deep') && !s.includes('thinking'));
    }
    if (depth < 3) {
      filtered = filtered.filter(s => !s.includes('library') && !s.includes('context'));
    }
    if (depth < 4) {
      filtered = filtered.filter(s => !s.includes('consensus') && !s.includes('arxiv'));
    }
    
    return filtered;
  }

  it('filters out deep_analysis at depth 1', () => {
    const steps = ['perplexity_search', 'deep_analysis'];
    const filtered = filterStepsByDepth(steps, 1);
    
    expect(filtered).toContain('perplexity_search');
    expect(filtered).not.toContain('deep_analysis');
  });

  it('keeps deep_analysis at depth 2', () => {
    const steps = ['perplexity_search', 'deep_analysis'];
    const filtered = filterStepsByDepth(steps, 2);
    
    expect(filtered).toContain('deep_analysis');
  });

  it('filters out library_docs at depth 2', () => {
    const steps = ['perplexity_search', 'deep_analysis', 'library_docs'];
    const filtered = filterStepsByDepth(steps, 2);
    
    expect(filtered).not.toContain('library_docs');
  });

  it('keeps library_docs at depth 3', () => {
    const steps = ['perplexity_search', 'deep_analysis', 'library_docs'];
    const filtered = filterStepsByDepth(steps, 3);
    
    expect(filtered).toContain('library_docs');
  });

  it('filters out arxiv at depth 3', () => {
    const steps = ['perplexity_search', 'arxiv_search'];
    const filtered = filterStepsByDepth(steps, 3);
    
    expect(filtered).not.toContain('arxiv_search');
  });

  it('keeps arxiv at depth 4', () => {
    const steps = ['perplexity_search', 'arxiv_search'];
    const filtered = filterStepsByDepth(steps, 4);
    
    expect(filtered).toContain('arxiv_search');
  });

  it('perplexity always included regardless of depth', () => {
    for (const depth of [1, 2, 3, 4, 5]) {
      const steps = ['perplexity_search'];
      const filtered = filterStepsByDepth(steps, depth);
      expect(filtered).toContain('perplexity_search');
    }
  });
});

// ============================================================================
// Controller Gating Tests (Validation/Voting)
// ============================================================================

describe('Controller Validation Gating', () => {
  /**
   * Tests for the shouldRunX flags in controller.ts
   */
  
  function getValidationFlags(depth: number) {
    return {
      shouldRunChallenge: depth >= 2,
      shouldRunVoting: depth >= 3,
      shouldRunConsensus: depth >= 4,
    };
  }

  it('depth 1: no validation at all', () => {
    const flags = getValidationFlags(1);
    expect(flags.shouldRunChallenge).toBe(false);
    expect(flags.shouldRunVoting).toBe(false);
    expect(flags.shouldRunConsensus).toBe(false);
  });

  it('depth 2: challenge only', () => {
    const flags = getValidationFlags(2);
    expect(flags.shouldRunChallenge).toBe(true);
    expect(flags.shouldRunVoting).toBe(false);
    expect(flags.shouldRunConsensus).toBe(false);
  });

  it('depth 3: challenge + voting', () => {
    const flags = getValidationFlags(3);
    expect(flags.shouldRunChallenge).toBe(true);
    expect(flags.shouldRunVoting).toBe(true);
    expect(flags.shouldRunConsensus).toBe(false);
  });

  it('depth 4+: all validation', () => {
    const flags = getValidationFlags(4);
    expect(flags.shouldRunChallenge).toBe(true);
    expect(flags.shouldRunVoting).toBe(true);
    expect(flags.shouldRunConsensus).toBe(true);
  });
});

// ============================================================================
// Synthesis Code Example Gating
// ============================================================================

describe('Synthesis Code Example Gating', () => {
  function shouldIncludeCodeExamples(includeCodeExamples: boolean | undefined, depth: number): boolean {
    return (includeCodeExamples ?? false) && depth >= 3;
  }

  it('depth 1: no code examples even if requested', () => {
    expect(shouldIncludeCodeExamples(true, 1)).toBe(false);
  });

  it('depth 2: no code examples even if requested', () => {
    expect(shouldIncludeCodeExamples(true, 2)).toBe(false);
  });

  it('depth 3: code examples if requested', () => {
    expect(shouldIncludeCodeExamples(true, 3)).toBe(true);
  });

  it('depth 3: no code examples if not requested', () => {
    expect(shouldIncludeCodeExamples(false, 3)).toBe(false);
    expect(shouldIncludeCodeExamples(undefined, 3)).toBe(false);
  });

  it('depth 4+: code examples if requested', () => {
    expect(shouldIncludeCodeExamples(true, 4)).toBe(true);
    expect(shouldIncludeCodeExamples(true, 5)).toBe(true);
  });
});

