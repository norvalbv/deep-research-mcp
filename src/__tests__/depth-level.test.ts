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
import { createFallbackPlan, parseActionPlan } from '../planning.js';

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
// Planning Output Format + Step Filtering (REAL implementation)
// ============================================================================

describe('parseActionPlan (step normalization + filtering + output format)', () => {
  it('normalizes ActionStep.tool entries into our internal step names', () => {
    const response = JSON.stringify({
      // Use complexity=4 so arxiv/consensus are not filtered out
      complexity: 4,
      reasoning: 'test',
      output_format: 'summary',
      signals: { needs_code: false },
      steps: [
        { tool: 'perplexity', description: 'Search', parallel: false },
        { tool: 'deep_analysis', description: 'Reason', parallel: false },
        { tool: 'context7', description: 'Docs', parallel: true },
        { tool: 'arxiv', description: 'Papers', parallel: true },
        { tool: 'consensus', description: 'Validate', parallel: false },
      ],
    });

    const plan = parseActionPlan(response);
    expect(plan.steps).toContain('perplexity_search');
    expect(plan.steps).toContain('deep_analysis');
    expect(plan.steps).toContain('library_docs');
    expect(plan.steps).toContain('arxiv_search');
    expect(plan.steps).toContain('consensus');
  });

  it('filters out deep/library/arxiv/consensus when complexity is 1', () => {
    const response = JSON.stringify({
      complexity: 1,
      reasoning: 'test',
      output_format: 'summary',
      signals: { needs_code: false },
      steps: [
        { tool: 'perplexity', description: 'Search', parallel: false },
        { tool: 'deep_analysis', description: 'Reason', parallel: false },
        { tool: 'context7', description: 'Docs', parallel: true },
        { tool: 'arxiv', description: 'Papers', parallel: true },
        { tool: 'consensus', description: 'Validate', parallel: false },
      ],
    });

    const plan = parseActionPlan(response);
    expect(plan.complexity).toBe(1);
    expect(plan.steps).toContain('perplexity_search');
    expect(plan.steps).not.toContain('deep_analysis');
    expect(plan.steps).not.toContain('library_docs');
    expect(plan.steps).not.toContain('arxiv_search');
    expect(plan.steps).not.toContain('consensus');
  });

  it('filters out library/arxiv/consensus when complexity is 2, but keeps deep_analysis', () => {
    const response = JSON.stringify({
      complexity: 2,
      reasoning: 'test',
      output_format: 'summary',
      signals: { needs_code: false },
      steps: [
        { tool: 'perplexity', description: 'Search', parallel: false },
        { tool: 'deep_analysis', description: 'Reason', parallel: false },
        { tool: 'context7', description: 'Docs', parallel: true },
        { tool: 'arxiv', description: 'Papers', parallel: true },
        { tool: 'consensus', description: 'Validate', parallel: false },
      ],
    });

    const plan = parseActionPlan(response);
    expect(plan.complexity).toBe(2);
    expect(plan.steps).toContain('perplexity_search');
    expect(plan.steps).toContain('deep_analysis');
    expect(plan.steps).not.toContain('library_docs');
    expect(plan.steps).not.toContain('arxiv_search');
    expect(plan.steps).not.toContain('consensus');
  });

  it('caps complexity at maxDepth and filters steps accordingly', () => {
    const response = JSON.stringify({
      complexity: 4,
      reasoning: 'needs deep research',
      output_format: 'detailed',
      signals: { needs_code: true },
      steps: [
        { tool: 'perplexity', description: 'Search', parallel: false },
        { tool: 'deep_analysis', description: 'Reason', parallel: false },
        { tool: 'context7', description: 'Docs', parallel: true },
        { tool: 'arxiv', description: 'Papers', parallel: true },
        { tool: 'consensus', description: 'Validate', parallel: false },
      ],
    });

    const plan = parseActionPlan(response, 2);
    expect(plan.complexity).toBe(2);
    expect(plan.reasoning).toContain('capped from 4 to 2');
    expect(plan.steps).toContain('perplexity_search');
    expect(plan.steps).toContain('deep_analysis');
    expect(plan.steps).not.toContain('library_docs');
    expect(plan.steps).not.toContain('arxiv_search');
    expect(plan.steps).not.toContain('consensus');
  });

  it('extracts includeCodeExamples from signals.needs_code', () => {
    const response = JSON.stringify({
      complexity: 3,
      reasoning: 'test',
      output_format: 'summary',
      signals: { needs_code: true },
      steps: [{ tool: 'perplexity', description: 'Search', parallel: false }],
    });

    const plan = parseActionPlan(response);
    expect(plan.includeCodeExamples).toBe(true);
  });

  it('extracts outputFormat from output_format when valid', () => {
    const response = JSON.stringify({
      complexity: 2,
      reasoning: 'test',
      output_format: 'direct',
      signals: { needs_code: false },
      steps: [{ tool: 'perplexity', description: 'Search', parallel: false }],
    });

    const plan = parseActionPlan(response);
    expect(plan.outputFormat).toBe('direct');
  });

  it('ignores output_format when invalid', () => {
    const response = JSON.stringify({
      complexity: 2,
      reasoning: 'test',
      output_format: 'verbose',
      signals: { needs_code: false },
      steps: [{ tool: 'perplexity', description: 'Search', parallel: false }],
    });

    const plan = parseActionPlan(response);
    expect(plan.outputFormat).toBeUndefined();
  });
});

