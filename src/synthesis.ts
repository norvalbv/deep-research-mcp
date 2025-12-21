/**
 * Synthesis Phase - Combines all gathered data into a unified, context-aware answer
 * 
 * Implements Global Constraint Manifest for consistency (arxiv:2310.03025)
 */

import { callLLM } from './clients/llm.js';
import { ExecutionResult } from './execution.js';
import { extractContent } from './planning.js';
import { GlobalManifest } from './types/index.js';

export interface SynthesisOptions {
  subQuestions?: string[];
  constraints?: string[];
  papersRead?: string[];
  rejectedApproaches?: string[];
  keyFindings?: string[];
  outputFormat?: 'summary' | 'detailed' | 'actionable_steps';
  includeCodeExamples?: boolean;
  depth?: number;  // Complexity level 1-5, gates features like code examples
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
      model: 'gemini-2.5-flash-lite',
      apiKey: geminiKey,
      timeout: 120000,
      maxOutputTokens: 32000,
      temperature: 0.2  // Lower for deterministic, specific outputs
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

**PERSONA**: Act as a senior production engineer delivering deployable solutions.

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

  // Only include code examples at depth >= 3
  const depth = options?.depth ?? 5;
  if (options?.includeCodeExamples && depth >= 3) {
    sections.push(`**Code Examples Required (PRODUCTION-READY):**

### CRITICAL: DO NOT use TODO, FIXME, placeholders, or "# example" comments.
Every function must be FULLY IMPLEMENTED and executable.

**Required in ALL code:**
- Error handling with try/catch
- Retry logic with exponential backoff for API calls
- Type hints/annotations
- Logging for debugging

**CORRECT example:**
\`\`\`python
async def api_call_with_retry(prompt: str, max_retries: int = 3) -> str:
    for attempt in range(max_retries):
        try:
            response = await client.chat(prompt)
            logger.info(f"Success on attempt {attempt + 1}")
            return response.content
        except RateLimitError:
            wait = 2 ** attempt
            logger.warning(f"Rate limited, waiting {wait}s")
            await asyncio.sleep(wait)
    raise Exception("All retries failed")
\`\`\`

**WRONG example (DO NOT generate like this):**
\`\`\`python
def process_data(data):
    # TODO: implement actual processing
    pass
\`\`\`
`);
  } else if (depth < 3) {
    // At low depth, explicitly discourage code
    sections.push(`**Note:** This is a quick lookup (depth ${depth}). Provide a direct, concise answer. Do NOT include code examples or implementation details.`);
  }

  sections.push(`---

**GATHERED RESEARCH DATA:**
`);

  if (execution.perplexityResult?.content) {
    // Format sources with numbered references for easier citation
    const sourcesFormatted = execution.perplexityResult.sources?.length
      ? execution.perplexityResult.sources.map((url, i) => `[${i + 1}] ${url}`).join('\n')
      : 'Not available';
    
    sections.push(`**Web Search${mainQueryOnly ? '' : ' Results'} [perplexity]:**
${execution.perplexityResult.content.slice(0, 3000)}

**Sources (cite as [perplexity:N] where N is the source number):**
${sourcesFormatted}

**CITATION FORMAT:** When citing web findings, use [perplexity:1], [perplexity:2], etc. based on the source numbers above.
`);
  }

  if (execution.arxivPapers?.papers?.length) {
    const paperSummaries = execution.arxivPapers.papers
      .map(p => `- **${p.title}** [arxiv:${p.id}]: ${p.summary}`)
      .join('\n');
    sections.push(`**Academic Papers${mainQueryOnly ? '' : ' Found'} [arxiv] - CITE ONLY THESE IDs:**
${paperSummaries}

**CRITICAL: Only cite the arxiv IDs listed above. Do NOT invent or hallucinate other arxiv IDs.**
`);
  }

