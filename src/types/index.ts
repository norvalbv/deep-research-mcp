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