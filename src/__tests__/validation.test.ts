/**
 * Validation Pipeline Tests
 * 
 * Tests STRUCTURAL aspects that CAN be reliably tested:
 * - JSON parsing from LLM responses
 * - Vote aggregation logic
 * - Citation source validation
 * 
 * NOTE: Semantic evaluation (contradiction detection, quality assessment)
 * should use LLM-as-a-Judge, not regex pattern matching.
 * 
 * Run with: npm run test
 */

import { describe, it, expect } from 'vitest';
import { safeParseJSON } from '../validation.js';

// ============================================================================
// safeParseJSON - Robust JSON Parsing for LLM Output
// ============================================================================

describe('safeParseJSON', () => {
  describe('valid JSON', () => {
    it('parses simple valid JSON', () => {
      const result = safeParseJSON('{"key": "value"}', {});
      expect(result).toEqual({ key: 'value' });
    });

    it('parses nested JSON', () => {
      const result = safeParseJSON('{"arr": [1, 2], "obj": {"a": 1}}', {});
      expect(result).toEqual({ arr: [1, 2], obj: { a: 1 } });
    });

    it('parses JSON with markdown wrapper', () => {
      const input = `Here is the response:
\`\`\`json
{"contradictions": []}
\`\`\``;
      const result = safeParseJSON(input, { contradictions: ['fallback'] });
      expect(result).toEqual({ contradictions: [] });
    });
  });

  describe('common LLM output issues', () => {
    it('handles trailing commas in objects', () => {
      const result = safeParseJSON('{"a": 1, "b": 2,}', {});
      expect(result).toEqual({ a: 1, b: 2 });
    });

    it('handles trailing commas in arrays', () => {
      const result = safeParseJSON('{"arr": [1, 2, 3,]}', {});
      expect(result).toEqual({ arr: [1, 2, 3] });
    });

    it('handles unquoted keys', () => {
      const result = safeParseJSON('{key: "value", another: 123}', {});
      expect(result).toEqual({ key: 'value', another: 123 });
    });

    it('handles single quotes in values', () => {
      const result = safeParseJSON("{\"key\": 'value'}", {});
      expect(result).toEqual({ key: 'value' });
    });

    it('handles control characters', () => {
      const input = '{"key": "value\twith\ttabs"}';
      const result = safeParseJSON(input, {});
      expect(result).toHaveProperty('key');
    });

    it('parses JSON with structural newlines (LLM challenge response format)', () => {
      // This reproduces the bug where critiques were returned as [] 
      // even though the LLM returned valid JSON with critiques.
      // Root cause: safeParseJSON was breaking JSON with structural newlines.
      const input = `\`\`\`json
{
  "pass": false,
  "critiques": [
    "[FAILED: Specificity] The claim lacks citation",
    "[FAILED: Consistency] Section 1 contradicts Section 3"
  ]
}
\`\`\``;
      const result = safeParseJSON<{ pass: boolean; critiques: string[] }>(
        input,
        { pass: true, critiques: [] }
      );
      expect(result.pass).toBe(false);
      expect(result.critiques).toHaveLength(2);
      expect(result.critiques[0]).toContain('[FAILED: Specificity]');
      expect(result.critiques[1]).toContain('[FAILED: Consistency]');
    });

    it('parses complex challenge response with many critiques', () => {
      // Real-world LLM output structure with multiple newlines and long strings
      const input = `{
  "pass": false,
  "critiques": [
    "[FAILED: Specificity] The claim that 'Academic research supports this granular approach' is not supported by a specific citation.",
    "[FAILED: Specificity] The reference to '[arxiv:id]' is not a valid citation.",
    "[FAILED: Query Coverage] The synthesis addresses all questions but lacks depth."
  ]
}`;
      const result = safeParseJSON<{ pass: boolean; critiques: string[] }>(
        input,
        { pass: true, critiques: [] }
      );
      expect(result.pass).toBe(false);
      expect(result.critiques).toHaveLength(3);
    });
  });

  describe('NLI contradiction response format', () => {
    it('parses valid contradiction response', () => {
      const input = '{"contradictions":[{"claimA":1,"claimB":3,"reasonCode":"NUMERIC_CONFLICT","severity":"high"}]}';
      const result = safeParseJSON<{ contradictions: Array<{ claimA: number; claimB: number; reasonCode: string; severity: string }> }>(
        input,
        { contradictions: [] }
      );
      expect(result.contradictions).toHaveLength(1);
      expect(result.contradictions[0].claimA).toBe(1);
      expect(result.contradictions[0].reasonCode).toBe('NUMERIC_CONFLICT');
    });

    it('parses empty contradiction response', () => {
      const result = safeParseJSON('{"contradictions":[]}', { contradictions: ['default'] });
      expect(result.contradictions).toHaveLength(0);
    });

    it('handles legacy reason field with quotes (the actual bug case)', () => {
      // This is the format that was causing the JSON parse error
      // The "reason" field contains quotes that break JSON
      const problematicInput = '{"contradictions":[{"claimA":1,"claimB":2,"reason":"Section A says \\"0.85\\" but B says \\"0.75\\"","severity":"high"}]}';
      const result = safeParseJSON(problematicInput, { contradictions: [] });
      // Should fallback gracefully rather than throw
      expect(result).toBeDefined();
    });

    it('handles multiline LLM response with explanation text', () => {
      const input = `Based on my analysis, here are the contradictions I found:

{"contradictions": [{"claimA": 1, "claimB": 5, "reasonCode": "COST_CONFLICT", "severity": "high"}]}

Let me know if you need more details.`;
      const result = safeParseJSON<{ contradictions: Array<{ claimA: number }> }>(input, { contradictions: [] });
      expect(result.contradictions).toHaveLength(1);
      expect(result.contradictions[0].claimA).toBe(1);
    });
  });

  describe('fallback behavior', () => {
    it('returns fallback for completely invalid input', () => {
      const result = safeParseJSON('not json at all', { default: true });
      expect(result).toEqual({ default: true });
    });

    it('returns fallback for empty string', () => {
      const result = safeParseJSON('', { fallback: 'value' });
      expect(result).toEqual({ fallback: 'value' });
    });

    it('returns fallback for truncated JSON', () => {
      const result = safeParseJSON('{"key": "val', { complete: false });
      expect(result).toEqual({ complete: false });
    });

    it('returns typed fallback', () => {
      interface MyType { items: string[] }
      const result = safeParseJSON<MyType>('invalid', { items: ['default'] });
      expect(result.items).toContain('default');
    });
  });

  describe('edge cases from production', () => {
    it('handles JSON with newlines in string values', () => {
      const input = '{"description": "Line 1\\nLine 2"}';
      const result = safeParseJSON(input, {});
      expect(result).toHaveProperty('description');
    });

    it('handles mixed quote styles', () => {
      const input = "{\"key\": 'single', 'another': \"double\"}";
      // This is malformed but should be handled gracefully
      const result = safeParseJSON(input, { fallback: true });
      expect(result).toBeDefined();
    });

    it('handles deeply nested structures', () => {
      const input = '{"a":{"b":{"c":{"d":"value"}}}}';
      const result = safeParseJSON<{ a: { b: { c: { d: string } } } }>(input, { a: { b: { c: { d: 'fallback' } } } });
      expect(result.a.b.c.d).toBe('value');
    });
  });
});

