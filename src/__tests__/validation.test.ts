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
import { safeParseJSON, parseVoteResponse, aggregateVotesHCSP } from '../validation.js';
import { validateSourceCitations } from './helpers/source-citations.js';

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
// Vote Parsing + Aggregation (REAL validation.ts implementation)
// ============================================================================

describe('parseVoteResponse (4-tier taxonomy)', () => {
  it('parses JSON and normalizes categories + default section', () => {
    const response = `\`\`\`json
{
  "vote": "synthesis_wins",
  "reasoning": "OK",
  "critiques": [
    {"category": "CRITICAL", "section": "overview", "issue": "Missing success criteria"},
    {"category": "MAJOR", "section": "q1", "issue": "Incorrect threshold"},
    {"category": "PEDANTIC", "issue": "Minor wording"}
  ]
}
\`\`\``;

    const parsed = parseVoteResponse(response, 'model-a');
    expect(parsed.model).toBe('model-a');
    expect(parsed.vote).toBe('critique_wins'); // 1+ CRITICAL forces critique_wins
    expect(parsed.counts.critical).toBe(1);
    expect(parsed.counts.major).toBe(1);
    expect(parsed.counts.pedantic).toBe(1);
    expect(parsed.critiques.find(c => c.issue === 'Minor wording')?.section).toBe('overview');
  });

  it('defaults to synthesis_wins on parse failure', () => {
    const parsed = parseVoteResponse('not json', 'model-b');
    expect(parsed.vote).toBe('synthesis_wins');
    expect(parsed.critiques).toHaveLength(0);
  });
});

