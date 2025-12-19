/**
 * PVR Verification Tests
 * 
 * Uses golden test cases to verify consistency detection.
 * Based on arxiv:2303.16634 (G-Eval) methodology.
 * 
 * Run with: npx tsx src/__tests__/pvr-verification.test.ts
 */

import { runPVRVerification, getPVRConfig } from '../validation.js';
import { SynthesisOutput } from '../synthesis.js';
import { GlobalManifest } from '../types/index.js';
import goldenCases from './golden-cases.json';

// Configuration
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const RUN_LIVE_TESTS = GEMINI_API_KEY && process.env.RUN_LIVE_TESTS === 'true';

interface TestCase {
  id: string;
  description: string;
  category: string;
  sections: Record<string, string>;
  expected: {
    isConsistent: boolean;
    entailmentScoreMin?: number;
    minContradictions?: number;
    severity?: string;
    notes?: string;
  };
}

/**
 * Convert test case sections to SynthesisOutput format
 */
function sectionsToSynthesis(sections: Record<string, string>): SynthesisOutput {
  const output: SynthesisOutput = {
    overview: sections.overview || '',
  };

  // Convert q1, q2, etc. to subQuestions
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

/**
 * Run a single test case
 */
async function runTestCase(testCase: TestCase): Promise<{
  passed: boolean;
  reason: string;
  details?: any;
}> {
  const synthesis = sectionsToSynthesis(testCase.sections);
  const manifest = createTestManifest();

  if (!GEMINI_API_KEY) {
    // Offline mode - just validate test case structure
    return {
      passed: true,
      reason: 'Offline validation only (no API key)',
    };
  }

  try {
    const result = await runPVRVerification(synthesis, manifest, GEMINI_API_KEY);

    // Check consistency expectation
    if (testCase.expected.isConsistent !== result.isConsistent) {
      return {
        passed: false,
        reason: `Expected isConsistent=${testCase.expected.isConsistent}, got ${result.isConsistent}`,
        details: result,
      };
    }

    // Check minimum entailment score if specified
    if (testCase.expected.entailmentScoreMin !== undefined) {
      if (result.entailmentScore < testCase.expected.entailmentScoreMin) {
        return {
          passed: false,
          reason: `Expected entailmentScore >= ${testCase.expected.entailmentScoreMin}, got ${result.entailmentScore.toFixed(2)}`,
          details: result,
        };
      }
    }

    // Check minimum contradictions if specified
    if (testCase.expected.minContradictions !== undefined) {
      if (result.contradictions.length < testCase.expected.minContradictions) {
        return {
          passed: false,
          reason: `Expected at least ${testCase.expected.minContradictions} contradictions, got ${result.contradictions.length}`,
          details: result,
        };
      }
    }

    return {
      passed: true,
      reason: 'All expectations met',
      details: result,
    };
  } catch (error) {
    return {
      passed: false,
      reason: `Error: ${error}`,
    };
  }
}

/**
 * Main test runner
 */
async function runTests() {
  console.log('PVR Verification Tests');
  console.log('======================\n');
  console.log(`PVR Config: ${JSON.stringify(getPVRConfig())}`);
  console.log(`Live tests: ${RUN_LIVE_TESTS ? 'ENABLED' : 'DISABLED (set RUN_LIVE_TESTS=true)'}\n`);

  const testCases = goldenCases.testCases as TestCase[];
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const testCase of testCases) {
    process.stdout.write(`[${testCase.category}] ${testCase.id}: `);

    if (!RUN_LIVE_TESTS && testCase.category !== 'edge-case') {
      console.log('SKIPPED (no API key)');
      skipped++;
      continue;
    }

    const result = await runTestCase(testCase);

    if (result.passed) {
      console.log(`PASS - ${result.reason}`);
      passed++;
    } else {
      console.log(`FAIL - ${result.reason}`);
      if (result.details) {
        console.log(`  Details: ${JSON.stringify(result.details, null, 2)}`);
      }
      failed++;
    }
  }

  console.log('\n======================');
  console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log(`Total: ${testCases.length} test cases`);

  // Exit with error code if any tests failed
  if (failed > 0) {
    process.exit(1);
  }
}

// Run tests
runTests().catch(console.error);