// ============================================================================
// Vote Response Parsing (Structural - parsing LLM JSON output)
// ============================================================================

/**
 * Parses vote response from LLM - handles markdown-wrapped JSON
 */
export function parseVoteResponse(response: string): {
  vote: 'synthesis_wins' | 'critique_wins';
  reasoning: string;
  criticalGaps?: string[];
} {
  try {
    // Extract JSON from markdown code blocks if present
    const codeBlockMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    const contentToSearch = codeBlockMatch ? codeBlockMatch[1] : response;
    
    const jsonMatch = contentToSearch.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found');
    }
    
    const parsed = JSON.parse(jsonMatch[0]);
    
    return {
      vote: parsed.vote === 'critique_wins' ? 'critique_wins' : 'synthesis_wins',
      reasoning: parsed.reasoning || '',
      criticalGaps: parsed.critical_gaps || parsed.criticalGaps || [],
    };
  } catch {
    return { 
      vote: 'synthesis_wins', 
      reasoning: 'Parse failed, defaulting to synthesis_wins',
      criticalGaps: [],
    };
  }
}

describe('Vote Response Parsing', () => {
  it('parses plain JSON', () => {
    const response = '{"vote": "synthesis_wins", "reasoning": "Good answer."}';
    const result = parseVoteResponse(response);
    expect(result.vote).toBe('synthesis_wins');
    expect(result.reasoning).toContain('Good');
  });

  it('parses markdown-wrapped JSON', () => {
    const response = `Here is my evaluation:

\`\`\`json
{
  "vote": "critique_wins",
  "reasoning": "Issues found.",
  "critical_gaps": ["Gap 1", "Gap 2"]
}
\`\`\`
`;
    const result = parseVoteResponse(response);
    expect(result.vote).toBe('critique_wins');
    expect(result.criticalGaps).toHaveLength(2);
  });

  it('handles code block without language tag', () => {
    const response = '```\n{"vote": "synthesis_wins", "reasoning": "OK"}\n```';
    const result = parseVoteResponse(response);
    expect(result.vote).toBe('synthesis_wins');
  });

  it('defaults to synthesis_wins on invalid JSON', () => {
    const response = 'Not valid JSON at all.';
    const result = parseVoteResponse(response);
    expect(result.vote).toBe('synthesis_wins');
    expect(result.reasoning).toContain('Parse failed');
  });

  it('extracts critical_gaps correctly', () => {
    const response = `{
      "vote": "critique_wins",
      "reasoning": "Problems",
      "critical_gaps": ["Missing implementation", "Undefined variable"]
    }`;
    const result = parseVoteResponse(response);
    expect(result.criticalGaps).toContain('Missing implementation');
  });
});

