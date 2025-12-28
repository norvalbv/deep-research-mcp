/**
 * Benchmark CLI Entry Point
 * 
 * Usage:
 *   npm run benchmark          - HCSP evaluation
 *   npm run benchmark:compare  - MCP vs Perplexity comparison (requires pre-computed responses)
 *   npm run benchmark:generate - Generate responses first
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import type { TaskCategory, EvaluationSample, ComparisonSample } from './types.js';
import { evaluateHCSP, checkHCSPThresholds } from './hcsp.js';
import { generateDecisionMatrix, formatDecisionMatrix } from './decision-matrix.js';
import { compareWithBaseline } from './comparison.js';

interface DatasetSample {
  id: string;
  category: TaskCategory;
  query: string;
  goldStandard: {
    answer: string;
    atomicFacts?: string[];
    sources?: string[];
  };
  responses?: {
    mcp?: string;
    perplexity?: string;
    generatedAt?: string;
  };
  expectedWinner?: string;
  rationale?: string;
}

interface Dataset {
  samples: DatasetSample[];
  metadata: {
    totalSamples: number;
    byCategory: Record<string, number>;
  };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function loadDataset(): Dataset {
  const datasetPath = join(__dirname, 'comparison-dataset.json');
  const content = readFileSync(datasetPath, 'utf-8');
  return JSON.parse(content);
}

const MAX_RESPONSE_AGE_DAYS = 30;

function validateResponses(sample: DatasetSample): { valid: boolean; reason?: string } {
  if (!sample.responses?.mcp) {
    return { valid: false, reason: 'Missing MCP response' };
  }
  if (!sample.responses?.perplexity) {
    return { valid: false, reason: 'Missing Perplexity response' };
  }
  if (!sample.responses.generatedAt) {
    return { valid: false, reason: 'Missing generation timestamp' };
  }
  
  const generatedDate = new Date(sample.responses.generatedAt);
  const ageMs = Date.now() - generatedDate.getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  
  if (ageDays > MAX_RESPONSE_AGE_DAYS) {
    return { valid: false, reason: `Response is ${Math.floor(ageDays)} days old (max: ${MAX_RESPONSE_AGE_DAYS})` };
  }
  
  return { valid: true };
}

async function runComparisonBenchmark(apiKey: string) {
  console.log('='.repeat(80));
  console.log('COMPARATIVE BENCHMARK: MCP vs Perplexity');
  console.log('Based on 8-Module Framework (arxiv:2309.15217)');
  console.log('='.repeat(80));
  console.log('');
  
  const dataset = loadDataset();
  console.log(`Loaded ${dataset.metadata.totalSamples} samples`);
  
  // Validate that responses exist
  const samplesWithResponses = dataset.samples.filter(s => {
    const validation = validateResponses(s);
    return validation.valid;
  });
  
  if (samplesWithResponses.length === 0) {
    console.error('\nERROR: No samples have valid pre-computed responses.');
    console.error('');
    console.error('To generate responses, run:');
    console.error('  GEMINI_API_KEY=key PERPLEXITY_API_KEY=key npm run benchmark:generate');
    console.error('');
    console.error('For a quick test with 5 samples:');
    console.error('  GEMINI_API_KEY=key PERPLEXITY_API_KEY=key npm run benchmark:generate:sample');
    console.error('');
    console.error('Note: MCP research takes ~5 minutes per query. Full dataset generation');
    console.error('may take several hours but enables reproducible, statistically valid benchmarks.');
    process.exit(1);
  }
  
  const sampleLimit = parseInt(process.env.SAMPLE_LIMIT || '10', 10);
  const samples = samplesWithResponses.slice(0, sampleLimit);
  console.log(`Samples with valid responses: ${samplesWithResponses.length}`);
  console.log(`Running on ${samples.length} samples (set SAMPLE_LIMIT for more)...\n`);
  
  const results: Array<{
    sample: ComparisonSample;
    winner: 'system' | 'baseline' | 'tie';
    systemScore: number;
    baselineScore: number;
  }> = [];
  
  const BATCH_SIZE = 10;
  
  for (let batchStart = 0; batchStart < samples.length; batchStart += BATCH_SIZE) {
    const batch = samples.slice(batchStart, batchStart + BATCH_SIZE);
    const batchNum = Math.floor(batchStart / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(samples.length / BATCH_SIZE);
    
    console.log(`\nProcessing batch ${batchNum}/${totalBatches} (${batch.length} samples)...`);
    
    const batchPromises = batch.map(async (sample, idx) => {
      const globalIdx = batchStart + idx;
      console.log(`[${globalIdx + 1}/${samples.length}] ${sample.category}: ${sample.query.slice(0, 50)}...`);
      
      try {
        // Use pre-computed responses (validated above)
        const mcpResponse = sample.responses!.mcp!;
        const perplexityResponse = sample.responses!.perplexity!;
        
        const evalSample: EvaluationSample = {
          id: sample.id,
          type: sample.category === 'multi_hop_reasoning' ? 'multi_hop' 
              : sample.category === 'synthesis' ? 'synthesis' : 'factual',
          category: sample.category,
          query: sample.query,
          contextSources: [],
          goldStandard: {
            answer: sample.goldStandard.answer,
            mustCite: sample.goldStandard.sources || [],
            mustIdentifyConflict: false,
            rubric: {},
            atomicFacts: sample.goldStandard.atomicFacts,
          },
        };
        
        const comparison = await compareWithBaseline(evalSample, mcpResponse, perplexityResponse, apiKey);
        
        const result = {
          sample: {
            id: sample.id,
            category: sample.category,
            query: sample.query,
            goldStandard: sample.goldStandard,
            expectedWinner: sample.expectedWinner as 'mcp' | 'perplexity' | 'tie',
            rationale: sample.rationale,
          },
          winner: comparison.winner,
          systemScore: comparison.systemScore,
          baselineScore: comparison.baselineScore,
        };
        
        const winnerLabel = comparison.winner === 'system' ? 'MCP' 
                          : comparison.winner === 'baseline' ? 'Perplexity' : 'Tie';
        console.log(`[${globalIdx + 1}/${samples.length}] -> ${winnerLabel} (MCP: ${comparison.systemScore}, Perplexity: ${comparison.baselineScore})`);
        
        return { success: true, result };
        
      } catch (error) {
        console.log(`[${globalIdx + 1}/${samples.length}] -> Error: ${error}`);
        return { success: false, error };
      }
    });
    
    const batchResults = await Promise.all(batchPromises);
    
    // Collect successful results
    batchResults.forEach(r => {
      if (r.success && r.result) {
        results.push(r.result);
      }
    });
    
    // Rate limiting between batches
    if (batchStart + BATCH_SIZE < samples.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  
  console.log('\nGenerating decision matrix...\n');
  const matrix = generateDecisionMatrix(results);
  console.log(formatDecisionMatrix(matrix));
  
  // Save results
  try {
    mkdirSync(join(__dirname, 'results'), { recursive: true });
    const resultsPath = join(__dirname, 'results', `comparison-${Date.now()}.json`);
    writeFileSync(resultsPath, JSON.stringify({ matrix, results }, null, 2));
    console.log(`\nResults saved to: ${resultsPath}`);
  } catch {
    // Ignore save errors
  }
}

async function runHCSPBenchmark(apiKey: string) {
  console.log('='.repeat(60));
  console.log('Research MCP Benchmark Evaluator');
  console.log('='.repeat(60));
  console.log('\nRunning HCSP evaluation...\n');
  
  const sampleSynthesis = `
## Overview
The recommended threshold is 0.85 based on research [arxiv:2310.03025].
Implementation requires 27 hours across three phases.

## Key Findings
- Phase 1 (Setup): 10 hours
- Phase 2 (Implementation): 12 hours  
- Phase 3 (Testing): 5 hours

Target p95 latency: under 200ms.
Memory usage: approximately 2.5GB peak.

\`\`\`typescript
async function callAPI(prompt: string): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await client.chat(prompt);
      return response.content;
    } catch (error) {
      if (attempt === 2) throw error;
      await sleep(2 ** attempt * 1000);
    }
  }
  throw new Error('All retries failed');
}
\`\`\`
  `;
  
  const constraints = [
    'Specify numeric threshold value',
    'Include time estimates',
    'Provide executable code example',
    'Cite research sources',
    'Include performance metrics',
  ];
  
  const result = await evaluateHCSP(sampleSynthesis, constraints, apiKey);
  
  console.log('HCSP Evaluation Results:');
  console.log('-'.repeat(40));
  console.log(`CCR: ${(result.ccr * 100).toFixed(1)}%`);
  console.log(`  Satisfied: ${result.satisfiedConstraints.join(', ') || 'none'}`);
  console.log(`  Failed: ${result.failedConstraints.join(', ') || 'none'}`);
  console.log(`Citation Fidelity: ${(result.citationFidelity * 100).toFixed(1)}%`);
  console.log(`Specificity Score: ${result.specificityScore}/5`);
  console.log(`Has Critical Gap: ${result.hasCriticalGap}`);
  
  if (result.critiques.length > 0) {
    console.log('\nCritiques:');
    for (const critique of result.critiques) {
      console.log(`  [${critique.type}] ${critique.issue}`);
    }
  }
  
  const check = checkHCSPThresholds({
    avgCCR: result.ccr,
    avgCitationFidelity: result.citationFidelity,
    avgSpecificityScore: result.specificityScore,
    criticalGapCount: result.critiques.filter(c => c.type === 'CRITICAL_GAP').length,
    samplesWithCriticalGaps: result.hasCriticalGap ? 1 : 0,
  });
  
  const passed = check.ccr && check.citationFidelity && check.specificityScore && check.noCriticalGaps;
  
  console.log('\nThreshold Check:');
  console.log(`  Overall: ${passed ? 'PASSED' : 'FAILED'}`);
  console.log(`  CCR >= 90%: ${check.ccr ? 'PASS' : 'FAIL'}`);
  console.log(`  Citation Fidelity >= 95%: ${check.citationFidelity ? 'PASS' : 'FAIL'}`);
  console.log(`  Specificity >= 4.0: ${check.specificityScore ? 'PASS' : 'FAIL'}`);
  console.log(`  No Critical Gaps: ${check.noCriticalGaps ? 'PASS' : 'FAIL'}`);
  
  console.log('\n' + '='.repeat(60));
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  
  if (!apiKey) {
    console.error('Error: GEMINI_API_KEY required');
    console.log('\nUsage:');
    console.log('  GEMINI_API_KEY=key npm run benchmark');
    console.log('  GEMINI_API_KEY=key npm run benchmark:compare');
    process.exit(1);
  }

  const mode = process.argv.includes('--compare') ? 'compare' 
             : process.argv.includes('--full') ? 'compare'
             : 'hcsp';

  if (mode === 'compare') {
    await runComparisonBenchmark(apiKey);
  } else {
    await runHCSPBenchmark(apiKey);
  }
}

main().catch(console.error);

