/**
 * Synthesis Tests
 * 
 * Tests STRUCTURAL aspects of synthesis output that CAN be reliably tested:
 * - Citation format validation (structural)
 * - Section delimiter parsing (structural)
 * - Code block structure (structural)
 * 
 * NOTE: Semantic evaluation (logic consistency, quality) should use LLM-as-a-Judge,
 * not regex pattern matching.
 * 
 * Run with: npm run test
 */

import { describe, it, expect } from 'vitest';
import { extractCitations, parseSections, extractCodeBlocks } from './helpers/markdown-structural.js';

// ============================================================================
// Citation Format Validation (Structural)
// ============================================================================

describe('Citation Format Extraction', () => {
  it('extracts arxiv citations', () => {
    const text = 'Research shows [arxiv:2309.01431v2] that RAG works [arxiv:2407.11005].';
    const result = extractCitations(text);
    expect(result.arxiv).toHaveLength(2);
    expect(result.arxiv[0]).toBe('[arxiv:2309.01431v2]');
  });

  it('extracts perplexity citations', () => {
    const text = 'Web search [perplexity:1] indicates [perplexity:2] results.';
    const result = extractCitations(text);
    expect(result.perplexity).toHaveLength(2);
  });

  it('extracts context7 citations', () => {
    const text = 'The library [context7:langsmith] provides tracing.';
    const result = extractCitations(text);
    expect(result.context7).toHaveLength(1);
  });

  it('counts total citations', () => {
    const text = '[arxiv:123] and [perplexity:1] and [context7:lib]';
    const result = extractCitations(text);
    expect(result.total).toBe(3);
  });

  it('returns empty arrays for no citations', () => {
    const text = 'No citations here.';
    const result = extractCitations(text);
    expect(result.total).toBe(0);
  });
});

// ============================================================================
// Section Delimiter Parsing (Structural)
// ============================================================================

describe('Section Delimiter Parsing', () => {
  it('parses single section', () => {
    const md = '<!-- SECTION:overview -->\nContent here.';
    const result = parseSections(md);
    expect(result.sectionOrder).toContain('overview');
    expect(result.sections.overview).toContain('Content here');
  });

  it('parses multiple sections', () => {
    const md = `
<!-- SECTION:overview -->
Overview content.
<!-- SECTION:q1 -->
Q1 content.
<!-- SECTION:q2 -->
Q2 content.
`;
    const result = parseSections(md);
    expect(result.sectionOrder).toEqual(['overview', 'q1', 'q2']);
    expect(result.sections.q1).toContain('Q1 content');
  });

  it('handles additional_insights section', () => {
    const md = '<!-- SECTION:overview -->\nMain.\n<!-- SECTION:additional_insights -->\nExtra.';
    const result = parseSections(md);
    expect(result.sections.additional_insights).toContain('Extra');
  });

  it('returns empty for no sections', () => {
    const md = 'Just plain text, no sections.';
    const result = parseSections(md);
    expect(result.sectionOrder).toHaveLength(0);
  });
});

// ============================================================================
// Code Block Structure (Structural)
// ============================================================================

describe('Code Block Extraction', () => {
  it('extracts complete Python block', () => {
    const text = '```python\ndef hello():\n    print("hi")\n```';
    const result = extractCodeBlocks(text);
    expect(result).toHaveLength(1);
    expect(result[0].language).toBe('python');
    expect(result[0].isComplete).toBe(true);
  });

  it('extracts multiple blocks', () => {
    const text = '```js\nconst x = 1;\n```\n\n```python\nx = 1\n```';
    const result = extractCodeBlocks(text);
    expect(result).toHaveLength(2);
    expect(result[0].language).toBe('js');
    expect(result[1].language).toBe('python');
  });

  it('detects unclosed code block', () => {
    const text = 'Text here\n\n```python\ndef broken():\n    pass';
    const result = extractCodeBlocks(text);
    const unclosed = result.find(b => !b.isComplete);
    expect(unclosed).toBeDefined();
    expect(unclosed?.language).toBe('python');
  });

  it('handles block without language', () => {
    const text = '```\nsome code\n```';
    const result = extractCodeBlocks(text);
    expect(result[0].language).toBe('text');
  });
});