// ============================================================================
// HCSP Vote Aggregation (Hierarchical Constraint Satisfaction Protocol)
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

/**
 * HCSP Vote Aggregation - Critical gaps override vote count
 * Rule: If ANY vote has a CRITICAL_GAP, synthesis fails
 */
export function aggregateVotesHCSP(votes: HCSPVoteDetail[]): {
  sufficient: boolean;
  synthesisWins: number;
  critiqueWins: number;
  criticalGaps: string[];
  stylisticPreferences: string[];
  hasCriticalGap: boolean;
} {
  const synthesisWins = votes.filter(v => v.vote === 'synthesis_wins').length;
  const critiqueWins = votes.filter(v => v.vote === 'critique_wins').length;
  
  // Separate critiques by type
  const criticalGaps: string[] = [];
  const stylisticPreferences: string[] = [];
  
  for (const vote of votes) {
    for (const critique of vote.critiques) {
      if (critique.type === 'CRITICAL_GAP') {
        criticalGaps.push(critique.issue);
      } else {
        stylisticPreferences.push(critique.issue);
      }
    }
  }
  
  // Deduplicate
  const uniqueCriticalGaps = [...new Set(criticalGaps)];
  const uniqueStylisticPreferences = [...new Set(stylisticPreferences)];
  
  // HCSP Rule: ANY critical gap = synthesis fails
  const hasCriticalGap = uniqueCriticalGaps.length > 0 || votes.some(v => v.hasCriticalGap);
  const sufficient = hasCriticalGap ? false : (synthesisWins >= critiqueWins);
  
  return {
    sufficient,
    synthesisWins,
    critiqueWins,
    criticalGaps: uniqueCriticalGaps,
    stylisticPreferences: uniqueStylisticPreferences,
    hasCriticalGap,
  };
}