describe('aggregateVotesHCSP (threshold aggregation)', () => {
  it('passes when only MINOR/PEDANTIC issues exist', () => {
    const v1 = parseVoteResponse(
      JSON.stringify({
        vote: 'synthesis_wins',
        reasoning: 'fine',
        critiques: [{ category: 'MINOR', section: 'overview', issue: 'Could be more concise' }],
      }),
      'm1'
    );
    const v2 = parseVoteResponse(
      JSON.stringify({
        vote: 'synthesis_wins',
        reasoning: 'fine',
        critiques: [{ category: 'PEDANTIC', section: 'overview', issue: 'Typo' }],
      }),
      'm2'
    );

    const result = aggregateVotesHCSP([v1, v2]);
    expect(result.sufficient).toBe(true);
    expect(result.hasCriticalGap).toBe(false);
    expect(result.criticalGaps).toHaveLength(0);
    expect(result.stylisticPreferences).toContain('Could be more concise');
    expect(result.stylisticPreferences).toContain('Typo');
  });

  it('fails when any CRITICAL issue exists', () => {
    const v1 = parseVoteResponse(
      JSON.stringify({
        vote: 'synthesis_wins',
        reasoning: 'fine',
        critiques: [{ category: 'CRITICAL', section: 'overview', issue: 'Missing executable code' }],
      }),
      'm1'
    );
    const v2 = parseVoteResponse(
      JSON.stringify({ vote: 'synthesis_wins', reasoning: 'fine', critiques: [] }),
      'm2'
    );

    const result = aggregateVotesHCSP([v1, v2]);
    expect(result.sufficient).toBe(false);
    expect(result.hasCriticalGap).toBe(true);
    expect(result.criticalGaps).toContain('Missing executable code');
    expect(result.failingSections).toContain('overview');
  });

  it('fails when 3+ MAJOR issues exist and no CRITICAL issues', () => {
    const v1 = parseVoteResponse(
      JSON.stringify({
        vote: 'synthesis_wins',
        reasoning: 'fine',
        critiques: [
          { category: 'MAJOR', section: 'q1', issue: 'Gap A' },
          { category: 'MAJOR', section: 'q1', issue: 'Gap B' },
          { category: 'MAJOR', section: 'q1', issue: 'Gap C' },
        ],
      }),
      'm1'
    );
    const v2 = parseVoteResponse(
      JSON.stringify({ vote: 'synthesis_wins', reasoning: 'fine', critiques: [] }),
      'm2'
    );
    const v3 = parseVoteResponse(
      JSON.stringify({ vote: 'synthesis_wins', reasoning: 'fine', critiques: [] }),
      'm3'
    );

    // Median MAJOR count across [3,0,0] => 0, so this should PASS.
    // This test ensures we don't accidentally treat single-model spikes as failure.
    const passResult = aggregateVotesHCSP([v1, v2, v3]);
    expect(passResult.sufficient).toBe(true);

    // Make it a real majority signal: [3,3,0] median => 3 => FAIL.
    const v4 = parseVoteResponse(
      JSON.stringify({
        vote: 'synthesis_wins',
        reasoning: 'fine',
        critiques: [
          { category: 'MAJOR', section: 'q1', issue: 'Gap A' },
          { category: 'MAJOR', section: 'q1', issue: 'Gap B' },
          { category: 'MAJOR', section: 'q1', issue: 'Gap C' },
        ],
      }),
      'm4'
    );
    const failResult = aggregateVotesHCSP([v1, v4, v2]);
    expect(failResult.sufficient).toBe(false);
    expect(failResult.hasCriticalGap).toBe(true); // hasCriticalGap is true when failure thresholds triggered
    expect(failResult.failingSections).toContain('q1');
    expect(failResult.criticalGaps.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// Source Citation Validation (Structural - checking against known list)
// ============================================================================

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
// Challenge Response Parsing - Section Attribution Tests
// ============================================================================

import { parseChallengeResponse, ChallengeCritique } from '../challenge-parser.js';

describe('Challenge Response Parsing - Section Attribution', () => {
  it('preserves section attribution from structured JSON', () => {
    const response = `\`\`\`json
{
  "pass": false,
  "critiques": [
    { "section": "q1", "issue": "Missing evidence for claim X" },
    { "section": "q2", "issue": "Contradicts overview" },
    { "section": "overview", "issue": "Does not answer main query" }
  ]
}
\`\`\``;
    const result = parseChallengeResponse(response);
    
    expect(result.hasSignificantGaps).toBe(true);
    expect(result.critiques).toHaveLength(3);
    
    // Verify section attribution preserved
    expect(result.critiques[0]).toEqual({ section: 'q1', issue: 'Missing evidence for claim X' });
    expect(result.critiques[1]).toEqual({ section: 'q2', issue: 'Contradicts overview' });
    expect(result.critiques[2]).toEqual({ section: 'overview', issue: 'Does not answer main query' });
  });

  it('defaults to overview section for critiques without section', () => {
    const response = `{
      "pass": false,
      "critiques": [
        { "issue": "Some problem without section" },
        { "section": "q3", "issue": "Specific problem in q3" }
      ]
    }`;
    const result = parseChallengeResponse(response);
    
    expect(result.critiques[0]).toEqual({ section: 'overview', issue: 'Some problem without section' });
    expect(result.critiques[1]).toEqual({ section: 'q3', issue: 'Specific problem in q3' });
  });

  it('returns pass=true with empty critiques', () => {
    const response = `{ "pass": true, "critiques": [] }`;
    const result = parseChallengeResponse(response);
    
    expect(result.hasSignificantGaps).toBe(false);
    expect(result.critiques).toHaveLength(0);
  });

  it('handles malformed JSON gracefully (fail-safe)', () => {
    const response = `This is not JSON at all, just text explaining issues`;
    const result = parseChallengeResponse(response);
    
    // Should treat unparseable as having gaps
    expect(result.hasSignificantGaps).toBe(true);
    expect(result.critiques.length).toBeGreaterThan(0);
    expect(result.critiques[0].section).toBe('overview');
  });
});

// ============================================================================
// Stub for compatibility - semantic detection requires LLM
// ============================================================================

// (No exports from this file; shared helpers live in __tests__/helpers/*)
