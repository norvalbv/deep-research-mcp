import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

interface BootstrapResult {
  lower: number;
  upper: number;
  mean: number;
  isSignificant: boolean;
  pSuperiority: number;
}

interface CategoryResult {
  category: string;
  totalSamples: number;
  mcpWins: number;
  perplexityWins: number;
  ties: number;
  mcpWinRate: number;
  bootstrap: BootstrapResult;
  recommendation: 'USE_MCP' | 'USE_PERPLEXITY' | 'TIE' | 'INSUFFICIENT_DATA';
}

interface DecisionMatrix {
  timestamp: string;
  totalComparisons: number;
  byCategory: CategoryResult[];
  switchingPoints: string[];
  summary: {
    mcpStrongCategories: string[];
    perplexityStrongCategories: string[];
    tieCategories: string[];
  };
}

function getLatestResultFile(resultsDir: string): string | null {
  try {
    const files = readdirSync(resultsDir)
      .filter(f => f.startsWith('comparison-') && f.endsWith('.json'))
      .map(f => ({
        path: join(resultsDir, f),
        mtime: statSync(join(resultsDir, f)).mtime.getTime()
      }))
      .sort((a, b) => b.mtime - a.mtime);
    
    return files.length > 0 ? files[0].path : null;
  } catch {
    return null;
  }
}

function formatDecisionMatrix(matrix: DecisionMatrix): string {
  const lines: string[] = [];
  
  lines.push('='.repeat(80));
  lines.push('DECISION MATRIX: MCP vs Perplexity');
  lines.push(`Generated: ${matrix.timestamp}`);
  lines.push(`Total Comparisons: ${matrix.totalComparisons}`);
  lines.push('='.repeat(80));
  lines.push('');
  
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

function main() {
  const resultsDir = join(import.meta.dirname, 'results');
  const latestFile = getLatestResultFile(resultsDir);
  
  if (!latestFile) {
    console.error('No benchmark results found in benchmarks/results/');
    console.error('Run: npm run benchmark:compare');
    process.exit(1);
  }
  
  try {
    const data = JSON.parse(readFileSync(latestFile, 'utf-8'));
    const matrix: DecisionMatrix = data.matrix;
    
    console.log('\n');
    console.log(formatDecisionMatrix(matrix));
    console.log('\n');
    console.log(`Source: ${latestFile}`);
    console.log('\n');
  } catch (error) {
    console.error('Failed to read benchmark results:', error);
    process.exit(1);
  }
}

main();

