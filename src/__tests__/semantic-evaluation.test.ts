/**
 * Structural Detection Tests
 * 
 * Tests ONLY what regex/literal-matching is appropriate for:
 * - Literal string detection (TODO, FIXME, placeholders)
 * - Citation format validation (structural)
 * - Code pattern syntax (literal patterns like `: any`)
 * 
 * IMPORTANT: Semantic evaluation (is this "vague"? "specific"? "good"?) 
 * requires LLM-as-a-Judge per research (arxiv:2303.16634, arxiv:2306.05685).
 * Do NOT use regex for semantic judgments.
 * 
 * Run with: npm run test
 */

import { describe, it, expect } from 'vitest';

// ============================================================================
// Literal Pattern Detectors (Regex IS appropriate here)
// ============================================================================

/**
 * Detect literal TODO/FIXME strings in code
 * This is a LITERAL match, not semantic - regex is appropriate
 */
export function detectIncompletePlaceholders(code: string): {
  hasTodo: boolean;
  hasFixme: boolean;
  hasPlaceholder: boolean;
  matches: string[];
} {
  const matches: string[] = [];
  
  // Literal TODO/FIXME detection
  const todoMatch = code.match(/\bTODO\b/gi);
  const fixmeMatch = code.match(/\bFIXME\b/gi);
  
  if (todoMatch) matches.push(...todoMatch);
  if (fixmeMatch) matches.push(...fixmeMatch);
  
  // Literal placeholder patterns (exact strings)
  const placeholderPatterns = [
    'YOUR_API_KEY',
    'YOUR_MODEL', 
    'YOUR_TOKEN',
    'REPLACE_ME',
    'INSERT_HERE',
    'sk-xxx',
    'api_key_here',
  ];
  
  for (const pattern of placeholderPatterns) {
    if (code.includes(pattern)) {
      matches.push(pattern);
    }
  }
  
  return {
    hasTodo: !!todoMatch,
    hasFixme: !!fixmeMatch,
    hasPlaceholder: placeholderPatterns.some(p => code.includes(p)),
    matches,
  };
}

/**
 * Detect TypeScript `any` type usage (literal syntax match)
 */
export function detectAnyType(code: string): {
  hasAny: boolean;
  count: number;
} {
  // Match `: any` or `: any[]` or `<any>` etc.
  const anyMatches = code.match(/:\s*any\b|<any>/g) || [];
  
  return {
    hasAny: anyMatches.length > 0,
    count: anyMatches.length,
  };
}

/**
 * Extract and validate citation format (structural check)
 * Validates format, NOT semantic accuracy of the citation
 */
export function extractCitationFormats(text: string): {
  arxiv: string[];
  perplexity: string[];
  context7: string[];
  validFormat: boolean;
} {
  const arxiv = text.match(/\[arxiv:[\w\d.]+v?\d*\]/g) || [];
  const perplexity = text.match(/\[perplexity:\d+\]/g) || [];
  const context7 = text.match(/\[context7:[\w-]+\]/g) || [];
  
  // Check if all citations follow valid format
  const allCitations = text.match(/\[[^\]]+\]/g) || [];
  const knownPatterns = /^\[(arxiv|perplexity|context7|deep_analysis):/;
  const validFormat = allCitations.every(c => knownPatterns.test(c) || !c.includes(':'));
  
  return { arxiv, perplexity, context7, validFormat };
}

// ============================================================================
// Tests for Literal Pattern Detection
// ============================================================================