  if (execution.libraryDocs) {
    sections.push(`**Library Documentation [context7] - USE FOR EXACT SYNTAX:**
${execution.libraryDocs.slice(0, 2000)}

**IMPORTANT**: Use the EXACT API calls, imports, and patterns shown above.
Do NOT hallucinate alternative APIs. If the docs show \`client.foo()\`, use that, not \`client.bar()\`.
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

**Requirements:**
1. Use exact numbers with units (">85% accuracy", "<200ms latency")
2. Pick ONE clear recommendation when multiple options exist
3. Include working code examples with complete implementations
4. Use inline citations: [perplexity:N], [context7:library], [arxiv:id]
5. Be thorough - don't truncate or cut off mid-sentence
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

**Requirements:**
1. Use EXACT section delimiters: <!-- SECTION:name -->
2. Use exact numbers with units (">85% accuracy", "<200ms latency")
3. Pick ONE clear recommendation when multiple options exist
4. Include working code examples with complete implementations
5. Inline citations: [perplexity:N], [context7:library], [arxiv:id]
6. Keep logic consistent across sections (if overview uses "X OR Y", sub-questions must too)
7. Be thorough - don't truncate mid-sentence
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
    model: 'gemini-2.5-flash-lite',
    apiKey: geminiKey,
    timeout: 60000,
    maxOutputTokens: 16000,
    temperature: 0.2  // Lower for deterministic, specific outputs
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
    model: 'gemini-2.5-flash-lite',
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
    sections.push(`**Academic Papers [arxiv] - CITE ONLY THESE IDs:**
${paperSummaries}

**CRITICAL: Only cite the arxiv IDs listed above. Do NOT invent or hallucinate other arxiv IDs.**
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

**Requirements:**
- Match the logic from key findings (if overview uses OR, you must too)
- Include complete, working code examples
- Be thorough - don't truncate mid-sentence`);

  const response = await callLLM(sections.join('\n'), {
    provider: 'gemini',
    model: 'gemini-2.5-flash-lite',
    apiKey: geminiKey,
    timeout: 60000,
    maxOutputTokens: 8000,
    temperature: 0.2  // Lower for deterministic, specific outputs
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

/**
 * Extract Global Constraint Manifest from sources BEFORE synthesis
 * This ensures all parallel synthesis calls share consistent facts
 * 
 * Based on arxiv:2310.03025 (PVR architecture)
 * 
 * @param execution - Research execution results containing source data
 * @param geminiKey - API key for LLM extraction
 * @returns GlobalManifest with key facts, numerics, and sources
 */
export async function extractGlobalManifest(
  execution: ExecutionResult,
  geminiKey: string | undefined
): Promise<GlobalManifest> {
  const manifest: GlobalManifest = {
    keyFacts: [],
    numerics: {},
    sources: [],
    extractedAt: Date.now(),
  };

  // Collect source citations
  if (execution.arxivPapers?.papers?.length) {
    manifest.sources.push(...execution.arxivPapers.papers.map(p => `arxiv:${p.id}`));
  }
  if (execution.perplexityResult?.sources?.length) {
    manifest.sources.push(...execution.perplexityResult.sources.map((s, i) => `perplexity:${i + 1}`));
  }

  // If no API key, return basic manifest with sources only
  if (!geminiKey) {
    return manifest;
  }

  // Build source content for extraction
  const sourceContent: string[] = [];

  if (execution.arxivPapers?.papers?.length) {
    const paperContent = execution.arxivPapers.papers
      .map(p => `[arxiv:${p.id}] ${p.title}: ${p.summary}`)
      .join('\n');
    sourceContent.push(`Academic Papers:\n${paperContent}`);
  }

  if (execution.perplexityResult?.content) {
    sourceContent.push(`Web Research:\n${execution.perplexityResult.content.slice(0, 2000)}`);
  }

  if (execution.libraryDocs) {
    sourceContent.push(`Library Documentation:\n${execution.libraryDocs.slice(0, 1500)}`);
  }

  if (sourceContent.length === 0) {
    return manifest;
  }

  // Extract key facts and numerics using LLM
  const extractionPrompt = `Extract KEY FACTS and NUMERIC VALUES from these research sources.

SOURCE DATA:
${sourceContent.join('\n\n---\n\n')}

---

YOUR TASK:
Extract facts that MUST be consistent across all synthesis sections.

Focus on:
1. Numeric thresholds with citations (e.g., "accuracy threshold: 0.85 [arxiv:2310.03025]")
2. Technical specifications with units
3. Named approaches or methods
4. Critical constraints or requirements

Return JSON only:
{
  "keyFacts": [
    "fact with [source:id] citation",
    "another fact with [source:id]"
  ],
  "numerics": {
    "thresholdName": 0.85,
    "timeoutSeconds": 5
  }
}

Return ONLY verifiable facts from the sources. Do NOT invent or hallucinate values.
If no numeric values found, return empty object for numerics.`;

  try {
    const response = await callLLM(extractionPrompt, {
      provider: 'gemini',
      model: 'gemini-2.5-flash-lite',
      apiKey: geminiKey,
      timeout: 15000,
      maxOutputTokens: 2000,
    });

    // Parse JSON response
    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      
      if (Array.isArray(parsed.keyFacts)) {
        manifest.keyFacts = parsed.keyFacts;
      }
      
      if (typeof parsed.numerics === 'object' && parsed.numerics !== null) {
        manifest.numerics = parsed.numerics;
      }
    }

    console.error(`[Manifest] Extracted ${manifest.keyFacts.length} facts, ${Object.keys(manifest.numerics).length} numerics`);

    console.error(`[Manifest] Extracted key facts: ${manifest.keyFacts}`);
    console.error(`[Manifest] Extracted numerics: ${Object.keys(manifest.numerics)}`);
  } catch (error) {
    console.error('[Manifest] Extraction failed, using empty manifest:', error);
  }

  return manifest;
}

/**
 * Format manifest for injection into synthesis prompts
 * Ensures all parallel synthesis calls see the same facts
 */
export function formatManifestForPrompt(manifest: GlobalManifest): string {
  if (manifest.keyFacts.length === 0 && Object.keys(manifest.numerics).length === 0) {
    return '';
  }

  const parts: string[] = [];
  
  parts.push('**GLOBAL CONSTRAINTS (must be consistent across all sections):**');
  
  if (manifest.keyFacts.length > 0) {
    parts.push('\nKey Facts:');
    manifest.keyFacts.forEach((fact, i) => {
      parts.push(`${i + 1}. ${fact}`);
    });
  }
  
  if (Object.keys(manifest.numerics).length > 0) {
    parts.push('\nNumeric Values:');
    for (const [key, value] of Object.entries(manifest.numerics)) {
      parts.push(`- ${key}: ${value}`);
    }
  }
  
  parts.push('\n**IMPORTANT**: Use EXACTLY these values. Do NOT contradict or vary them.\n');
  
  return parts.join('\n');
}
