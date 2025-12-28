/**
 * Response Generation Script
 * 
 * Pre-computes MCP and Perplexity responses for reproducible benchmarking.
 * Based on Silver-to-Gold Pipeline (R-115249) methodology.
 * 
 * Usage:
 *   npm run benchmark:generate              # Generate all missing responses
 *   npm run benchmark:generate:sample       # Generate 5 samples (quick test)
 *   npm run benchmark:generate -- --category synthesis --force   # Regenerate only synthesis samples
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { ResearchController } from '../src/controller.js';
import { queryPerplexity } from './perplexity-client.js';
import type { TaskCategory } from './types.js';

export type OutputFormat = 'summary' | 'detailed' | 'actionable_steps' | 'direct';

interface DatasetSample {
  id: string;
  category: TaskCategory;
  query: string;
  context?: string;  // Optional context for RAG-style queries
  outputFormat?: OutputFormat;  // Per-sample output format override
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

async function generateMCPResponse(
  query: string,
  geminiApiKey: string,
  options: { context?: string; outputFormat?: OutputFormat; depthLevel?: 1 | 2 | 3 | 4 } = {}
): Promise<string> {
  const controller = new ResearchController({
    GEMINI_API_KEY: geminiApiKey,
    PERPLEXITY_API_KEY: process.env.PERPLEXITY_API_KEY || '',
  });
  
  await controller.initialize();
  
  const result = await controller.execute({
    query,
    enrichedContext: options.context ?? '',
    depthLevel: options.depthLevel,
    options: {
      outputFormat: options.outputFormat,
    },
  });
  
  return result.markdown;
}

async function generatePerplexityResponse(
  query: string,
  perplexityApiKey: string,
  context?: string
): Promise<string> {
  // Build query with context if provided (for RAG-style fairness)
  const fullQuery = context
    ? `Context:\n${context}\n\nQuestion:\n${query}\n\nRules: Use ONLY the provided context to answer.`
    : query;
  
  const response = await queryPerplexity(fullQuery, perplexityApiKey);
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

function getArgValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('-')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
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
  const categoryFilter = getArgValue('--category');
  
  console.log('='.repeat(60));
  console.log('Response Generation for Comparative Benchmarking');
  console.log('Based on Silver-to-Gold Pipeline (R-115249)');
  console.log('='.repeat(60));
  console.log('');
  
  const dataset = loadDataset();
  let samplesToProcess = dataset.samples;

  // Optional category filter
  if (categoryFilter) {
    samplesToProcess = samplesToProcess.filter(s => s.category === categoryFilter);
  }
  
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
  if (categoryFilter) console.log(`Category filter: ${categoryFilter}`);
  console.log('');
  
  if (samplesToProcess.length === 0) {
    console.log('All samples have valid responses. Use --force to regenerate.');
    return;
  }
  
  let successCount = 0;
  let errorCount = 0;
  
  const BATCH_SIZE = 10;
  
  for (let batchStart = 0; batchStart < samplesToProcess.length; batchStart += BATCH_SIZE) {
    const batch = samplesToProcess.slice(batchStart, batchStart + BATCH_SIZE);
    const batchNum = Math.floor(batchStart / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(samplesToProcess.length / BATCH_SIZE);
    
    console.log(`\nProcessing batch ${batchNum}/${totalBatches} (${batch.length} samples)...`);
    
    const batchPromises = batch.map(async (sample, idx) => {
      const globalIdx = batchStart + idx;
      const outputFormat = sample.outputFormat ?? (sample.category === 'synthesis' ? 'summary' : undefined);
      const depthLevel = sample.category === 'synthesis' ? 4 : undefined;
      const formatTag = outputFormat ? ` [${outputFormat}]` : '';
      console.log(`[${globalIdx + 1}/${samplesToProcess.length}] ${sample.id}${formatTag}: ${sample.query.slice(0, 50)}...`);
      
      try {
        // Generate both responses in parallel, passing context and outputFormat
        const [mcpResponse, perplexityResponse] = await Promise.all([
          generateMCPResponse(sample.query, geminiApiKey, {
            context: sample.context,
            outputFormat,
            depthLevel,
          }),
          generatePerplexityResponse(sample.query, perplexityApiKey, sample.context),
        ]);
        
        // Update sample in dataset
        sample.responses = {
          mcp: mcpResponse,
          perplexity: perplexityResponse,
          generatedAt: new Date().toISOString(),
        };
        
        console.log(`[${globalIdx + 1}/${samplesToProcess.length}] Done`);
        return { success: true };
        
      } catch (error) {
        console.error(`[${globalIdx + 1}/${samplesToProcess.length}] Error: ${error}`);
        return { success: false, error };
      }
    });
    
    const results = await Promise.all(batchPromises);
    
    // Count successes/failures for this batch
    results.forEach(r => {
      if (r.success) successCount++;
      else errorCount++;
    });
    
    // Save after each batch completes
    saveDataset(dataset);
    
    // Rate limiting between batches (not needed between samples since they're parallel)
    if (batchStart + BATCH_SIZE < samplesToProcess.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  
  console.log('');
  console.log('='.repeat(60));
  console.log(`Generation complete: ${successCount} success, ${errorCount} errors`);
  console.log('='.repeat(60));
}

main().catch(console.error);


