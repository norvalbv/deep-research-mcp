import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { perplexitySearch } from './services/perplexity.js';
import { arxivSearch, ArxivPaper, ArxivResult } from './services/arxiv.js';
import { callLLM } from './clients/llm.js';
import { searchLibraryDocs } from './clients/context7.js';
import { ComplexityLevel, DocumentationCache, RootPlan, SubQuestionPlan } from './types/index.js';
import { ResearchActionPlan, extractContent } from './planning.js';

export interface ExecutionContext {
  query: string;
  enrichedContext?: string;
  depth: ComplexityLevel;
  actionPlan: ResearchActionPlan;
  context7Client: Client | null;
  options?: {
    subQuestions?: string[];
    constraints?: string[];
    includeCodeExamples?: boolean;
    techStack?: string[];
    papersRead?: string[];
    outputFormat?: 'summary' | 'detailed' | 'actionable_steps';
  };
  env?: Record<string, string>;
}

export interface ExecutionResult {
  perplexityResult?: { content: string; sources?: string[] };
  deepThinking?: string;
  libraryDocs?: string;
  arxivPapers?: ArxivResult;  // Shared across main + sub-Qs
  subQuestionResults?: Array<{ 
    question: string; 
    perplexityResult?: { content: string }; 
    deepThinking?: string; 
    libraryDocs?: string;
    // arxivPapers inherited from main result (not duplicated)
  }>;
  docCache?: DocumentationCache;  // Store for validation pass
}

