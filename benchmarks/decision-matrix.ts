/**
 * Decision Matrix Generation (Conditional Utility Benchmarking)
 * 
 * Based on R-115249: 8-Module Framework for system selection.
 * Generates recommendations for when to use MCP vs Perplexity.
 */

import { pairedBootstrapSignificance } from './statistics.js';
import type { 
  TaskCategory, 
  ComparisonSample, 
  CategoryResult, 
  DecisionMatrix 
} from './types.js';

/**
 * Generate a decision matrix showing when to use MCP vs Perplexity
 */
export function generateDecisionMatrix(
  results: Array<{
    sample: ComparisonSample;
    winner: 'system' | 'baseline' | 'tie';
    systemScore: number;
    baselineScore: number;
  }>
): DecisionMatrix {
  const byCategory = new Map<TaskCategory, typeof results>();
  
  for (const result of results) {
    const category = result.sample.category;
    if (!byCategory.has(category)) {
      byCategory.set(category, []);
    }
    byCategory.get(category)!.push(result);
  }
  
  const categoryResults: CategoryResult[] = [];
  const mcpStrong: TaskCategory[] = [];
  const perplexityStrong: TaskCategory[] = [];
  const tieCategories: TaskCategory[] = [];
  
  for (const [category, categoryData] of byCategory) {
    const mcpWins = categoryData.filter(r => r.winner === 'system').length;
    const perplexityWins = categoryData.filter(r => r.winner === 'baseline').length;
    const ties = categoryData.filter(r => r.winner === 'tie').length;
    const total = categoryData.length;
    
    const mcpScores = categoryData.map(r => r.systemScore);
    const perplexityScores = categoryData.map(r => r.baselineScore);
    const bootstrap = pairedBootstrapSignificance(perplexityScores, mcpScores);
    
    let recommendation: CategoryResult['recommendation'];
    if (total < 5) {
      recommendation = 'INSUFFICIENT_DATA';
    } else if (bootstrap.isSignificant && bootstrap.mean > 0) {
      recommendation = 'USE_MCP';
      mcpStrong.push(category);
    } else if (bootstrap.isSignificant && bootstrap.mean < 0) {
      recommendation = 'USE_PERPLEXITY';
      perplexityStrong.push(category);
    } else {
      recommendation = 'TIE';
      tieCategories.push(category);
    }
    
    categoryResults.push({
      category,
      totalSamples: total,
      mcpWins,
      perplexityWins,
      ties,
      mcpWinRate: mcpWins / total,
      bootstrap,
      recommendation,
    });
  }
  
  categoryResults.sort((a, b) => b.mcpWinRate - a.mcpWinRate);
  
  const switchingPoints: string[] = [];
  if (mcpStrong.includes('multi_hop_reasoning')) {
    switchingPoints.push('Query complexity > 2 hops: USE MCP');
  }
  if (mcpStrong.includes('synthesis')) {
    switchingPoints.push('Multi-document synthesis: USE MCP');
  }
  if (mcpStrong.includes('rag_quality')) {
    switchingPoints.push('Citation-critical tasks: USE MCP');
  }
  if (perplexityStrong.includes('single_hop_factual') || perplexityStrong.includes('latency')) {
    switchingPoints.push('Simple factual lookup: USE PERPLEXITY (faster)');
  }
  if (tieCategories.includes('instruction_following')) {
    switchingPoints.push('Format constraints: Either (prefer lower cost)');
  }
  if (tieCategories.includes('code_generation')) {
    switchingPoints.push('Code generation: Either (prefer lower cost)');
  }
  
  return {
    timestamp: new Date().toISOString(),
    totalComparisons: results.length,
    byCategory: categoryResults,
    switchingPoints,
    summary: {
      mcpStrongCategories: mcpStrong,
      perplexityStrongCategories: perplexityStrong,
      tieCategories,
    },
  };
}

