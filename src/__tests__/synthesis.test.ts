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

// ============================================================================
// Citation Format Validation (Structural - regex is appropriate here)
// ============================================================================

/**
 * Extracts and validates citation formats from synthesis output.
 * This is a STRUCTURAL check - we're validating format, not semantic relevance.
 */
export function extractCitations(text: string): {
  arxiv: string[];
  perplexity: string[];
  context7: string[];
  total: number;
} {
  const arxiv = text.match(/\[arxiv:[\w\d.]+v?\d*\]/g) || [];
  const perplexity = text.match(/\[perplexity:\d+\]/g) || [];
  const context7 = text.match(/\[context7:[\w-]+\]/g) || [];
  
  return {
    arxiv,
    perplexity,
    context7,
    total: arxiv.length + perplexity.length + context7.length,
  };
}

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

/**
 * Parses section delimiters from synthesis output.
 * Format: <!-- SECTION:name -->
 */
export function parseSections(markdown: string): {
  sections: Record<string, string>;
  sectionOrder: string[];
} {
  const sections: Record<string, string> = {};
  const sectionOrder: string[] = [];
  const delimiterRegex = /<!--\s*SECTION:(\w+)\s*-->/g;
  
  const matches: Array<{ name: string; index: number; fullMatch: string }> = [];
  let match;
  while ((match = delimiterRegex.exec(markdown)) !== null) {
    matches.push({ 
      name: match[1], 
      index: match.index + match[0].length,
      fullMatch: match[0],
    });
    sectionOrder.push(match[1]);
  }
  
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length 
      ? markdown.indexOf(matches[i + 1].fullMatch)
      : markdown.length;
    sections[matches[i].name] = markdown.slice(start, end).trim();
  }
  
  return { sections, sectionOrder };
}

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

/**
 * Extracts code blocks from text.
 * Returns language and content for each block.
 */
export function extractCodeBlocks(text: string): Array<{
  language: string;
  content: string;
  isComplete: boolean;
}> {
  const blocks: Array<{ language: string; content: string; isComplete: boolean }> = [];
  
  // Match complete code blocks
  const completePattern = /```(\w*)\n([\s\S]*?)```/g;
  let match;
  let lastMatchEnd = 0;
  while ((match = completePattern.exec(text)) !== null) {
    blocks.push({
      language: match[1] || 'text',
      content: match[2],
      isComplete: true,
    });
    lastMatchEnd = match.index + match[0].length;
  }
  
  // Check for unclosed code block after the last complete match
  const remainingText = text.slice(lastMatchEnd);
  const unclosedMatch = remainingText.match(/```(\w*)\n([\s\S]+)$/);
  if (unclosedMatch) {
    blocks.push({
      language: unclosedMatch[1] || 'text',
      content: unclosedMatch[2],
      isComplete: false,
    });
  }
  
  return blocks;
}

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

// ============================================================================
// Citation Density Calculation (Structural)
// ============================================================================

/**
 * Calculates citation density (citations per N characters).
 * This is a structural metric - semantic relevance requires LLM-as-a-Judge.
 */
export function calculateCitationDensity(
  text: string,
  windowSize: number = 500
): number {
  const citations = extractCitations(text);
  if (text.length === 0) return 0;
  return citations.total / (text.length / windowSize);
}

describe('Citation Density', () => {
  it('calculates density correctly', () => {
    // 500 chars + 2 citations = density of 2 per 500 chars
    const text = 'A'.repeat(500) + ' [arxiv:123] [perplexity:1]';
    const density = calculateCitationDensity(text);
    expect(density).toBeGreaterThan(1.5);
  });

  it('returns 0 for empty text', () => {
    expect(calculateCitationDensity('')).toBe(0);
  });

  it('returns 0 for text without citations', () => {
    const text = 'No citations in this text at all.';
    expect(calculateCitationDensity(text)).toBe(0);
  });
});

// ============================================================================
// Exports for use in other modules
// ============================================================================

export { extractCitations as validateCitationFormats };
export { parseSections as parseSectionDelimiters };
export { extractCodeBlocks as validatePythonCode };

// Stub for compatibility with e2e tests
export function detectTruncation(text: string): { isTruncated: boolean; indicators: string[] } {
  const blocks = extractCodeBlocks(text);
  const unclosed = blocks.some(b => !b.isComplete);
  return {
    isTruncated: unclosed,
    indicators: unclosed ? ['Unclosed code block'] : [],
  };
}

export function detectLogicInconsistencies(_text: string): {
  hasInconsistency: boolean;
  andPatterns: string[];
  orPatterns: string[];
  conflicts: string[];
} {
  // NOTE: Logic consistency detection requires LLM-as-a-Judge, not regex.
  // This stub exists for backwards compatibility but should not be relied upon.
  console.warn('detectLogicInconsistencies: Use LLM-as-a-Judge for semantic evaluation');
  return { hasInconsistency: false, andPatterns: [], orPatterns: [], conflicts: [] };
}
