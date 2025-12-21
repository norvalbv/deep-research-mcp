/**
 * Format research results as clean markdown
 */

import { ComplexityLevel, Section } from './types/index.js';
import { ExecutionResult } from './execution.js';
import { ResearchActionPlan } from './planning.js';
import { SynthesisOutput } from './synthesis.js';
import { buildValidationContent } from './validation-content.js';

// Re-define locally to avoid circular import
interface ChallengeResult {
  critiques: string[];
  hasSignificantGaps: boolean;
  rawResponse: string;
}

interface SufficiencyVote {
  sufficient: boolean;      // true = synthesis wins
  votesFor: number;         // synthesis_wins votes
  votesAgainst: number;     // critique_wins votes
  criticalGaps: string[];   // Gaps if critique wins
  details: Array<{ model: string; vote: 'synthesis_wins' | 'critique_wins'; reasoning: string }>;
}

export interface ResearchResult {
  query: string;
  complexity: ComplexityLevel;
  complexityReasoning: string;
  actionPlan?: ResearchActionPlan;
  execution: ExecutionResult;
  synthesis: SynthesisOutput;  // Now structured JSON output
  consensus?: string;
  challenge?: ChallengeResult;
  sufficiency?: SufficiencyVote;
  improved?: boolean;  // True if synthesis was re-run after critique won
}

/**
 * Format research result as markdown from structured synthesis
 * Renders the structured JSON output into clean markdown for display
 * 
 * Returns markdown string only (sections are built directly in controller)
 */
export function formatMarkdown(result: ResearchResult): string {
  const sections: string[] = [];

  sections.push(`# Research Results: ${result.query}\n`);

  // Render structured synthesis as markdown
  sections.push(`## Overview\n`);
  sections.push(resolveCitations(result.synthesis.overview, result.execution));
  sections.push('');

  // Render sub-questions as dedicated sections
  if (result.synthesis.subQuestions) {
    for (const [key, value] of Object.entries(result.synthesis.subQuestions)) {
      sections.push(`## ${value.question}\n`);
      sections.push(resolveCitations(value.answer, result.execution));
      sections.push('');
    }
  }

  // Additional insights
  if (result.synthesis.additionalInsights && result.synthesis.additionalInsights.trim()) {
    sections.push(`## Additional Insights\n`);
    sections.push(resolveCitations(result.synthesis.additionalInsights, result.execution));
    sections.push('');
  }

  // Academic Papers - just references, not full content (already synthesized above)
  if (result.execution.arxivPapers && result.execution.arxivPapers.papers.length > 0) {
    sections.push(`## Academic Papers\n`);
    sections.push(formatArxivPapersCompact(result.execution.arxivPapers.papers));
    sections.push(`\n*Use \`read_paper\` or \`download_paper\` tools for full paper content.*\n`);
  }

  // Sources list only - no full content (already synthesized above)
  if (result.execution.perplexityResult?.sources && result.execution.perplexityResult.sources.length > 0) {
    sections.push(`## Sources\n`);
    result.execution.perplexityResult.sources.forEach((source, i) => {
      sections.push(`${i + 1}. ${source}`);
    });
    sections.push('');
  }

  // Validation section - skip entirely at depth 1 to save tokens
  const validationContent = buildValidationContent(
    { challenge: result.challenge, sufficiency: result.sufficiency, improved: result.improved, consensus: result.consensus },
    result.complexity,
    { includeConsensus: true }
  );
  if (validationContent) {
    sections.push(`## Validation\n`);
    sections.push(validationContent);
  }

  return sections.join('\n');
}

/**
 * Resolve citation indices to actual URLs
 * Replaces [perplexity:N] with actual source URL or inline citation
 */
export function resolveCitations(text: string, execution: ExecutionResult): string {
  const sources = execution.perplexityResult?.sources || [];
  
  // Replace [perplexity:N] with actual URLs, showing domain name
  return text.replace(/\[perplexity:(\d+)\]/g, (match, numStr) => {
    const num = parseInt(numStr, 10);
    const sourceIndex = num - 1; // Citations are 1-indexed
    
    if (sourceIndex >= 0 && sourceIndex < sources.length) {
      const url = sources[sourceIndex];
      // Extract domain name for readable link text
      let domain = 'source';
      try {
        const urlObj = new URL(url);
        domain = urlObj.hostname.replace(/^www\./, '');
      } catch { /* keep 'source' if URL parsing fails */ }
      return `[[${domain}]](${url})`;
    }
    
    // Keep original if source not found (shouldn't happen)
    return match;
  });
}

/**
 * Compact paper format - just title, ID, summary, and link
 */
function formatArxivPapersCompact(papers: Array<{ id: string; title: string; summary: string; url: string }>): string {
  if (papers.length === 0) {
    return 'No papers found.';
  }

  return papers
    .map((paper, index) => {
      return `**${index + 1}. ${paper.title}**
- arXiv ID: ${paper.id}
- Summary: ${paper.summary}
- URL: ${paper.url}`;
    })
    .join('\n\n');
}