export function formatDecisionMatrix(matrix: DecisionMatrix): string {
  const lines: string[] = [];
  
  lines.push('='.repeat(80));
  lines.push('DECISION MATRIX: MCP vs Perplexity');
  lines.push(`Generated: ${matrix.timestamp}`);
  lines.push(`Total Comparisons: ${matrix.totalComparisons}`);
  lines.push('='.repeat(80));
  lines.push('');
  
  // Clear actionable recommendations first
  lines.push('RECOMMENDATIONS');
  lines.push('-'.repeat(80));
  
  if (matrix.summary.mcpStrongCategories.length > 0) {
    lines.push('');
    lines.push('Use MCP for:');
    for (const cat of matrix.byCategory.filter(c => c.recommendation === 'USE_MCP')) {
      const pValue = cat.bootstrap.isSignificant ? 'p<0.05' : `p=${cat.bootstrap.pSuperiority.toFixed(2)}`;
      lines.push(`  - ${cat.category} (win rate: ${(cat.mcpWinRate * 100).toFixed(0)}%, ${pValue})`);
    }
  }
  
  if (matrix.summary.perplexityStrongCategories.length > 0) {
    lines.push('');
    lines.push('Use Perplexity for:');
    for (const cat of matrix.byCategory.filter(c => c.recommendation === 'USE_PERPLEXITY')) {
      const pValue = cat.bootstrap.isSignificant ? 'p<0.05' : `p=${cat.bootstrap.pSuperiority.toFixed(2)}`;
      const perplexityWinRate = ((1 - cat.mcpWinRate) * 100).toFixed(0);
      lines.push(`  - ${cat.category} (win rate: ${perplexityWinRate}%, ${pValue})`);
    }
    lines.push('  - latency-critical tasks (<2s vs ~5min)');
  }
  
  if (matrix.summary.tieCategories.length > 0) {
    lines.push('');
    lines.push('No clear winner (prefer lower cost):');
    for (const cat of matrix.byCategory.filter(c => c.recommendation === 'TIE')) {
      const mcpPct = (cat.mcpWinRate * 100).toFixed(0);
      const perplexityPct = ((1 - cat.mcpWinRate) * 100).toFixed(0);
      lines.push(`  - ${cat.category} (${mcpPct}% vs ${perplexityPct}%, p=${cat.bootstrap.pSuperiority.toFixed(2)})`);
    }
  }
  
  const insufficientData = matrix.byCategory.filter(c => c.recommendation === 'INSUFFICIENT_DATA');
  if (insufficientData.length > 0) {
    lines.push('');
    lines.push('Insufficient data (<5 samples):');
    for (const cat of insufficientData) {
      lines.push(`  - ${cat.category} (${cat.totalSamples} samples)`);
    }
  }
  
  // Detailed breakdown
  lines.push('');
  lines.push('DETAILED BREAKDOWN');
  lines.push('-'.repeat(80));
  lines.push(
    'Category'.padEnd(22) + '| ' +
    'MCP Win'.padEnd(9) + '| ' +
    'P(Sup)'.padEnd(8) + '| ' +
    '95% CI'.padEnd(16) + '| ' +
    'Recommendation'
  );
  lines.push('-'.repeat(80));
  
  for (const cat of matrix.byCategory) {
    const winRate = `${(cat.mcpWinRate * 100).toFixed(0)}%`;
    const pSup = cat.bootstrap.pSuperiority.toFixed(2);
    const ci = `[${cat.bootstrap.lower.toFixed(2)}, ${cat.bootstrap.upper.toFixed(2)}]`;
    
    lines.push(
      cat.category.padEnd(22) + '| ' +
      winRate.padEnd(9) + '| ' +
      pSup.padEnd(8) + '| ' +
      ci.padEnd(16) + '| ' +
      cat.recommendation
    );
  }
  
  // Switching points
  if (matrix.switchingPoints.length > 0) {
    lines.push('');
    lines.push('SWITCHING POINTS:');
    for (const point of matrix.switchingPoints) {
      lines.push(`  - ${point}`);
    }
  }
  
  lines.push('');
  lines.push('='.repeat(80));
  
  return lines.join('\n');
}

