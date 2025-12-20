/**
 * Judge Calibration Tooling
 * 
 * Implements Pearson Correlation for comparing LLM judge scores against human scores.
 * Target: r > 0.85 for production readiness (based on arxiv:2306.05685).
 * 
 * Usage:
 *   npm run calibrate -- --human-scores=./human-scores.json --llm-scores=./llm-scores.json
 */

// ============================================================================
// Types
// ============================================================================

export interface ScorePair {
  sampleId: string;
  humanScore: number;    // 1-5 scale
  llmScore: number;      // 1-5 scale
  category?: string;     // Optional: 'ccr', 'citation_fidelity', 'specificity'
}

export interface CalibrationResult {
  pearsonR: number;          // Correlation coefficient (-1 to 1)
  isCalibrated: boolean;     // r >= 0.85
  sampleCount: number;
  meanHuman: number;
  meanLLM: number;
  stdHuman: number;
  stdLLM: number;
  biasDirection: 'lenient' | 'strict' | 'aligned';
  biasMagnitude: number;     // Absolute difference in means
  recommendations: string[];
}

export interface DriftReport {
  currentR: number;
  baselineR: number;
  driftAmount: number;
  hasDrifted: boolean;       // |drift| > 0.05
  timestamp: number;
  samplesCompared: number;
}

// ============================================================================
// Pearson Correlation Calculator
// ============================================================================

/**
 * Calculate Pearson correlation coefficient between human and LLM scores
 * 
 * Formula: r = Σ[(xi - x̄)(yi - ȳ)] / √[Σ(xi - x̄)² × Σ(yi - ȳ)²]
 * 
 * @param pairs - Array of score pairs (human vs LLM)
 * @returns Pearson r value (-1 to 1)
 */
export function calculatePearsonR(pairs: ScorePair[]): number {
  if (pairs.length < 2) {
    throw new Error('Need at least 2 score pairs for correlation');
  }
  
  const n = pairs.length;
  const humanScores = pairs.map(p => p.humanScore);
  const llmScores = pairs.map(p => p.llmScore);
  
  // Calculate means
  const meanHuman = humanScores.reduce((a, b) => a + b, 0) / n;
  const meanLLM = llmScores.reduce((a, b) => a + b, 0) / n;
  
  // Calculate covariance and standard deviations
  let covariance = 0;
  let varHuman = 0;
  let varLLM = 0;
  
  for (let i = 0; i < n; i++) {
    const devHuman = humanScores[i] - meanHuman;
    const devLLM = llmScores[i] - meanLLM;
    
    covariance += devHuman * devLLM;
    varHuman += devHuman * devHuman;
    varLLM += devLLM * devLLM;
  }
  
  // Avoid division by zero
  if (varHuman === 0 || varLLM === 0) {
    return 0; // No variance = no correlation
  }
  
  return covariance / Math.sqrt(varHuman * varLLM);
}

/**
 * Calculate standard deviation
 */
function calculateStdDev(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((sum, val) => sum + (val - mean) ** 2, 0) / (n - 1);
  
  return Math.sqrt(variance);
}

// ============================================================================
// Calibration Analysis
// ============================================================================

/**
 * Run full calibration analysis
 * 
 * @param pairs - Score pairs to analyze
 * @param threshold - Minimum acceptable r value (default 0.85)
 * @returns Calibration result with recommendations
 */