// (No exports from this file; shared helpers live in __tests__/helpers/*)

// ============================================================================
// Output Format Rendering Tests (Structural)
// ============================================================================

import { formatMarkdown, resolveCitations, ResearchResult } from '../formatting.js';

// Create a minimal mock ResearchResult for testing formatMarkdown
function createMockResult(overrides: Partial<ResearchResult> = {}): ResearchResult {
  return {
    query: 'Test query',
    complexity: 2,
    complexityReasoning: 'Test reasoning',
    execution: {
      perplexityResult: { content: 'test', sources: ['https://example.com'] },
    },
    synthesis: {
      overview: 'This is the overview content.',
      additionalInsights: 'Some additional insights.',
    },
    ...overrides,
  } as ResearchResult;
}

describe('Output Format Rendering', () => {
  describe('direct format', () => {
    it('returns only the overview content with no wrapper', () => {
      const result = createMockResult({ outputFormat: 'direct' });
      const markdown = formatMarkdown(result);
      
      // Should be just the overview, nothing else
      expect(markdown).toBe('This is the overview content.');
      expect(markdown).not.toContain('# Research Results');
      expect(markdown).not.toContain('## Overview');
      expect(markdown).not.toContain('## Additional Insights');
      expect(markdown).not.toContain('## Sources');
    });

    it('does not resolve citations in direct format', () => {
      const result = createMockResult({
        outputFormat: 'direct',
        synthesis: { overview: 'Fact [1] here.' },
      });
      const markdown = formatMarkdown(result);
      
      // Citations should remain unresolved in direct mode
      expect(markdown).toBe('Fact [1] here.');
    });
  });

  describe('summary format', () => {
    it('includes header, overview, and additional insights', () => {
      const result = createMockResult({ outputFormat: 'summary' });
      const markdown = formatMarkdown(result);
      
      expect(markdown).toContain('# Research Results: Test query');
      expect(markdown).toContain('## Overview');
      expect(markdown).toContain('This is the overview content.');
      expect(markdown).toContain('## Additional Insights');
    });

    it('includes Sources but omits Validation and Academic Papers sections', () => {
      const result = createMockResult({ outputFormat: 'summary' });
      const markdown = formatMarkdown(result);
      
      expect(markdown).toContain('## Sources');
      expect(markdown).not.toContain('## Validation');
      expect(markdown).not.toContain('## Academic Papers');
    });

    it('resolves citations in summary format', () => {
      const result = createMockResult({
        outputFormat: 'summary',
        synthesis: { overview: 'Fact [1] here.' },
      });
      const markdown = formatMarkdown(result);
      
      // Citation should be resolved to link
      expect(markdown).toContain('[example.com]');
      expect(markdown).toContain('(https://example.com)');
    });
  });

  describe('detailed format', () => {
    it('includes all sections', () => {
      const result = createMockResult({ outputFormat: 'detailed' });
      const markdown = formatMarkdown(result);
      
      expect(markdown).toContain('# Research Results: Test query');
      expect(markdown).toContain('## Overview');
      expect(markdown).toContain('## Additional Insights');
      expect(markdown).toContain('## Sources');
    });

    it('is the default when outputFormat is not specified', () => {
      const result = createMockResult({ outputFormat: undefined });
      const markdown = formatMarkdown(result);
      
      // Should behave like detailed (includes Sources)
      expect(markdown).toContain('## Sources');
    });
  });

  describe('sub-questions', () => {
    it('renders sub-questions in non-direct formats', () => {
      const result = createMockResult({
        outputFormat: 'summary',
        synthesis: {
          overview: 'Overview.',
          subQuestions: {
            q1: { question: 'What is X?', answer: 'X is something.' },
            q2: { question: 'Why Y?', answer: 'Because reasons.' },
          },
        },
      });
      const markdown = formatMarkdown(result);
      
      expect(markdown).toContain('## What is X?');
      expect(markdown).toContain('X is something.');
      expect(markdown).toContain('## Why Y?');
      expect(markdown).toContain('Because reasons.');
    });

    it('does not include sub-questions in direct format', () => {
      const result = createMockResult({
        outputFormat: 'direct',
        synthesis: {
          overview: 'Just the overview.',
          subQuestions: {
            q1: { question: 'What is X?', answer: 'X is something.' },
          },
        },
      });
      const markdown = formatMarkdown(result);
      
      expect(markdown).toBe('Just the overview.');
      expect(markdown).not.toContain('What is X?');
    });
  });
});

