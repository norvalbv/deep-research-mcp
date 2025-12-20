/**
 * End-to-End Research Flow Tests
 * 
 * Tests the structural aspects of the research pipeline.
 * Semantic evaluation should use the benchmark suite with LLM-as-a-Judge.
 * 
 * Run with: npm run test
 */

import { describe, it, expect } from 'vitest';
import { extractCitations, parseSections, extractCodeBlocks } from '../synthesis.test.js';
import { parseVoteResponse, aggregateVotesHCSP, validateSourceCitations } from '../validation.test.js';

// ============================================================================
// Mock Research Output
// ============================================================================

const MOCK_SYNTHESIS = `
<!-- SECTION:overview -->
## Overview

RAG systems combine retrieval and generation [arxiv:2309.01431v2]. Key points:
- Retrieval accuracy matters [perplexity:1]
- Use semantic search [context7:langchain]

\`\`\`python
class RAGPipeline:
    def __init__(self):
        self.threshold = 0.85
    
    def query(self, text):
        return self.retriever.search(text)
\`\`\`

<!-- SECTION:q1 -->
## Q1: Best Practices

Chunking should use 256-512 tokens [perplexity:2].

<!-- SECTION:additional_insights -->
## Additional Insights

Monitor latency in production.
`;

// ============================================================================
// Structural Tests
// ============================================================================

describe('Citation Extraction', () => {
  it('extracts all citation types from synthesis', () => {
    const result = extractCitations(MOCK_SYNTHESIS);
    expect(result.arxiv.length).toBeGreaterThan(0);
    expect(result.perplexity.length).toBeGreaterThan(0);
    expect(result.context7.length).toBeGreaterThan(0);
  });

  it('counts total citations', () => {
    const result = extractCitations(MOCK_SYNTHESIS);
    expect(result.total).toBe(4); // 1 arxiv + 2 perplexity + 1 context7
  });
});

describe('Section Parsing', () => {
  it('parses all sections from synthesis', () => {
    const result = parseSections(MOCK_SYNTHESIS);
    expect(result.sectionOrder).toContain('overview');
    expect(result.sectionOrder).toContain('q1');
    expect(result.sectionOrder).toContain('additional_insights');
  });

  it('extracts section content', () => {
    const result = parseSections(MOCK_SYNTHESIS);
    expect(result.sections.overview).toContain('RAG systems');
    expect(result.sections.q1).toContain('Chunking');
  });
});

describe('Code Block Extraction', () => {
  it('extracts Python code blocks', () => {
    const result = extractCodeBlocks(MOCK_SYNTHESIS);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].language).toBe('python');
    expect(result[0].isComplete).toBe(true);
  });
});

describe('Source Validation', () => {
  it('validates citations against known sources', () => {
    const validSources = {
      arxivIds: ['2309.01431v2'],
      perplexitySources: ['url1', 'url2', 'url3'],
    };
    const result = validateSourceCitations(MOCK_SYNTHESIS, validSources);
    expect(result.validCitations.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// Vote Pipeline Tests (HCSP)
// ============================================================================

describe('Vote Pipeline (HCSP)', () => {
  it('parses and aggregates votes correctly with HCSP', () => {
    // HCSP votes with critiques array
    const votes = [
      { 
        model: 'model-0', 
        vote: 'synthesis_wins' as const, 
        reasoning: 'Good',
        critiques: [],
        hasCriticalGap: false,
      },
      { 
        model: 'model-1', 
        vote: 'synthesis_wins' as const, 
        reasoning: 'OK',
        critiques: [{ type: 'STYLISTIC_PREFERENCE' as const, issue: 'Minor wording' }],
        hasCriticalGap: false,
      },
      { 
        model: 'model-2', 
        vote: 'synthesis_wins' as const, 
        reasoning: 'Fine',
        critiques: [],
        hasCriticalGap: false,
      },
    ];
    
    const result = aggregateVotesHCSP(votes);
    
    expect(result.synthesisWins).toBe(3);
    expect(result.critiqueWins).toBe(0);
    expect(result.sufficient).toBe(true);
    expect(result.hasCriticalGap).toBe(false);
  });

  it('fails when critical gap exists despite majority synthesis wins', () => {
    const votes = [
      { 
        model: 'm1', 
        vote: 'synthesis_wins' as const, 
        reasoning: 'Good overall',
        critiques: [{ type: 'CRITICAL_GAP' as const, issue: 'Missing implementation' }],
        hasCriticalGap: true,
      },
      { 
        model: 'm2', 
        vote: 'synthesis_wins' as const, 
        reasoning: 'OK',
        critiques: [],
        hasCriticalGap: false,
      },
      { 
        model: 'm3', 
        vote: 'synthesis_wins' as const, 
        reasoning: 'Adequate',
        critiques: [],
        hasCriticalGap: false,
      },
    ];
    
    const result = aggregateVotesHCSP(votes);
    // HCSP: Critical gap overrides vote count
    expect(result.sufficient).toBe(false);
    expect(result.hasCriticalGap).toBe(true);
    expect(result.criticalGaps).toContain('Missing implementation');
  });

  it('handles all critique wins with critical gaps', () => {
    const votes = [
      { 
        model: 'm1', 
        vote: 'critique_wins' as const, 
        reasoning: 'Bad',
        critiques: [{ type: 'CRITICAL_GAP' as const, issue: 'A' }],
        hasCriticalGap: true,
      },
      { 
        model: 'm2', 
        vote: 'critique_wins' as const, 
        reasoning: 'Bad',
        critiques: [{ type: 'CRITICAL_GAP' as const, issue: 'B' }],
        hasCriticalGap: true,
      },
      { 
        model: 'm3', 
        vote: 'critique_wins' as const, 
        reasoning: 'Bad',
        critiques: [{ type: 'CRITICAL_GAP' as const, issue: 'C' }],
        hasCriticalGap: true,
      },
    ];
    
    const result = aggregateVotesHCSP(votes);
    expect(result.sufficient).toBe(false);
    expect(result.criticalGaps).toHaveLength(3);
    expect(result.hasCriticalGap).toBe(true);
  });
});
