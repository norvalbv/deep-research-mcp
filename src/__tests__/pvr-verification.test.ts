/**
 * PVR Verification Tests
 * 
 * Uses golden test cases to verify consistency detection.
 * Based on arxiv:2303.16634 (G-Eval) methodology.
 * 
 * Run with: npm run test:pvr
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { runPVRVerification, getPVRConfig } from '../validation.js';
import { SynthesisOutput } from '../synthesis.js';
import { GlobalManifest } from '../types/index.js';
import goldenCases from './golden-cases.json';

// Configuration
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const RUN_LIVE_TESTS = GEMINI_API_KEY && process.env.RUN_LIVE_TESTS === 'true';

interface ConsistencyExpectation {
  isConsistent: boolean;
  entailmentScoreMin?: number;
  minContradictions?: number;
  severity?: string;
  notes?: string;
}

interface ProductionExpectation {
  isProductionReady: boolean;
  failureType?: string;
  notes?: string;
}

interface TestCase {
  id: string;
  description: string;
  category: string;
  sections: Record<string, string>;
  expected: ConsistencyExpectation | ProductionExpectation;
}

/**
 * Convert test case sections to SynthesisOutput format
 */
function sectionsToSynthesis(sections: Record<string, string>): SynthesisOutput {
  const output: SynthesisOutput = {
    overview: sections.overview || '',
  };

  const subQKeys = Object.keys(sections).filter(k => k.startsWith('q'));
  if (subQKeys.length > 0) {
    output.subQuestions = {};
    for (const key of subQKeys) {
      output.subQuestions[key] = {
        question: `Sub-question ${key}`,
        answer: sections[key],
      };
    }
  }

  return output;
}

/**
 * Create empty manifest for testing
 */
function createTestManifest(): GlobalManifest {
  return {
    keyFacts: [],
    numerics: {},
    sources: [],
    extractedAt: Date.now(),
  };
}

describe('PVR Configuration', () => {
  it('has correct default thresholds', () => {
    const config = getPVRConfig();
    expect(config.ENTAILMENT_THRESHOLD).toBe(0.85);
    expect(config.VERIFICATION_TIMEOUT_MS).toBe(15000);
    expect(config.MAX_REROLL_ATTEMPTS).toBe(2);
  });
});

describe('Golden Test Cases - Structure Validation', () => {
  const testCases = goldenCases.testCases as TestCase[];
  
  it('has test cases loaded', () => {
    expect(testCases.length).toBeGreaterThan(0);
  });

  it('all test cases have required fields', () => {
    for (const tc of testCases) {
      expect(tc.id).toBeDefined();
      expect(tc.category).toBeDefined();
      expect(tc.sections).toBeDefined();
      expect(tc.expected).toBeDefined();
      // Consistency tests use isConsistent, failure mode tests use isProductionReady
      const hasConsistencyExpectation = 'isConsistent' in tc.expected;
      const hasProductionExpectation = 'isProductionReady' in tc.expected;
      expect(hasConsistencyExpectation || hasProductionExpectation).toBe(true);
    }
  });

  it('converts sections to synthesis format correctly', () => {
    const sections = { overview: 'Test overview', q1: 'Answer 1' };
    const synthesis = sectionsToSynthesis(sections);
    expect(synthesis.overview).toBe('Test overview');
    expect(synthesis.subQuestions?.q1?.answer).toBe('Answer 1');
  });
});

describe('PVR Live Verification', () => {
  const testCases = goldenCases.testCases as TestCase[];

  beforeAll(() => {
    if (!RUN_LIVE_TESTS) {
      console.log('Live tests skipped (set GEMINI_API_KEY and RUN_LIVE_TESTS=true)');
    }
  });

  // Type guard for consistency test cases
  function isConsistencyTestCase(tc: TestCase): tc is TestCase & { expected: ConsistencyExpectation } {
    return 'isConsistent' in tc.expected;
  }

  // Only run live tests if API key is available
  it.skipIf(!RUN_LIVE_TESTS)('runs contradiction detection on golden cases', async () => {
    const contradictionCases = testCases
      .filter(tc => tc.category === 'contradiction')
      .filter(isConsistencyTestCase);
    
    for (const tc of contradictionCases.slice(0, 2)) { // Limit to 2 for speed
      const synthesis = sectionsToSynthesis(tc.sections);
      const manifest = createTestManifest();
      
      const result = await runPVRVerification(synthesis, manifest, GEMINI_API_KEY!);
      
      expect(result.isConsistent).toBe(tc.expected.isConsistent);
    }
  }, 60000);

  it.skipIf(!RUN_LIVE_TESTS)('runs consistency validation on golden cases', async () => {
    const consistencyCases = testCases
      .filter(tc => tc.category === 'consistency')
      .filter(isConsistencyTestCase);
    
    for (const tc of consistencyCases.slice(0, 2)) { // Limit to 2 for speed
      const synthesis = sectionsToSynthesis(tc.sections);
      const manifest = createTestManifest();
      
      const result = await runPVRVerification(synthesis, manifest, GEMINI_API_KEY!);
      
      expect(result.isConsistent).toBe(tc.expected.isConsistent);
    }
  }, 60000);
});
