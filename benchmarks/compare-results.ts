import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

interface CategoryResult {
  category: string;
  totalSamples: number;
  mcpWins: number;
  perplexityWins: number;
  ties: number;
  mcpWinRate: number;
  recommendation: 'USE_MCP' | 'USE_PERPLEXITY' | 'TIE' | 'INSUFFICIENT_DATA';
}

interface DecisionMatrix {
  timestamp: string;
  totalComparisons: number;
  byCategory: CategoryResult[];
}

interface ResultFile {
  path: string;
  timestamp: Date;
  matrix: DecisionMatrix;
}

function getAllResultFiles(resultsDir: string): ResultFile[] {
  try {
    const files = readdirSync(resultsDir)
      .filter(f => f.startsWith('comparison-') && f.endsWith('.json'))
      .map(f => {
        const path = join(resultsDir, f);
        const data = JSON.parse(readFileSync(path, 'utf-8'));
        return {
          path,
          timestamp: new Date(data.matrix.timestamp),
          matrix: data.matrix
        };
      })
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    
    return files;
  } catch {
    return [];
  }
}

function formatDate(date: Date): string {
  return date.toLocaleString('en-US', { 
    month: 'short', 
    day: 'numeric', 
    hour: '2-digit', 
    minute: '2-digit' 
  });
}

function getTrend(current: number, previous: number | undefined): string {
  if (previous === undefined) return '';
  const diff = current - previous;
  if (Math.abs(diff) < 0.05) return '→';
  return diff > 0 ? '↑' : '↓';
}

function main() {
  const resultsDir = join(import.meta.dirname, 'results');
  const results = getAllResultFiles(resultsDir);
  
  if (results.length === 0) {
    console.error('No benchmark results found in benchmarks/results/');
    console.error('Run: npm run benchmark:compare');
    process.exit(1);
  }
  
  if (results.length === 1) {
    console.log('Only one benchmark result found. Run more benchmarks to compare.');
    console.log(`Latest: ${formatDate(results[0].timestamp)}`);
    console.log('\nUse: npm run benchmark:view (to see detailed results)');
    process.exit(0);
  }
  
  console.log('\n');
  console.log('='.repeat(100));
  console.log('BENCHMARK COMPARISON');
  console.log(`${results.length} benchmark runs found`);
  console.log('='.repeat(100));
  console.log('');
  
  // Collect all categories
  const categories = new Set<string>();
  for (const result of results) {
    for (const cat of result.matrix.byCategory) {
      categories.add(cat.category);
    }
  }
  
  // Header row
  const header = 'Category'.padEnd(22) + '| ' + 
    results.map((r, i) => `Run ${i + 1}`.padEnd(14)).join('| ');
  console.log(header);
  console.log('-'.repeat(header.length));
  
  // Show timestamps
  const timestampRow = ' '.repeat(22) + '| ' + 
    results.map(r => formatDate(r.timestamp).substring(0, 14).padEnd(14)).join('| ');
  console.log(timestampRow);
  console.log('-'.repeat(header.length));
  
  // Data rows - MCP Win Rate
  for (const category of Array.from(categories).sort()) {
    const values: (number | undefined)[] = [];
    
    for (const result of results) {
      const cat = result.matrix.byCategory.find(c => c.category === category);
      values.push(cat?.mcpWinRate);
    }
    
    const formattedValues = values.map((val, i) => {
      if (val === undefined) return 'N/A'.padEnd(14);
      const trend = getTrend(val, values[i - 1]);
      const pct = `${(val * 100).toFixed(0)}%`;
      return `${pct} ${trend}`.padEnd(14);
    });
    
    console.log(category.padEnd(22) + '| ' + formattedValues.join('| '));
  }
  
  console.log('');
  console.log('-'.repeat(header.length));
  console.log('');
  
  // Recommendation changes
  console.log('RECOMMENDATION CHANGES');
  console.log('-'.repeat(100));
  
  for (const category of Array.from(categories).sort()) {
    const recommendations = results.map(r => 
      r.matrix.byCategory.find(c => c.category === category)?.recommendation || 'N/A'
    );
    
    const hasChange = new Set(recommendations.filter(r => r !== 'N/A')).size > 1;
    
    if (hasChange) {
      const timeline = recommendations
        .map((rec, i) => `Run ${i + 1}: ${rec}`)
        .join(' → ');
      console.log(`${category}: ${timeline}`);
    }
  }
  
  console.log('');
  console.log('SUMMARY');
  console.log('-'.repeat(100));
  
  const latest = results[results.length - 1].matrix;
  const mcpStrong = latest.byCategory.filter(c => c.recommendation === 'USE_MCP').length;
  const perplexityStrong = latest.byCategory.filter(c => c.recommendation === 'USE_PERPLEXITY').length;
  const ties = latest.byCategory.filter(c => c.recommendation === 'TIE').length;
  
  console.log(`Latest Results (${formatDate(results[results.length - 1].timestamp)}):`);
  console.log(`  MCP Strong: ${mcpStrong} categories`);
  console.log(`  Perplexity Strong: ${perplexityStrong} categories`);
  console.log(`  Ties: ${ties} categories`);
  console.log('');
  console.log('Legend: ↑ = improved, ↓ = declined, → = stable');
  console.log('');
  console.log('='.repeat(100));
  console.log('\n');
}

main();

