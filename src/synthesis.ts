/**
 * Synthesis Phase - Combines all gathered data into a unified, context-aware answer
 */

import { callLLM } from './clients/llm.js';
import { ExecutionResult } from './execution.js';
import { extractContent } from './planning.js';

export interface SynthesisOptions {
  subQuestions?: string[];
  constraints?: string[];
  papersRead?: string[];
  rejectedApproaches?: string[];
  keyFindings?: string[];
  outputFormat?: 'summary' | 'detailed' | 'actionable_steps';
}

/**
 * Synthesize all gathered research data into a unified, context-aware answer
 */
export async function synthesizeFindings(
  geminiKey: string | undefined,
  query: string,
  enrichedContext: string | undefined,
  execution: ExecutionResult,
  options?: SynthesisOptions
): Promise<string> {
  if (!geminiKey) {
    return buildFallbackSynthesis(execution);
  }

  console.error('[Synthesis] Combining all findings...');

  const prompt = buildSynthesisPrompt(query, enrichedContext, execution, options);

  try {
    const response = await callLLM(prompt, {
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      apiKey: geminiKey
    });
    return extractContent(response.content);
  } catch (error) {
    console.error('[Synthesis] Error:', error);
    return buildFallbackSynthesis(execution);
  }
}

function buildSynthesisPrompt(
  query: string,
  enrichedContext: string | undefined,
  execution: ExecutionResult,
  options?: SynthesisOptions
): string {
  const sections: string[] = [];

  sections.push(`You are synthesizing research findings into a unified, actionable answer.

**Original Research Query:** ${query}
`);

  // Add full context so synthesis respects user's situation
  if (enrichedContext) {
    sections.push(`**User's Context:**
${enrichedContext}
`);
  }

  // Constraints to respect
  if (options?.constraints?.length) {
    sections.push(`**Constraints to Respect:**
- ${options.constraints.join('\n- ')}
`);
  }

  // What user already knows - don't repeat
  if (options?.keyFindings?.length) {
    sections.push(`**User Already Knows (don't repeat):**
- ${options.keyFindings.join('\n- ')}
`);
  }

  // Papers already read - don't re-summarize
  if (options?.papersRead?.length) {
    sections.push(`**Papers Already Read (don't re-summarize):**
- ${options.papersRead.join('\n- ')}
`);
  }

  // Approaches already rejected - don't suggest
  if (options?.rejectedApproaches?.length) {
    sections.push(`**Approaches Already Rejected (don't suggest):**
- ${options.rejectedApproaches.join('\n- ')}
`);
  }

  // Sub-questions to explicitly answer
  if (options?.subQuestions?.length) {
    sections.push(`**Sub-Questions to Answer:**
${options.subQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}
`);
  }

  sections.push(`---

**GATHERED RESEARCH DATA:**
`);

  // Web search findings
  if (execution.perplexityResult?.content) {
    sections.push(`**Web Search Results:**
${execution.perplexityResult.content.slice(0, 3000)}
`);
  }

  // Academic papers
  if (execution.arxivPapers?.papers?.length) {
    const paperSummaries = execution.arxivPapers.papers
      .map(p => `- **${p.title}** (${p.id}): ${p.summary}`)
      .join('\n');
    sections.push(`**Academic Papers Found:**
${paperSummaries}
`);
  }

  // Library documentation
  if (execution.libraryDocs) {
    sections.push(`**Library Documentation:**
${execution.libraryDocs.slice(0, 2000)}
`);
  }

  // Sub-question research
  if (execution.subQuestionResults?.length) {
    const subResults = execution.subQuestionResults
      .map(sq => `**Q: ${sq.question}**\n${sq.perplexityResult?.content?.slice(0, 500) || 'No results'}`)
      .join('\n\n');
    sections.push(`**Sub-Question Research:**
${subResults}
`);
  }

  // Deep analysis if available
  if (execution.deepThinking) {
    sections.push(`**Deep Analysis:**
${extractContent(execution.deepThinking).slice(0, 2000)}
`);
  }

  // Output format instructions
  const formatInstructions = {
    summary: 'Provide a concise 3-4 paragraph summary.',
    detailed: 'Provide a comprehensive analysis with sections and subsections.',
    actionable_steps: 'Provide numbered actionable steps the user can follow immediately.',
  };

  sections.push(`---

**YOUR TASK:**

Synthesize ALL the above research into a **unified, cohesive answer** that:

1. **Directly answers the original query** in the user's context
2. **Respects all constraints** (budget, time, technical limits)
3. **Does NOT repeat** what the user already knows or papers they've read
4. **Does NOT suggest** approaches they've already rejected
5. **Explicitly answers each sub-question** if provided
6. **Weighs and reconciles** findings from different sources
7. **Cites sources** when making specific claims (e.g., "According to arXiv paper X...")

**Output Format:** ${formatInstructions[options?.outputFormat || 'detailed']}

**Important:** Do NOT dump raw data. Synthesize it into a flowing, readable answer that directly addresses the user's needs.
`);

  return sections.join('\n');
}

/**
 * Fallback synthesis when Gemini API key is unavailable
 */
function buildFallbackSynthesis(execution: ExecutionResult): string {
  const parts: string[] = [];

  if (execution.perplexityResult?.content) {
    parts.push(`**Key Findings:**\n${execution.perplexityResult.content.slice(0, 1500)}`);
  }

  if (execution.arxivPapers?.papers?.length) {
    parts.push(`**Relevant Papers:** ${execution.arxivPapers.papers.length} papers found`);
  }

  if (execution.libraryDocs) {
    parts.push(`**Library Documentation:** Available`);
  }

  return parts.join('\n\n') || 'No synthesis available - GEMINI_API_KEY not provided.';
}









