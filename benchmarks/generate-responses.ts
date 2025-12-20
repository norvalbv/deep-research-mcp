/**
 * Response Generation Script
 * 
 * Pre-computes MCP and Perplexity responses for reproducible benchmarking.
 * Based on Silver-to-Gold Pipeline (R-115249) methodology.
 * 
 * Usage:
 *   npm run benchmark:generate              # Generate all missing responses
 *   npm run benchmark:generate:sample       # Generate 5 samples (quick test)
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { ResearchController } from '../src/controller.js';
import { queryPerplexity } from './perplexity-client.js';
import type { TaskCategory } from './types.js';

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
  $schema?: string;
  version?: string;
  description?: string;
  methodology?: Record<string, string>;
  responseSchema?: Record<string, unknown>;
  samples: DatasetSample[];
  metadata: {
    totalSamples: number;
    byCategory: Record<string, number>;
  };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const datasetPath = join(__dirname, 'comparison-dataset.json');

function loadDataset(): Dataset {
  const content = readFileSync(datasetPath, 'utf-8');
  return JSON.parse(content);
}

function saveDataset(dataset: Dataset): void {
  writeFileSync(datasetPath, JSON.stringify(dataset, null, 2));
}

async function generateMCPResponse(query: string, geminiApiKey: string): Promise<string> {
  const controller = new ResearchController({
    GEMINI_API_KEY: geminiApiKey,
    PERPLEXITY_API_KEY: process.env.PERPLEXITY_API_KEY || '',
  });
  
  await controller.initialize();
  
  const result = await controller.execute({
    query,
    enrichedContext: '',
    depthLevel: 3, // Medium depth for benchmark consistency
    options: {
      outputFormat: 'detailed',
      includeCodeExamples: true,
    },
  });
  
  return result.markdown;
}

async function generatePerplexityResponse(
  query: string,
  perplexityApiKey: string
): Promise<string> {
  const response = await queryPerplexity(query, perplexityApiKey);
  return response.content;
}

function hasValidResponses(sample: DatasetSample, maxAgeDays = 30): boolean {
  if (!sample.responses?.mcp || !sample.responses?.perplexity) {
    return false;
  }
  
  if (!sample.responses.generatedAt) {
    return false;
  }
  
  const generatedDate = new Date(sample.responses.generatedAt);
  const ageMs = Date.now() - generatedDate.getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  
  return ageDays <= maxAgeDays;
}

async function main() {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  const perplexityApiKey = process.env.PERPLEXITY_API_KEY;
  
  if (!geminiApiKey || !perplexityApiKey) {
    console.error('Error: Both GEMINI_API_KEY and PERPLEXITY_API_KEY are required');
    console.log('\nUsage:');
    console.log('  GEMINI_API_KEY=key PERPLEXITY_API_KEY=key npm run benchmark:generate');
    process.exit(1);
  }
  
  const sampleLimit = parseInt(process.env.SAMPLE_LIMIT || '0', 10);
  const forceRegenerate = process.argv.includes('--force');
  
  console.log('='.repeat(60));
  console.log('Response Generation for Comparative Benchmarking');
  console.log('Based on Silver-to-Gold Pipeline (R-115249)');
  console.log('='.repeat(60));
  console.log('');
  
  const dataset = loadDataset();
  let samplesToProcess = dataset.samples;
  
  // Filter to samples needing responses (unless --force)
  if (!forceRegenerate) {
    samplesToProcess = samplesToProcess.filter(s => !hasValidResponses(s));
  }
  
  // Apply sample limit
  if (sampleLimit > 0) {
    samplesToProcess = samplesToProcess.slice(0, sampleLimit);
  }
  
  console.log(`Total samples in dataset: ${dataset.samples.length}`);
  console.log(`Samples to process: ${samplesToProcess.length}`);
  console.log(`Force regenerate: ${forceRegenerate}`);
  console.log('');
  
  if (samplesToProcess.length === 0) {
    console.log('All samples have valid responses. Use --force to regenerate.');
    return;
  }
  
  let successCount = 0;
  let errorCount = 0;
  
  for (let i = 0; i < samplesToProcess.length; i++) {
    const sample = samplesToProcess[i];
    console.log(`[${i + 1}/${samplesToProcess.length}] ${sample.id}: ${sample.query.slice(0, 50)}...`);
    
    try {
      // Generate MCP response (this takes ~5 minutes)
      console.log('  Generating MCP response...');
      const mcpResponse = await generateMCPResponse(sample.query, geminiApiKey);
      
      // Generate Perplexity response (fast)
      console.log('  Generating Perplexity response...');
      const perplexityResponse = await generatePerplexityResponse(sample.query, perplexityApiKey);
      
      // Update sample in dataset
      sample.responses = {
        mcp: mcpResponse,
        perplexity: perplexityResponse,
        generatedAt: new Date().toISOString(),
      };
      
      // Save after each successful generation (in case of interruption)
      saveDataset(dataset);
      
      console.log('  Done');
      successCount++;
      
    } catch (error) {
      console.error(`  Error: ${error}`);
      errorCount++;
    }
    
    // Rate limiting between samples
    await new Promise(r => setTimeout(r, 1000));
  }
  
  console.log('');
  console.log('='.repeat(60));
  console.log(`Generation complete: ${successCount} success, ${errorCount} errors`);
  console.log('='.repeat(60));
}

main().catch(console.error);


