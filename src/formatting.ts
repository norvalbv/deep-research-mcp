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
 * Handles multiple formats:
 * - [N] - simple numeric (e.g., [1], [2])
 * - [perplexity:N] or [Perplexity:N] (case-insensitive)
 * - [perplexity:1, perplexity:2] (comma-separated in single bracket)
 */
export function resolveCitations(text: string, execution: ExecutionResult): string {
  const sources = execution.perplexityResult?.sources || [];
  
  // #region agent log
  fetch('http://127.0.0.1:7243/ingest/cc739506-e25d-45e2-b543-cb8ae30e3ecd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'formatting.ts:resolveCitations',message:'Citation resolution input',data:{textLength:text.length,sourcesCount:sources.length,firstSource:sources[0]?.slice(0,50),hasNumericCitations:/\[\d+\]/.test(text),hasPerplexityCitations:/\[perplexity:/i.test(text),sampleText:text.slice(0,200)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A,B,C,D,E'})}).catch(()=>{});
  // #endregion
  
  if (sources.length === 0) {
    return text; // No sources to resolve
  }
  
  // Helper to resolve a single numeric citation to a URL
  const resolveNum = (num: number): string | null => {
    const sourceIndex = num - 1; // Citations are 1-indexed
    if (sourceIndex >= 0 && sourceIndex < sources.length) {
      const url = sources[sourceIndex];
      let domain = 'source';
      try {
        const urlObj = new URL(url);
        domain = urlObj.hostname.replace(/^www\./, '');
      } catch { /* keep 'source' */ }
      return `[[${domain}]](${url})`;
    }
    return null;
  };
  
  let result = text;
  
  // Step 1: Handle simple numeric citations [1], [2], etc.
  // Also handles consecutive like [1][2][4]
  result = result.replace(/\[(\d+)\]/g, (match, numStr) => {
    const num = parseInt(numStr, 10);
    const resolved = resolveNum(num);
    return resolved || match; // Keep original if not resolved
  });
  
  // Step 2: Handle perplexity format [perplexity:N] (case-insensitive)
  result = result.replace(/\[perplexity:(\d+)\]/gi, (match, numStr) => {
    const num = parseInt(numStr, 10);
    const resolved = resolveNum(num);
    return resolved || match;
  });
  
  // Step 3: Handle comma-separated perplexity citations [perplexity:1, perplexity:2]
  result = result.replace(/\[([^\]]*perplexity:[^\]]+)\]/gi, (match, inner) => {
    const citations = inner.split(/,\s*/);
    const resolved = citations.map((citation: string) => {
      const numMatch = citation.match(/perplexity:(\d+)/i);
      if (numMatch) {
        const num = parseInt(numMatch[1], 10);
        return resolveNum(num) || `[${citation}]`;
      }
      return `[${citation}]`;
    });
    return resolved.join(' ');
  });
  
  // #region agent log  
  fetch('http://127.0.0.1:7243/ingest/cc739506-e25d-45e2-b543-cb8ae30e3ecd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'formatting.ts:resolveCitations:end',message:'Citation resolution output',data:{resultLength:result.length,hasUnresolvedNumeric:/\[\d+\]/.test(result),hasUnresolvedPerplexity:/\[perplexity:/i.test(result),sampleResult:result.slice(0,200)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A,B,C,D,E'})}).catch(()=>{});
  // #endregion
  
  return result;
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