describe('HCSP Vote Aggregation', () => {
  it('synthesis wins when all critiques are stylistic', () => {
    const votes: HCSPVoteDetail[] = [
      { 
        model: 'm1', 
        vote: 'synthesis_wins', 
        reasoning: 'Good', 
        critiques: [{ type: 'STYLISTIC_PREFERENCE', issue: 'Could be more formal' }],
        hasCriticalGap: false,
      },
      { 
        model: 'm2', 
        vote: 'synthesis_wins', 
        reasoning: 'OK', 
        critiques: [],
        hasCriticalGap: false,
      },
    ];
    const result = aggregateVotesHCSP(votes);
    expect(result.sufficient).toBe(true);
    expect(result.hasCriticalGap).toBe(false);
  });

  it('synthesis FAILS when ANY vote has CRITICAL_GAP (even if minority)', () => {
    const votes: HCSPVoteDetail[] = [
      { 
        model: 'm1', 
        vote: 'synthesis_wins', 
        reasoning: 'Good overall', 
        critiques: [],
        hasCriticalGap: false,
      },
      { 
        model: 'm2', 
        vote: 'synthesis_wins', 
        reasoning: 'Adequate', 
        critiques: [],
        hasCriticalGap: false,
      },
      { 
        model: 'm3', 
        vote: 'synthesis_wins',  // Even voted synthesis_wins!
        reasoning: 'Minor issues', 
        critiques: [{ type: 'CRITICAL_GAP', issue: 'Code has TODO placeholder' }],
        hasCriticalGap: true,
      },
    ];
    const result = aggregateVotesHCSP(votes);
    // HCSP: Critical gap overrides the 3-0 vote
    expect(result.sufficient).toBe(false);
    expect(result.hasCriticalGap).toBe(true);
    expect(result.criticalGaps).toContain('Code has TODO placeholder');
  });

  it('separates CRITICAL_GAP from STYLISTIC_PREFERENCE', () => {
    const votes: HCSPVoteDetail[] = [
      { 
        model: 'm1', 
        vote: 'critique_wins', 
        reasoning: 'Issues found', 
        critiques: [
          { type: 'CRITICAL_GAP', issue: 'Missing success criteria' },
          { type: 'STYLISTIC_PREFERENCE', issue: 'Verbose explanation' },
        ],
        hasCriticalGap: true,
      },
      { 
        model: 'm2', 
        vote: 'critique_wins', 
        reasoning: 'Problems', 
        critiques: [
          { type: 'CRITICAL_GAP', issue: 'Undefined threshold value' },
          { type: 'CRITICAL_GAP', issue: 'Missing success criteria' }, // duplicate
        ],
        hasCriticalGap: true,
      },
    ];
    const result = aggregateVotesHCSP(votes);
    expect(result.sufficient).toBe(false);
    expect(result.criticalGaps).toHaveLength(2); // deduped
    expect(result.stylisticPreferences).toHaveLength(1);
    expect(result.criticalGaps).toContain('Missing success criteria');
    expect(result.criticalGaps).toContain('Undefined threshold value');
  });

  it('handles production quality test case from README', () => {
    // Simulates the example from the user's report where critiques were dismissed
    const votes: HCSPVoteDetail[] = [
      { 
        model: 'gemini-1', 
        vote: 'synthesis_wins', 
        reasoning: 'Conceptually answers the question', 
        critiques: [
          { type: 'CRITICAL_GAP', issue: '[FAILED: Success Criteria] No measurable goal defined' },
          { type: 'CRITICAL_GAP', issue: '[FAILED: Code Completeness] Functions are hardcoded logic demos' },
          { type: 'CRITICAL_GAP', issue: '[FAILED: Specificity] Salience 0.7 lacks derivation rubric' },
        ],
        hasCriticalGap: true,
      },
    ];
    const result = aggregateVotesHCSP(votes);
    // With HCSP, these CRITICAL_GAPs should cause failure
    expect(result.sufficient).toBe(false);
    expect(result.hasCriticalGap).toBe(true);
    expect(result.criticalGaps).toHaveLength(3);
  });

  it('handles empty votes', () => {
    const result = aggregateVotesHCSP([]);
    expect(result.sufficient).toBe(true);
    expect(result.hasCriticalGap).toBe(false);
  });
});

// ============================================================================
// Source Citation Validation (Structural - checking against known list)
// ============================================================================

/**
 * Validates that citations reference known/valid sources
 */