// ============================================================================
// Citation Resolution Tests
// ============================================================================

describe('Citation Resolution', () => {
  const mockExecution = {
    perplexityResult: {
      content: 'test content',
      sources: [
        'https://example.com/article1',
        'https://docs.python.org/guide',
        'https://arxiv.org/abs/2401.12345',
        'https://www.github.com/repo',
        'https://medium.com/blog-post',
        'https://research.google/paper',
      ],
    },
  };

  // Simple numeric citations [N]
  it('resolves simple numeric citation [1]', () => {
    const text = 'This is a fact [1].';
    const result = resolveCitations(text, mockExecution as any);
    expect(result).toContain('[example.com]');
    expect(result).toContain('(https://example.com/article1)');
    expect(result).not.toContain('[1]');
  });

  it('resolves consecutive numeric citations [1][2][4]', () => {
    const text = 'Multiple sources [1][2][4].';
    const result = resolveCitations(text, mockExecution as any);
    expect(result).toContain('[example.com]');
    expect(result).toContain('[docs.python.org]');
    expect(result).toContain('[github.com]');
    expect(result).not.toContain('[1]');
    expect(result).not.toContain('[2]');
    expect(result).not.toContain('[4]');
  });

  // Perplexity format citations
  it('resolves single perplexity citation [perplexity:1]', () => {
    const text = 'This is a fact [perplexity:1].';
    const result = resolveCitations(text, mockExecution as any);
    expect(result).toContain('[example.com]');
    expect(result).toContain('(https://example.com/article1)');
    expect(result).not.toContain('[perplexity:1]');
  });

  it('resolves comma-separated citations [perplexity:1, perplexity:2]', () => {
    const text = 'Multiple sources [perplexity:1, perplexity:2].';
    const result = resolveCitations(text, mockExecution as any);
    expect(result).toContain('[example.com]');
    expect(result).toContain('[docs.python.org]');
    expect(result).not.toContain('[perplexity:1');
    expect(result).not.toContain('perplexity:2]');
  });

  it('resolves multiple comma-separated citations [perplexity:1, perplexity:2, perplexity:6]', () => {
    const text = 'Many sources [perplexity:1, perplexity:2, perplexity:6].';
    const result = resolveCitations(text, mockExecution as any);
    expect(result).toContain('[example.com]');
    expect(result).toContain('[docs.python.org]');
    expect(result).toContain('[research.google]');
    expect(result).not.toContain('[perplexity:');
  });

  it('handles case-insensitive citations [Perplexity:1]', () => {
    const text = 'Capitalized [Perplexity:1].';
    const result = resolveCitations(text, mockExecution as any);
    expect(result).toContain('[example.com]');
    expect(result).not.toContain('[Perplexity:1]');
  });

  // Edge cases
  it('handles missing sources gracefully for numeric', () => {
    const text = 'Citation [99].';
    const result = resolveCitations(text, mockExecution as any);
    expect(result).toContain('[99]'); // Kept as-is
  });

  it('handles missing sources gracefully for perplexity', () => {
    const text = 'Citation [perplexity:99].';
    const result = resolveCitations(text, mockExecution as any);
    expect(result).toContain('[perplexity:99]'); // Kept as-is
  });

  it('handles empty sources array', () => {
    const emptyExecution = { perplexityResult: { content: '', sources: [] } };
    const text = 'Citation [1] and [perplexity:1].';
    const result = resolveCitations(text, emptyExecution as any);
    expect(result).toContain('[1]'); // Kept as-is
    expect(result).toContain('[perplexity:1]'); // Kept as-is
  });

  it('handles undefined perplexityResult', () => {
    const noPerplexity = {};
    const text = 'Citation [1].';
    const result = resolveCitations(text, noPerplexity as any);
    expect(result).toContain('[1]'); // Kept as-is
  });
});