export async function executeResearchPlan(ctx: ExecutionContext): Promise<ExecutionResult> {
  const result: ExecutionResult = {};
  const { query, enrichedContext, actionPlan, context7Client, options, env } = ctx;

  // Extract RootPlan structure (new) or construct from legacy
  const rootPlan = extractRootPlan(actionPlan, options) || {
    mainQuery: { complexity: actionPlan.complexity, steps: actionPlan.steps },
    subQuestions: [],
    sharedDocumentation: { libraries: options?.techStack || [], topics: ['getting started'] }
  };
  
  // Check if ANY query needs Context7
  const needsContext7 = rootPlan.mainQuery.steps.some(s => s.includes('context7') || s.includes('library')) ||
                        (options?.subQuestions?.length || 0) > 0;  // Sub-Qs might need it
  
  // Fetch shared base documentation if needed
  let docCache: DocumentationCache | undefined;
  if (needsContext7 && context7Client && rootPlan.sharedDocumentation.libraries.length > 0) {
    console.error('[Exec] Fetching shared base documentation...');
    const base = await fetchSharedDocumentation(context7Client, rootPlan.sharedDocumentation);
    docCache = { base, subQSpecific: {} };
  }

  // Determine which tools to run based on plan and depth level
  // Depth gating (consistent with planning.ts):
  // - Perplexity: depth >= 1 (always)
  // - Deep analysis: depth >= 2
  // - Context7/library docs: depth >= 3
  // - arXiv: depth >= 4
  // - Consensus: depth >= 4 (handled in controller.ts)
  const depth = ctx.depth;
  const shouldRunPerplexity = actionPlan.steps.some(s => s.includes('perplexity') || s.includes('web'));
  const shouldRunDeepThinking = depth >= 2 && actionPlan.steps.some(s => s.includes('deep') || s.includes('thinking'));
  const shouldRunArxiv = depth >= 4 && actionPlan.steps.some(s => s.includes('arxiv') || s.includes('papers')) && !actionPlan.toolsToSkip?.includes('arxiv_search');
  const shouldRunContext7Main = depth >= 3 && actionPlan.steps.some(s => s.includes('context7') || s.includes('library') || s.includes('docs'));
  
  console.error(`[Exec] Depth ${depth}: perplexity=${shouldRunPerplexity}, deep=${shouldRunDeepThinking}, context7=${shouldRunContext7Main}, arxiv=${shouldRunArxiv}`);

  // PHASE 1: Run all data gathering in parallel
  console.error('[Exec] Phase 1: Gathering data in parallel...');
  const gatheringTasks: Promise<void>[] = [];

  if (shouldRunPerplexity) {
    gatheringTasks.push((async () => {
      console.error('[Exec] → Perplexity search...');
      result.perplexityResult = await perplexitySearch(withContext(query, enrichedContext), env?.PERPLEXITY_API_KEY);
    })());
  }

  if (shouldRunArxiv) {
    gatheringTasks.push((async () => {
      console.error('[Exec] → arXiv search with relevance filtering...');
      
      // Use main query only (not combined with sub-questions to reduce noise)
      // Pass API key for keyword extraction and validation
      const arxivResult = await arxivSearch(query, 5, 3, env?.GEMINI_API_KEY);
      
      // Summarize papers once
      if (arxivResult.papers.length > 0 && env?.GEMINI_API_KEY) {
        const summarizedPapers = await summarizePapers(arxivResult.papers, env.GEMINI_API_KEY);
        result.arxivPapers = { ...arxivResult, papers: summarizedPapers };
        
        // Papers are now available for all sections (main + sub-Qs)
        console.error(`[Exec]   ${summarizedPapers.length} relevant papers found`);
      } else {
        result.arxivPapers = arxivResult;
      }
    })());
  }

  // Main query Context7 (if specified and not using shared docs)
  if (shouldRunContext7Main && context7Client) {
    gatheringTasks.push((async () => {
      console.error('[Exec] → Library docs for main query...');
      
      // If we have shared docs, combine with any main-specific queries
      let allDocs: string[] = [];
      
      if (docCache?.base) {
        allDocs = Object.values(docCache.base).map(d => d.content);
      }
      
      // Check if main query needs additional specific docs beyond shared
      // For now, use techStack as fallback
      if (options?.techStack?.length && !docCache) {
        const docs = await Promise.all(options.techStack.map(lib => searchLibraryDocs(context7Client, lib, query)));
        allDocs.push(...docs.filter(Boolean));
      }
      
      result.libraryDocs = allDocs.join('\n\n---\n\n');
    })());
  } else if (docCache?.base && Object.keys(docCache.base).length > 0) {
    // Use shared docs for main query
    result.libraryDocs = Object.values(docCache.base).map(d => d.content).join('\n\n---\n\n');
  }

  // Sub-questions run in parallel with main query
  // Each sub-Q gets its own planning call
  if (options?.subQuestions?.length) {
    gatheringTasks.push((async () => {
      const subQuestions = options.subQuestions!;
      console.error(`[Exec] → ${subQuestions.length} sub-questions (inheriting main plan tools)...`);
      
      // Execute each sub-Q using inherited tools from main plan
      result.subQuestionResults = await Promise.all(
        subQuestions.map(async (question, idx) => {
          const sub: any = { question };
          
          console.error(`[Exec]   Sub-Q ${idx + 1}: ${question.slice(0, 60)}...`);
          
          // Inherit main plan's tool strategy
          const needsPerplexity = actionPlan.toolsToUse.includes('perplexity');
          const needsContext7 = actionPlan.toolsToUse.includes('context7');
          
          // Execute based on inherited plan
          if (needsPerplexity) {
            sub.perplexityResult = await perplexitySearch(withContext(question, enrichedContext), env?.PERPLEXITY_API_KEY);
          }
          
          // Sub-Q specific Context7 call (if main plan uses it)
          if (needsContext7 && context7Client) {
            const lib = options?.techStack?.[0] || rootPlan.sharedDocumentation.libraries[0];
            
            if (lib) {
              const specificDocs = await searchLibraryDocs(context7Client, lib, question);
              sub.libraryDocs = specificDocs;
              
              // Store in cache for validation pass
              if (docCache) {
                docCache.subQSpecific[idx] = {
                  content: specificDocs,
                  library: lib,
                  topic: question
                };
              }
            }
          }
          
          // Combine shared base + sub-Q specific docs
          if (docCache?.base && Object.keys(docCache.base).length > 0) {
            const baseDocs = Object.values(docCache.base).map(d => d.content).join('\n\n---\n\n');
            sub.libraryDocs = sub.libraryDocs ? `${baseDocs}\n\n---\n\n${sub.libraryDocs}` : baseDocs;
          }
          
          return sub;
        })
      );
    })());
  }

  // Wait for all gathering tasks
  await Promise.all(gatheringTasks);

  // PHASE 2: Deep analysis (needs perplexity results for best quality)
  if (shouldRunDeepThinking && env?.GEMINI_API_KEY) {
    console.error('[Exec] Phase 2: Deep analysis...');
    const response = await callLLM(
      buildDeepAnalysisPrompt(query, enrichedContext, result.perplexityResult?.content),
      {
        provider: 'gemini',
        model: 'gemini-3-flash-preview',
        apiKey: env.GEMINI_API_KEY
      }
    );
    result.deepThinking = response.content;
  }

  // Store doc cache for validation pass
  if (docCache && (Object.keys(docCache.base).length > 0 || Object.keys(docCache.subQSpecific).length > 0)) {
    result.docCache = docCache;
  }

  return result;
}

