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
  includeCodeExamples?: boolean;
}

/**
 * Structured synthesis output
 * Parsed from markdown with section delimiters
 */
export interface SynthesisOutput {
  overview: string;
  subQuestions?: Record<string, {
    question: string;
    answer: string;
  }>;
  additionalInsights?: string;
}

// Section delimiter pattern: <!-- SECTION:name -->
const SECTION_DELIMITER = /<!--\s*SECTION:(\w+)\s*-->/g;

/**
 * Synthesize all gathered research data into a unified, context-aware answer
 * Automatically uses phased synthesis if sub-questions exist (for token efficiency)
 */
export async function synthesizeFindings(
  geminiKey: string | undefined,
  query: string,
  enrichedContext: string | undefined,
  execution: ExecutionResult,
  options?: SynthesisOptions
): Promise<SynthesisOutput> {
  if (!geminiKey) {
    return buildFallbackSynthesis(execution);
  }

  // Use phased synthesis if sub-questions exist (40% token savings)
  const usePhased = (options?.subQuestions?.length || 0) > 0;

  if (usePhased) {
    console.error('[Synthesis] Using phased approach (token-efficient)...');
    return synthesizePhased(geminiKey, query, enrichedContext, execution, options);
  }

  // Single-phase synthesis for simple queries
  console.error('[Synthesis] Single-phase synthesis...');
  const prompt = buildSynthesisPrompt(query, enrichedContext, execution, options, false);

  try {
    const response = await callLLM(prompt, {
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      apiKey: geminiKey,
      timeout: 120000,
      maxOutputTokens: 32000
    });
    
    return parseMarkdownSections(response.content, options?.subQuestions);
  } catch (error) {
    console.error('[Synthesis] Error:', error);
    return buildFallbackSynthesis(execution);
  }
}

/**
 * Build synthesis prompt (unified for single-phase and main-query-only)
 * @param mainQueryOnly - If true, omits sub-question sections (for phased synthesis)
 */
function buildSynthesisPrompt(
  query: string,
  enrichedContext: string | undefined,
  execution: ExecutionResult,
  options?: SynthesisOptions,
  mainQueryOnly: boolean = false
): string {
  const sections: string[] = [];

  sections.push(`You are synthesizing research findings${mainQueryOnly ? ' for the MAIN QUERY ONLY (sub-questions handled separately)' : ''}.

**${mainQueryOnly ? 'Main Research Query' : 'Original Research Query'}:** ${query}
`);

  if (enrichedContext) {
    sections.push(`**User's Context:**
${enrichedContext}
`);
  }

  if (options?.constraints?.length) {
    sections.push(`**Constraints${mainQueryOnly ? '' : ' to Respect'}:**
- ${options.constraints.join('\n- ')}
`);
  }

  if (options?.keyFindings?.length) {
    sections.push(`**User Already Knows (don't repeat):**
- ${options.keyFindings.join('\n- ')}
`);
  }

  if (options?.papersRead?.length) {
    sections.push(`**Papers Already Read (don't re-summarize):**
- ${options.papersRead.join('\n- ')}
`);
  }

  if (options?.rejectedApproaches?.length) {
    sections.push(`**Approaches Already Rejected (don't suggest):**
- ${options.rejectedApproaches.join('\n- ')}
`);
  }

  if (options?.includeCodeExamples) {
    sections.push(`**Code Examples Required:**
- Include practical, working code examples where relevant
- Show implementation patterns and best practices
- Use markdown code blocks with language tags
`);
  }

  sections.push(`---

**GATHERED RESEARCH DATA:**
`);

  if (execution.perplexityResult?.content) {
    sections.push(`**Web Search${mainQueryOnly ? '' : ' Results'} [perplexity]:**
${execution.perplexityResult.content.slice(0, 3000)}

Sources: ${execution.perplexityResult.sources?.join(', ') || 'Not available'}
`);
  }

  if (execution.arxivPapers?.papers?.length) {
    const paperSummaries = execution.arxivPapers.papers
      .map(p => `- **${p.title}** [arxiv:${p.id}]: ${p.summary}`)
      .join('\n');
    sections.push(`**Academic Papers${mainQueryOnly ? '' : ' Found'} [arxiv]:**
${paperSummaries}
`);
  }

  if (execution.libraryDocs) {
    sections.push(`**Library Documentation [context7]:**
${execution.libraryDocs.slice(0, 2000)}
`);
  }

  // Only include sub-question data if NOT main-query-only
  if (!mainQueryOnly && execution.subQuestionResults?.length) {
    const subResults = execution.subQuestionResults
      .map(sq => {
        const sources = [];
        if (sq.perplexityResult) sources.push('[perplexity]');
        if (sq.libraryDocs) sources.push('[context7]');
        return `**Q: ${sq.question}** ${sources.join(' ')}\n${sq.perplexityResult?.content?.slice(0, 500) || 'No results'}`;
      })
      .join('\n\n');
    sections.push(`**Sub-Question Research:**
${subResults}
`);
  }

  if (execution.deepThinking) {
    sections.push(`**Deep Analysis [deep_analysis]:**
${extractContent(execution.deepThinking).slice(0, 2000)}
`);
  }

  // Task instructions
  if (mainQueryOnly) {
    sections.push(`---

**YOUR TASK:**

Write a comprehensive answer to the main query. Be thorough and detailed.

**Important:**
- Include code examples where relevant (in markdown blocks)
- Use inline citations: [perplexity:url], [context7:library-name], [arxiv:paper-id]
- This is ONLY for the main query - sub-questions handled separately
- Be comprehensive, don't artificially limit length
`);
  } else {
    // Build section format instructions for full synthesis
    const subQuestionSections = options?.subQuestions?.length
      ? options.subQuestions.map((q, i) => `<!-- SECTION:q${i + 1} -->
## Q${i + 1}: ${q}
[Comprehensive answer - multiple paragraphs with examples]`).join('\n\n')
      : '';

    sections.push(`---

**YOUR TASK:**

Synthesize ALL the above research into a **unified, cohesive answer** using this EXACT format with section delimiters:

<!-- SECTION:overview -->
## Overview
[Comprehensive answer to the main query - multiple paragraphs, be thorough and detailed]

${subQuestionSections}

<!-- SECTION:additional_insights -->
## Additional Insights
[Optional: extra recommendations, caveats, or implementation tips]

**Important:**
- Use the EXACT section delimiters shown above: <!-- SECTION:name -->
- Be comprehensive and thorough in each section
- Include code examples in markdown code blocks where helpful
- **Use inline citations** to indicate source of information:
  - [perplexity:url] for web search findings
  - [context7:library-name] for library documentation/code
  - [arxiv:paper-id] for academic papers
  - Example: "LangSmith provides dataset management [context7:langsmith] which allows version control [perplexity:langsmith-docs]"
- Cite sources when making specific claims or showing code examples
- Don't artificially limit your response length
`);
  }

  return sections.join('\n');
}