export function validateSourceCitations(
  text: string,
  validSources: { arxivIds: string[]; perplexitySources: string[] }
): {
  validCitations: string[];
  invalidCitations: string[];
} {
  const arxivCitations = text.match(/\[arxiv:([\w\d.]+v?\d*)\]/g) || [];
  const perplexityCitations = text.match(/\[perplexity:(\d+)\]/g) || [];
  
  const validCitations: string[] = [];
  const invalidCitations: string[] = [];
  
  for (const citation of arxivCitations) {
    const id = citation.match(/arxiv:([\w\d.]+v?\d*)/)?.[1] || '';
    const isValid = validSources.arxivIds.some(
      validId => validId.includes(id) || id.includes(validId)
    );
    if (isValid) {
      validCitations.push(citation);
    } else {
      invalidCitations.push(citation);
    }
  }
  
  for (const citation of perplexityCitations) {
    const num = parseInt(citation.match(/perplexity:(\d+)/)?.[1] || '0');
    if (num > 0 && num <= validSources.perplexitySources.length) {
      validCitations.push(citation);
    } else {
      invalidCitations.push(citation);
    }
  }
  
  return { validCitations, invalidCitations };
}

describe('Source Citation Validation', () => {
  it('validates known arxiv citations', () => {
    const text = 'According to [arxiv:2309.01431v2], this works.';
    const validSources = { arxivIds: ['2309.01431v2'], perplexitySources: [] };
    const result = validateSourceCitations(text, validSources);
    expect(result.validCitations).toHaveLength(1);
    expect(result.invalidCitations).toHaveLength(0);
  });

  it('flags unknown arxiv citations', () => {
    const text = 'According to [arxiv:fake123], this is hallucinated.';
    const validSources = { arxivIds: ['2309.01431v2'], perplexitySources: [] };
    const result = validateSourceCitations(text, validSources);
    expect(result.invalidCitations).toHaveLength(1);
  });

  it('validates perplexity citation numbers', () => {
    const text = '[perplexity:1] and [perplexity:5]';
    const validSources = { arxivIds: [], perplexitySources: ['u1', 'u2', 'u3'] };
    const result = validateSourceCitations(text, validSources);
    expect(result.validCitations).toHaveLength(1); // [perplexity:1]
    expect(result.invalidCitations).toHaveLength(1); // [perplexity:5] out of range
  });
});

// ============================================================================
// Challenge Response Parsing (Structural)
// ============================================================================

/**
 * Parses challenge critique response - extracts FAILED markers
 */
export function parseChallengeResponse(content: string): {
  critiques: string[];
  hasSignificantGaps: boolean;
} {
  const critiques: string[] = [];
  
  // Look for [FAILED:...] markers
  const failedPattern = /\*?\*?\[FAILED[^\]]*\]\*?\*?\s*([^\n]+)/gi;
  let match;
  while ((match = failedPattern.exec(content)) !== null) {
    critiques.push(match[0].trim());
  }
  
  return {
    critiques,
    hasSignificantGaps: critiques.length > 0,
  };
}

describe('Challenge Response Parsing', () => {
  it('extracts FAILED markers', () => {
    const response = `
**[FAILED: Code]** Missing implementation.
**[FAILED: Specificity]** No numbers provided.
`;
    const result = parseChallengeResponse(response);
    expect(result.critiques).toHaveLength(2);
    expect(result.hasSignificantGaps).toBe(true);
  });

  it('returns empty for no failures', () => {
    const response = 'Everything looks good. No issues found.';
    const result = parseChallengeResponse(response);
    expect(result.critiques).toHaveLength(0);
    expect(result.hasSignificantGaps).toBe(false);
  });
});

// ============================================================================
// Stub for compatibility - semantic detection requires LLM
// ============================================================================

export function detectContradictions(_claims: Array<{ section: string; claim: string }>): {
  contradictions: Array<{ claimA: any; claimB: any; reason: string }>;
  entailmentScore: number;
} {
  // NOTE: Contradiction detection requires LLM-as-a-Judge, not regex.
  console.warn('detectContradictions: Use LLM-as-a-Judge for semantic evaluation');
  return { contradictions: [], entailmentScore: 1 };
}