async function summarizePapers(papers: ArxivPaper[], geminiKey: string): Promise<ArxivPaper[]> {
  return Promise.all(papers.map(async (p) => {
    try {
      // Use fast model for simple summarization to avoid timeouts
      const response = await callLLM(
        `Summarize in <300 chars: ${p.title}\n${p.summary}`,
        {
          provider: 'gemini',
          model: 'gemini-3-flash-preview',
          apiKey: geminiKey
        }
      );
      // Extract content from JSON wrapper if present
      const summary = extractContent(response.content);
      return { ...p, summary: summary.length > 300 ? summary.slice(0, 297) + '...' : summary };
    } catch { return { ...p, summary: p.summary.slice(0, 297) + '...' }; }
  }));
}

function withContext(main: string, ctx?: string): string {
  return ctx ? `${main}\n\nContext: ${ctx}` : main;
}

function buildDeepAnalysisPrompt(query: string, ctx?: string, searchResults?: string): string {
  return `
You are a research analyst providing deep technical analysis. Analyze the following research query comprehensively.

**Research Query:** ${query}

${ctx ? `**Context:**\n${ctx}\n` : ''}

**Web Search Results:**
${searchResults || 'No search results available yet.'}

---

**Your Analysis Should Cover:**

1. **Key Insights and Findings**
   - What are the most important discoveries from the search results?
   - What patterns or trends emerge?
   - What are the consensus views vs. contrarian perspectives?

2. **Technical Details and Nuances**
   - Dive deep into the technical implementation details
   - Explain complex concepts clearly
   - Highlight important edge cases or gotchas

3. **Practical Implications**
   - How does this apply to real-world scenarios?
   - What are the trade-offs involved?
   - What should practitioners consider?

4. **Potential Challenges and Considerations**
   - What are the limitations or risks?
   - What could go wrong?
   - What are common mistakes to avoid?

5. **Recommendations**
   - Based on the analysis, what approach would you recommend?
   - What are the next steps for someone implementing this?

Provide a thorough, well-structured analysis. Be specific and cite evidence from the search results where applicable.
`.trim();
}

/**
 * Fetch shared base documentation from Context7
 * This is fetched once and shared across all queries
 */
async function fetchSharedDocumentation(
  client: Client | null,
  sharedDocs: { libraries: string[]; topics: string[] }
): Promise<DocumentationCache['base']> {
  if (!client || !sharedDocs.libraries.length) {
    return {};
  }

  console.error(`[Exec] Fetching shared docs for: ${sharedDocs.libraries.join(', ')}`);
  
  const baseCache: DocumentationCache['base'] = {};
  
  await Promise.all(
    sharedDocs.libraries.map(async (lib) => {
      try {
        // Fetch general docs for this library
        const topicQuery = sharedDocs.topics.length > 0 ? sharedDocs.topics.join(' ') : 'getting started';
        const docs = await searchLibraryDocs(client, lib, topicQuery);
        
        if (docs && !docs.includes('Could not find library')) {
          baseCache[lib] = {
            content: docs,
            topic: topicQuery
          };
        }
      } catch (error) {
        console.error(`[Exec] Failed to fetch shared docs for ${lib}:`, error);
      }
    })
  );
  
  return baseCache;
}

/**
 * Extract RootPlan from action plan (if new structure present)
 */
function extractRootPlan(actionPlan: ResearchActionPlan, options?: any): RootPlan {
  // Construct from plan structure (user reverted _rawPlan architecture)
  return {
    mainQuery: {
      complexity: actionPlan.complexity,
      steps: actionPlan.steps
    },
    subQuestions: [],  // Sub-Qs inherit tools from main plan
    sharedDocumentation: {
      libraries: options?.techStack || [],
      topics: ['getting started']
    }
  };
}