/**
 * Parse markdown response with section delimiters into structured output
 */
function parseMarkdownSections(markdown: string, subQuestions?: string[]): SynthesisOutput {
  const result: SynthesisOutput = {
    overview: '',
  };

  // Find all section delimiters and their positions
  const delimiterMatches: Array<{ name: string; index: number }> = [];
  let match;
  const delimiterRegex = /<!--\s*SECTION:(\w+)\s*-->/g;
  
  while ((match = delimiterRegex.exec(markdown)) !== null) {
    delimiterMatches.push({ name: match[1], index: match.index + match[0].length });
  }

  // Extract content between delimiters
  for (let i = 0; i < delimiterMatches.length; i++) {
    const current = delimiterMatches[i];
    const next = delimiterMatches[i + 1];
    const endIndex = next ? next.index - `<!-- SECTION:${next.name} -->`.length : markdown.length;
    
    let content = markdown.substring(current.index, endIndex).trim();
    
    // Remove the ## header line if present (we'll use our own formatting)
    content = content.replace(/^##\s+[^\n]+\n/, '').trim();
    
    if (current.name === 'overview') {
      result.overview = content;
    } else if (current.name === 'additional_insights') {
      result.additionalInsights = content;
    } else if (current.name.startsWith('q')) {
      // Sub-question
      if (!result.subQuestions) {
        result.subQuestions = {};
      }
      const qIndex = parseInt(current.name.substring(1), 10) - 1;
      const question = subQuestions?.[qIndex] || `Question ${current.name}`;
      result.subQuestions[current.name] = {
        question,
        answer: content
      };
    }
  }

  // Fallback: if no delimiters found, treat entire response as overview
  if (!result.overview && delimiterMatches.length === 0) {
    result.overview = markdown;
  }

  return result;
}

/**
 * PHASED SYNTHESIS (internal - called by synthesizeFindings)
 * 1. Synthesize main query overview
 * 2. Extract key findings summary (~500 tokens)
 * 3. Synthesize each sub-question with key findings injected
 */
async function synthesizePhased(
  geminiKey: string,
  query: string,
  enrichedContext: string | undefined,
  execution: ExecutionResult,
  options?: SynthesisOptions
): Promise<SynthesisOutput> {
  // Phase 1: Main query synthesis (reuses buildSynthesisPrompt with mainQueryOnly flag)
  console.error('[Synthesis] Phase 1: Main query overview...');
  const mainPrompt = buildSynthesisPrompt(query, enrichedContext, execution, options, true);
  const mainResponse = await callLLM(mainPrompt, {
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    apiKey: geminiKey,
    timeout: 60000,
    maxOutputTokens: 16000
  });

  const result: SynthesisOutput = {
    overview: mainResponse.content.trim(),
  };

  // Phase 2: Extract key findings
  console.error('[Synthesis] Phase 2: Extracting key findings...');
  const keyFindings = await extractKeyFindings(geminiKey, mainResponse.content, query);
  
  // Phase 3: Sub-question synthesis in parallel with key findings injection
  console.error(`[Synthesis] Phase 3: ${options!.subQuestions!.length} sub-questions (parallel, with key findings)...`);
  const subQSyntheses = await Promise.all(
    options!.subQuestions!.map((subQ, idx) => 
      synthesizeSubQuestion(
        geminiKey,
        subQ,
        keyFindings,
        execution.subQuestionResults?.[idx],
        execution.libraryDocs,
        options,
        execution.arxivPapers  // Pass shared papers
      )
    )
  );

  // Compile sub-question results
  result.subQuestions = {};
  subQSyntheses.forEach((answer, idx) => {
    result.subQuestions![`q${idx + 1}`] = {
      question: options!.subQuestions![idx],
      answer
    };
  });

  // Add additional insights if needed
  if (execution.deepThinking) {
    result.additionalInsights = `**Deep Analysis:** ${extractContent(execution.deepThinking).slice(0, 1000)}`;
  }

  return result;
}

/**
 * Extract key findings summary from main synthesis (~500 tokens)
 */
async function extractKeyFindings(
  geminiKey: string,
  mainSynthesis: string,
  query: string
): Promise<string> {
  const prompt = `Extract the KEY FINDINGS from this research synthesis in ~500 words.

Original Query: ${query}

Synthesis:
${mainSynthesis}

---

Write a concise summary of:
1. Main conclusions
2. Important patterns/principles discovered
3. Critical technical details (API names, approach names, etc.)
4. Any warnings or caveats

This will be used to ensure sub-questions don't contradict the main findings.

Keep it under 500 words, be specific.`;

  const response = await callLLM(prompt, {
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    apiKey: geminiKey,
    timeout: 30000,
    maxOutputTokens: 2000
  });

  return response.content.trim();
}

/**
 * Synthesize a single sub-question with key findings context
 */
async function synthesizeSubQuestion(
  geminiKey: string,
  subQuestion: string,
  keyFindings: string,
  subQData: any,
  sharedLibraryDocs?: string,
  options?: SynthesisOptions,
  arxivPapers?: { papers: any[] }  // Shared papers from main execution
): Promise<string> {
  const sections: string[] = [];

  sections.push(`You are answering a SUB-QUESTION that is part of a larger research query.

**Sub-Question:** ${subQuestion}

**Key Findings from Main Research (ensure consistency):**
${keyFindings}

---

**GATHERED DATA FOR THIS SUB-QUESTION:**
`);

  if (subQData?.perplexityResult?.content) {
    sections.push(`**Web Search [perplexity]:**
${subQData.perplexityResult.content.slice(0, 2000)}
`);
  }

  // Include shared arxiv papers if available
  if (arxivPapers?.papers?.length) {
    const paperSummaries = arxivPapers.papers
      .map(p => `- **${p.title}** [arxiv:${p.id}]: ${p.summary}`)
      .join('\n');
    sections.push(`**Academic Papers [arxiv]:**
${paperSummaries}
`);
  }

  if (subQData?.libraryDocs) {
    sections.push(`**Library Documentation [context7]:**
${subQData.libraryDocs.slice(0, 1500)}
`);
  } else if (sharedLibraryDocs) {
    sections.push(`**Shared Library Documentation [context7]:**
${sharedLibraryDocs.slice(0, 1500)}
`);
  }

  sections.push(`---

**YOUR TASK:**

Answer the sub-question thoroughly. Ensure your answer:
- Aligns with the key findings above (don't contradict)
- Uses inline citations: [perplexity:url], [context7:library], [arxiv:id]
- Includes code examples if relevant
- Leverages academic papers if relevant to this specific question
- Is comprehensive and detailed

Don't artificially limit your response length.`);

  const response = await callLLM(sections.join('\n'), {
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    apiKey: geminiKey,
    timeout: 60000,
    maxOutputTokens: 8000
  });

  return response.content.trim();
}

/**
 * Fallback synthesis when Gemini API key is unavailable
 */
function buildFallbackSynthesis(execution: ExecutionResult): SynthesisOutput {
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

  return {
    overview: parts.join('\n\n') || 'No synthesis available - GEMINI_API_KEY not provided.',
    additionalInsights: 'This is a fallback response due to missing API key.'
  };
}