export function runCalibration(pairs: ScorePair[], threshold: number = 0.85): CalibrationResult {
  if (pairs.length < 5) {
    return {
      pearsonR: 0,
      isCalibrated: false,
      sampleCount: pairs.length,
      meanHuman: 0,
      meanLLM: 0,
      stdHuman: 0,
      stdLLM: 0,
      biasDirection: 'aligned',
      biasMagnitude: 0,
      recommendations: ['Need at least 5 samples for reliable calibration'],
    };
  }
  
  const pearsonR = calculatePearsonR(pairs);
  const humanScores = pairs.map(p => p.humanScore);
  const llmScores = pairs.map(p => p.llmScore);
  
  const meanHuman = humanScores.reduce((a, b) => a + b, 0) / pairs.length;
  const meanLLM = llmScores.reduce((a, b) => a + b, 0) / pairs.length;
  
  const stdHuman = calculateStdDev(humanScores);
  const stdLLM = calculateStdDev(llmScores);
  
  const biasMagnitude = Math.abs(meanLLM - meanHuman);
  let biasDirection: CalibrationResult['biasDirection'];
  
  if (biasMagnitude < 0.3) {
    biasDirection = 'aligned';
  } else if (meanLLM > meanHuman) {
    biasDirection = 'lenient';
  } else {
    biasDirection = 'strict';
  }
  
  const isCalibrated = pearsonR >= threshold;
  
  // Generate recommendations
  const recommendations: string[] = [];
  
  if (!isCalibrated) {
    recommendations.push(`Correlation ${pearsonR.toFixed(3)} below threshold ${threshold}`);
    
    if (pearsonR < 0.5) {
      recommendations.push('Judge prompt needs significant revision');
      recommendations.push('Consider using a different judge model');
    } else if (pearsonR < 0.7) {
      recommendations.push('Refine judge prompt rubric for consistency');
      recommendations.push('Add more specific scoring criteria');
    } else {
      recommendations.push('Minor adjustments to rubric wording may help');
    }
  }
  
  if (biasDirection === 'lenient') {
    recommendations.push(`Judge is ${biasMagnitude.toFixed(2)} points too lenient on average`);
    recommendations.push('Add stricter pass/fail criteria for CRITICAL_GAPs');
  } else if (biasDirection === 'strict') {
    recommendations.push(`Judge is ${biasMagnitude.toFixed(2)} points too strict on average`);
    recommendations.push('Clarify distinction between CRITICAL_GAP and STYLISTIC_PREFERENCE');
  }
  
  if (stdLLM < stdHuman * 0.5) {
    recommendations.push('LLM scores lack variance - may be anchoring to safe middle scores');
  }
  
  if (isCalibrated && recommendations.length === 0) {
    recommendations.push('Judge is well-calibrated');
  }
  
  return {
    pearsonR,
    isCalibrated,
    sampleCount: pairs.length,
    meanHuman,
    meanLLM,
    stdHuman,
    stdLLM,
    biasDirection,
    biasMagnitude,
    recommendations,
  };
}

// ============================================================================
// Drift Detection
// ============================================================================

/**
 * Detect judge drift by comparing current calibration to baseline
 * 
 * @param currentPairs - Current score pairs
 * @param baselineR - Previous calibration r value
 * @param driftThreshold - Maximum acceptable drift (default 0.05)
 * @returns Drift report
 */
export function detectDrift(
  currentPairs: ScorePair[],
  baselineR: number,
  driftThreshold: number = 0.05
): DriftReport {
  const currentR = calculatePearsonR(currentPairs);
  const driftAmount = currentR - baselineR;
  
  return {
    currentR,
    baselineR,
    driftAmount,
    hasDrifted: Math.abs(driftAmount) > driftThreshold,
    timestamp: Date.now(),
    samplesCompared: currentPairs.length,
  };
}

// ============================================================================
// Category-Specific Calibration
// ============================================================================

/**
 * Run calibration by category (CCR, Citation Fidelity, Specificity)
 */
