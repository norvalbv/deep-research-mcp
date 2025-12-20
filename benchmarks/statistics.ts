/**
 * Statistical Functions for Benchmark Evaluation
 * 
 * Based on arxiv:2303.15638, arxiv:2104.00621
 * Implements Paired Bootstrap Resampling for A/B LLM comparisons
 */

import type { BootstrapResult } from './types.js';

/**
 * Paired Bootstrap Resampling for statistical significance
 * Decision rule: System B is "better" only if 95% CI for delta doesn't cross zero
 * 
 * @param scoresA - Scores from System A (e.g., Perplexity)
 * @param scoresB - Scores from System B (e.g., MCP)
 * @param iterations - Number of bootstrap iterations (default 10,000)
 * @param alpha - Significance level (default 0.05 for 95% CI)
 */
export function pairedBootstrapSignificance(
  scoresA: number[],
  scoresB: number[],
  iterations: number = 10000,
  alpha: number = 0.05
): BootstrapResult {
  if (scoresA.length !== scoresB.length) {
    throw new Error('Score arrays must have equal length');
  }
  
  if (scoresA.length === 0) {
    return { lower: 0, upper: 0, mean: 0, isSignificant: false, pSuperiority: 0.5 };
  }
  
  // Calculate paired deltas (B - A)
  const deltas = scoresB.map((b, i) => b - scoresA[i]);
  const n = deltas.length;
  
  // Bootstrap resampling
  const bootstrapMeans: number[] = [];
  let bWinsCount = 0;
  
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    let bWins = 0;
    for (let j = 0; j < n; j++) {
      const idx = Math.floor(Math.random() * n);
      sum += deltas[idx];
      if (deltas[idx] > 0) bWins++;
    }
    bootstrapMeans.push(sum / n);
    if (bWins > n / 2) bWinsCount++;
  }
  
  // Sort for percentile calculation
  bootstrapMeans.sort((a, b) => a - b);
  
  // Calculate confidence interval
  const lowerIdx = Math.floor((alpha / 2) * iterations);
  const upperIdx = Math.floor((1 - alpha / 2) * iterations);
  
  const lower = bootstrapMeans[lowerIdx];
  const upper = bootstrapMeans[upperIdx];
  const mean = bootstrapMeans.reduce((a, b) => a + b, 0) / iterations;
  
  // Significant if CI doesn't cross zero
  const isSignificant = lower > 0 || upper < 0;
  
  // P(Superiority) = proportion of bootstrap samples where B > A
  const pSuperiority = bWinsCount / iterations;
  
  return { lower, upper, mean, isSignificant, pSuperiority };
}

/**
 * Calculate Step-level F1 (harmonic mean of precision and recall)
 * Used for atomic proposition evaluation
 */
export function calculateStepF1(precision: number, recall: number): number {
  if (precision + recall === 0) return 0;
  return 2 * (precision * recall) / (precision + recall);
}