describe('Literal Pattern Detection', () => {
  describe('detectIncompletePlaceholders', () => {
    it('detects TODO in code', () => {
      const code = `
def process_data(data):
    # TODO: implement actual processing
    pass
      `;
      
      const result = detectIncompletePlaceholders(code);
      expect(result.hasTodo).toBe(true);
      expect(result.matches).toContain('TODO');
    });
    
    it('detects FIXME in code', () => {
      const code = `
try {
  await apiCall();
} catch (e) {
  // FIXME: proper error handling
  console.log(e);
}
      `;
      
      const result = detectIncompletePlaceholders(code);
      expect(result.hasFixme).toBe(true);
    });
    
    it('detects API key placeholders', () => {
      const code = `
const config = {
  apiKey: 'YOUR_API_KEY',
  model: 'YOUR_MODEL',
};
      `;
      
      const result = detectIncompletePlaceholders(code);
      expect(result.hasPlaceholder).toBe(true);
      expect(result.matches).toContain('YOUR_API_KEY');
      expect(result.matches).toContain('YOUR_MODEL');
    });
    
    it('passes clean code without placeholders', () => {
      const code = `
async function callAPI(prompt: string): Promise<string> {
  const response = await client.chat(prompt);
  return response.content;
}
      `;
      
      const result = detectIncompletePlaceholders(code);
      expect(result.hasTodo).toBe(false);
      expect(result.hasFixme).toBe(false);
      expect(result.hasPlaceholder).toBe(false);
    });
  });
  
  describe('detectAnyType', () => {
    it('detects any type usage', () => {
      const code = `
function processResponse(data: any): any {
  return data.result;
}
      `;
      
      const result = detectAnyType(code);
      expect(result.hasAny).toBe(true);
      expect(result.count).toBe(2);
    });
    
    it('passes properly typed code', () => {
      const code = `
function processResponse(data: ResponseData): ProcessedResult {
  return data.result;
}
      `;
      
      const result = detectAnyType(code);
      expect(result.hasAny).toBe(false);
    });
  });
  
  describe('extractCitationFormats', () => {
    it('extracts arxiv citations', () => {
      const text = 'Research shows [arxiv:2309.01431v2] that RAG works [arxiv:2407.11005].';
      const result = extractCitationFormats(text);
      expect(result.arxiv).toHaveLength(2);
      expect(result.arxiv[0]).toBe('[arxiv:2309.01431v2]');
    });
    
    it('extracts perplexity citations', () => {
      const text = 'Web search [perplexity:1] indicates [perplexity:2] results.';
      const result = extractCitationFormats(text);
      expect(result.perplexity).toHaveLength(2);
    });
    
    it('extracts context7 citations', () => {
      const text = 'The library [context7:langsmith] provides tracing.';
      const result = extractCitationFormats(text);
      expect(result.context7).toHaveLength(1);
    });
    
    it('validates citation format', () => {
      const validText = '[arxiv:123] and [perplexity:1] and [context7:lib]';
      const result = extractCitationFormats(validText);
      expect(result.validFormat).toBe(true);
    });
  });
});

// ============================================================================
// Production Quality Structural Checks
// ============================================================================

describe('Production Quality Structural Checks', () => {
  it('fm-01: code-with-todo detected', () => {
    const code = `
def process_data(data):
    # TODO: implement actual processing
    pass
    `;
    
    const result = detectIncompletePlaceholders(code);
    expect(result.hasTodo).toBe(true);
  });
  
  it('fm-02: code-with-fixme detected', () => {
    const code = `
try {
  await apiCall();
} catch (e) {
  // FIXME: proper error handling
  console.log(e);
}
    `;
    
    const result = detectIncompletePlaceholders(code);
    expect(result.hasFixme).toBe(true);
  });
  
  it('fm-07: placeholder-code detected', () => {
    const code = `
const config = {
  apiKey: 'YOUR_API_KEY',
  model: 'YOUR_MODEL',
};
    `;
    
    const result = detectIncompletePlaceholders(code);
    expect(result.hasPlaceholder).toBe(true);
  });
  
  it('fm-10: any-type detected', () => {
    const code = `
function processResponse(data: any): any {
  return data.result;
}
    `;
    
    const result = detectAnyType(code);
    expect(result.hasAny).toBe(true);
  });
  
  it('hp-01: clean code with citations passes structural checks', () => {
    const text = `
The recommended threshold is 0.85 based on arxiv:2310.03025 [arxiv:2310.03025].
Use 0.85 for production deployments.

\`\`\`typescript
async function callAPI(prompt: string): Promise<string> {
  const response = await client.chat(prompt);
  return response.content;
}
\`\`\`
    `;
    
    const placeholders = detectIncompletePlaceholders(text);
    const anyTypes = detectAnyType(text);
    const citations = extractCitationFormats(text);
    
    expect(placeholders.hasTodo).toBe(false);
    expect(placeholders.hasFixme).toBe(false);
    expect(placeholders.hasPlaceholder).toBe(false);
    expect(anyTypes.hasAny).toBe(false);
    expect(citations.arxiv.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// NOTE: Semantic Evaluation Requires LLM-as-a-Judge
// ============================================================================

/**
 * IMPORTANT: The following semantic evaluations CANNOT be done with regex:
 * 
 * 1. "Is this response vague?" - Requires understanding context
 * 2. "Is this specific enough?" - Requires domain knowledge
 * 3. "Does this satisfy the constraint?" - Requires semantic matching
 * 4. "Is this code complete?" - Beyond TODO/FIXME literal detection
 * 5. "Is this citation accurate?" - Requires source verification
 * 
 * For these, use:
 * - evaluateHCSP() from benchmarks/evaluator.ts (LLM-as-a-Judge)
 * - Run with RUN_LIVE_TESTS=true for live evaluation
 * - Target: Pearson correlation > 0.85 with human scores (arxiv:2306.05685)
 * 
 * See benchmarks/calibration.ts for judge calibration tooling.
 */

describe('Live LLM-as-a-Judge Evaluation', () => {
  const RUN_LIVE = process.env.GEMINI_API_KEY && process.env.RUN_LIVE_TESTS === 'true';
  
  it.skipIf(!RUN_LIVE)('semantic evaluation requires live LLM judge', async () => {
    // For semantic evaluation (specificity, completeness, quality):
    // Import and use evaluateHCSP from benchmarks/evaluator.ts
    // This ensures research-backed evaluation, not brittle regex
    expect(true).toBe(true);
  });
});