export function calibrateByCategory(pairs: ScorePair[]): Record<string, CalibrationResult> {
  const categories = new Set(pairs.map(p => p.category).filter(Boolean));
  const results: Record<string, CalibrationResult> = {};
  
  for (const category of categories) {
    const categoryPairs = pairs.filter(p => p.category === category);
    if (categoryPairs.length >= 5) {
      results[category as string] = runCalibration(categoryPairs);
    }
  }
  
  // Also calculate overall
  results['overall'] = runCalibration(pairs);
  
  return results;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Load score pairs from JSON file format
 */
export interface ScoresFile {
  version: string;
  scorePairs: ScorePair[];
  metadata?: {
    evaluator: string;
    dateCollected: string;
    notes?: string;
  };
}

/**
 * Format calibration result for console output
 */
export function formatCalibrationReport(result: CalibrationResult): string {
  const status = result.isCalibrated ? '✅ CALIBRATED' : '❌ NOT CALIBRATED';
  
  return `
═══════════════════════════════════════════════════════════
  JUDGE CALIBRATION REPORT
═══════════════════════════════════════════════════════════

  Status: ${status}
  Pearson r: ${result.pearsonR.toFixed(4)}
  Target: ≥ 0.85

  Samples: ${result.sampleCount}
  
  Human Scores: mean=${result.meanHuman.toFixed(2)}, std=${result.stdHuman.toFixed(2)}
  LLM Scores:   mean=${result.meanLLM.toFixed(2)}, std=${result.stdLLM.toFixed(2)}
  
  Bias: ${result.biasDirection} (${result.biasMagnitude.toFixed(2)} points)

  Recommendations:
${result.recommendations.map(r => `    • ${r}`).join('\n')}

═══════════════════════════════════════════════════════════
`.trim();
}

/**
 * Format drift report for console output
 */
export function formatDriftReport(report: DriftReport): string {
  const status = report.hasDrifted ? '⚠️ DRIFT DETECTED' : '✅ STABLE';
  const direction = report.driftAmount > 0 ? 'improved' : 'degraded';
  
  return `
───────────────────────────────────────────────────────────
  DRIFT DETECTION REPORT
───────────────────────────────────────────────────────────

  Status: ${status}
  
  Current r:  ${report.currentR.toFixed(4)}
  Baseline r: ${report.baselineR.toFixed(4)}
  Drift:      ${report.driftAmount > 0 ? '+' : ''}${report.driftAmount.toFixed(4)} (${direction})
  
  Samples Compared: ${report.samplesCompared}
  Timestamp: ${new Date(report.timestamp).toISOString()}

───────────────────────────────────────────────────────────
`.trim();
}

// ============================================================================
// Example Usage / Self-Test
// ============================================================================

/**
 * Generate example score pairs for testing
 */
export function generateExamplePairs(): ScorePair[] {
  return [
    { sampleId: 'hp-01', humanScore: 5, llmScore: 5, category: 'ccr' },
    { sampleId: 'hp-02', humanScore: 4, llmScore: 4, category: 'ccr' },
    { sampleId: 'hp-03', humanScore: 5, llmScore: 4, category: 'citation_fidelity' },
    { sampleId: 'ec-01', humanScore: 2, llmScore: 2, category: 'ccr' },
    { sampleId: 'ec-02', humanScore: 3, llmScore: 3, category: 'specificity' },
    { sampleId: 'ec-03', humanScore: 2, llmScore: 3, category: 'citation_fidelity' },
    { sampleId: 'fm-01', humanScore: 1, llmScore: 1, category: 'ccr' },
    { sampleId: 'fm-02', humanScore: 1, llmScore: 2, category: 'specificity' },
    { sampleId: 'fm-03', humanScore: 2, llmScore: 2, category: 'citation_fidelity' },
    { sampleId: 'fm-04', humanScore: 1, llmScore: 1, category: 'specificity' },
  ];
}

// CLI entry point (if run directly)
if (import.meta.url === `file://${process.argv[1]}`) {
  const examplePairs = generateExamplePairs();
  const result = runCalibration(examplePairs);
  console.log(formatCalibrationReport(result));
  
  // Also show category breakdown
  const byCategory = calibrateByCategory(examplePairs);
  console.log('\nBy Category:');
  for (const [cat, catResult] of Object.entries(byCategory)) {
    console.log(`  ${cat}: r=${catResult.pearsonR.toFixed(3)}, calibrated=${catResult.isCalibrated}`);
  }
}


