export type ComplexityLevel = 1 | 2 | 3 | 4 | 5;

/**
 * Individual section within a research report
 */
export interface Section {
  title: string;
  summary: string;       // 50-100 word condensed version
  content: string;       // Full section content
  lineRange?: string;    // e.g., "45-89" for citations
}

/**
 * Executive summary for quick report overview
 */
export interface ExecutiveSummary {
  queryAnswered: boolean;
  confidence: 'high' | 'medium' | 'low';
  keyRecommendation: string;  // 1-2 sentences
  budgetFeasibility?: string;
  availableSections: string[]; // List of section IDs
}

/**
 * Content with source tracking for inline citations
 */
export interface SourcedContent {
  content: string;
  source: 'perplexity' | 'context7' | 'arxiv' | 'deep_analysis';
  sourceDetail?: string;  // URL, library name, paper ID
}

/**
 * Documentation cache for Context7
 */
export interface DocumentationCache {
  base: {  // Shared across all queries
    [libraryName: string]: {
      content: string;
      topic: string;
    };
  };
  subQSpecific: {  // Per sub-question
    [subQIndex: number]: {
      content: string;
      library: string;
      topic: string;
    };
  };
}

/**
 * Action step in research plan
 */
export interface ActionStep {
  tool: string;
  description?: string;
  parameters?: Record<string, any>;
  parallel?: boolean;
}

/**
 * Sub-question strategy from planning
 */
export interface SubQuestionPlan {
  question: string;
  tools: string[];  // Independent tool list
  params?: {
    context7Query?: string;
    arxivQuery?: string;
    library?: string;
  };
}

/**
 * Root plan from planning phase
 */
export interface RootPlan {
  mainQuery: {
    complexity: number;
    steps: string[];  // Tool names
    actionSteps?: ActionStep[];  // Detailed steps
  };
  subQuestions: SubQuestionPlan[];
  sharedDocumentation: {
    libraries: string[];
    topics: string[];
  };
}