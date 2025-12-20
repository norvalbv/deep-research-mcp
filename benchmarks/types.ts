/**
 * Benchmark Types
 * 
 * Type definitions for the benchmark evaluation system.
 * Based on 8-Module Framework (arxiv:2309.15217) for Conditional Utility Benchmarking.
 */

/**
 * 8-Module Framework for Conditional Utility Benchmarking
 * Segments tasks to identify "switching points" where one system outperforms another
 */
export type TaskCategory = 
  | 'single_hop_factual'    // Direct retrieval of single fact
  | 'multi_hop_reasoning'   // Connecting 2+ disparate facts
  | 'synthesis'             // Multi-document summary/meta-analysis
  | 'code_generation'       // Technical logic, syntax accuracy
  | 'instruction_following' // Constraint satisfaction (IFEval)
  | 'rag_quality'           // Citation/grounding accuracy
  | 'safety'                // Robustness, adversarial resistance
  | 'latency';              // Cost/speed tradeoff evaluation

export interface EvaluationSample {
  id: string;
  type: 'multi_hop' | 'synthesis' | 'factual';  // Legacy type
  category: TaskCategory;                        // 8-Module category
  query: string;
  subQuestions?: string[];
  constraints?: string[];
  contextSources: Array<{
    type: 'arxiv' | 'web';
    id?: string;
    url?: string;
    content: string;
    relevant: boolean;
  }>;
  goldStandard: {
    answer: string;
    mustCite: string[];
    mustIdentifyConflict: boolean;
    rubric: Record<string, string>;
    atomicFacts?: string[];
  };
}

export interface JudgeScore {
  score: number;        // 1-5
  reasoning: string;
  passed: boolean;
}

export interface HCSPMetrics {
  ccr: number;
  satisfiedConstraints: string[];
  failedConstraints: string[];
  citationFidelity: number;
  verifiedClaims: number;
  totalClaims: number;
  specificityScore: number;
  critiques: Array<{
    type: 'CRITICAL_GAP' | 'STYLISTIC_PREFERENCE';
    issue: string;
  }>;
  hasCriticalGap: boolean;
}

export interface EvaluationResult {
  sampleId: string;
  type: EvaluationSample['type'];
  metrics: {
    citationDensity: JudgeScore;
    noiseRobustness: JudgeScore;
    consensusConsistency: JudgeScore;
    multiHopReasoning: JudgeScore;
    overall: JudgeScore;
  };
  hcsp?: HCSPMetrics;
  passed: boolean;
  rawJudgment: string;
}

export interface BenchmarkSummary {
  totalSamples: number;
  passedSamples: number;
  passRate: number;
  avgScores: {
    citationDensity: number;
    noiseRobustness: number;
    consensusConsistency: number;
    multiHopReasoning: number;
  };
  hcspSummary?: {
    avgCCR: number;
    avgCitationFidelity: number;
    avgSpecificityScore: number;
    criticalGapCount: number;
    samplesWithCriticalGaps: number;
  };
  byType: Record<string, { total: number; passed: number; rate: number }>;
  thresholdsMet: {
    citationDensity: boolean;
    noiseRobustness: boolean;
    multiHopSuccess: boolean;
    ccr?: boolean;
    citationFidelity?: boolean;
    specificityScore?: boolean;
  };
}

export interface BootstrapResult {
  lower: number;
  upper: number;
  mean: number;
  isSignificant: boolean;
  pSuperiority: number;
}

export interface ComparisonSample {
  id: string;
  category: TaskCategory;
  query: string;
  goldStandard: {
    answer: string;
    atomicFacts?: string[];
    sources?: string[];
  };
  expectedWinner?: 'mcp' | 'perplexity' | 'tie';
  rationale?: string;
  context?: string;
  responses?: {
    mcp?: string;
    perplexity?: string;
    generatedAt?: string;
  };
}

export interface CategoryResult {
  category: TaskCategory;
  totalSamples: number;
  mcpWins: number;
  perplexityWins: number;
  ties: number;
  mcpWinRate: number;
  bootstrap: BootstrapResult;
  recommendation: 'USE_MCP' | 'USE_PERPLEXITY' | 'TIE' | 'INSUFFICIENT_DATA';
}

export interface DecisionMatrix {
  timestamp: string;
  totalComparisons: number;
  byCategory: CategoryResult[];
  switchingPoints: string[];
  summary: {
    mcpStrongCategories: TaskCategory[];
    perplexityStrongCategories: TaskCategory[];
    tieCategories: TaskCategory[];
  };
}


