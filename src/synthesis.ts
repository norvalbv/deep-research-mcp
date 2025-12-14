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
 * Returns structured output parsed from markdown with section delimiters
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

  console.error('[Synthesis] Combining all findings...');

  const prompt = buildSynthesisPrompt(query, enrichedContext, execution, options);

  try {
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/cc739506-e25d-45e2-b543-cb8ae30e3ecd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'synthesis.ts:synthesizeFindings',message:'Calling LLM for synthesis',data:{promptLength:prompt.length,hasSubQuestions:!!options?.subQuestions?.length,includeCode:!!options?.includeCodeExamples},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A',runId:'markdown-fix'})}).catch(()=>{});
    // #endregion
    
    const response = await callLLM(prompt, {
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      apiKey: geminiKey,
      timeout: 120000,
      maxOutputTokens: 32000
    });
    
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/cc739506-e25d-45e2-b543-cb8ae30e3ecd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'synthesis.ts:synthesizeFindings:afterLLM',message:'LLM response received',data:{responseLength:response.content.length,responsePreview:response.content.substring(0,500),responseEnd:response.content.substring(response.content.length-200)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'C,D',runId:'markdown-fix'})}).catch(()=>{});
    // #endregion
    
    // Parse markdown with section delimiters
    const parsed = parseMarkdownSections(response.content, options?.subQuestions);
    
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/cc739506-e25d-45e2-b543-cb8ae30e3ecd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'synthesis.ts:synthesizeFindings:success',message:'Successfully parsed markdown sections',data:{hasOverview:!!parsed.overview,overviewLength:parsed.overview?.length,hasSubQuestions:!!parsed.subQuestions,subQuestionCount:Object.keys(parsed.subQuestions || {}).length},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'B',runId:'markdown-fix'})}).catch(()=>{});
    // #endregion
    
    return parsed;
  } catch (error) {
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/cc739506-e25d-45e2-b543-cb8ae30e3ecd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'synthesis.ts:synthesizeFindings:error',message:'Synthesis failed',data:{error:String(error),errorMessage:error instanceof Error ? error.message : 'unknown'},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'E',runId:'markdown-fix'})}).catch(()=>{});
    // #endregion
    
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

  if (enrichedContext) {
    sections.push(`**User's Context:**
${enrichedContext}
`);
  }

  if (options?.constraints?.length) {
    sections.push(`**Constraints to Respect:**
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
    sections.push(`**Web Search Results [perplexity]:**
${execution.perplexityResult.content.slice(0, 3000)}

Sources: ${execution.perplexityResult.sources?.join(', ') || 'Not available'}
`);
  }

  if (execution.arxivPapers?.papers?.length) {
    const paperSummaries = execution.arxivPapers.papers
      .map(p => `- **${p.title}** [arxiv:${p.id}]: ${p.summary}`)
      .join('\n');
    sections.push(`**Academic Papers Found [arxiv]:**
${paperSummaries}
`);
  }

  if (execution.libraryDocs) {
    sections.push(`**Library Documentation [context7]:**
${execution.libraryDocs.slice(0, 2000)}
`);
  }

  if (execution.subQuestionResults?.length) {
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

  // Build section format instructions
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

  return sections.join('\n');
}

/**
 * Parse markdown response with section delimiters into structured output
 */
function parseMarkdownSections(markdown: string, subQuestions?: string[]): SynthesisOutput {
  // #region agent log
  fetch('http://127.0.0.1:7243/ingest/cc739506-e25d-45e2-b543-cb8ae30e3ecd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'synthesis.ts:parseMarkdownSections',message:'Parsing markdown sections',data:{markdownLength:markdown.length,hasSubQuestions:!!subQuestions?.length},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'PARSE',runId:'markdown-fix'})}).catch(()=>{});
  // #endregion

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

  // #region agent log
  fetch('http://127.0.0.1:7243/ingest/cc739506-e25d-45e2-b543-cb8ae30e3ecd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'synthesis.ts:parseMarkdownSections:delimiters',message:'Found delimiters',data:{count:delimiterMatches.length,names:delimiterMatches.map(d=>d.name)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'PARSE',runId:'markdown-fix'})}).catch(()=>{});
  // #endregion

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
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/cc739506-e25d-45e2-b543-cb8ae30e3ecd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'synthesis.ts:parseMarkdownSections:fallback',message:'No delimiters found, using entire response as overview',data:{markdownLength:markdown.length},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'PARSE',runId:'markdown-fix'})}).catch(()=>{});
    // #endregion
    result.overview = markdown;
  }

  return result;
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
