import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { perplexitySearch } from './services/perplexity.js';
import { arxivSearch, ArxivPaper, ArxivResult } from './services/arxiv.js';
import { palChat } from './clients/pal.js';
import { searchLibraryDocs } from './clients/context7.js';
import { ComplexityLevel } from './types/index.js';
import { ResearchActionPlan, extractContent } from './planning.js';

export interface ExecutionContext {
  query: string;
  enrichedContext?: string;
  depth: ComplexityLevel;
  actionPlan: ResearchActionPlan;
  palClient: Client | null;
  context7Client: Client | null;
  options?: {
    subQuestions?: string[];
    constraints?: string[];
    includeCodeExamples?: boolean;
    techStack?: string[];
    papersRead?: string[];
    outputFormat?: 'summary' | 'detailed' | 'actionable_steps';
  };
}

export interface ExecutionResult {
  perplexityResult?: { content: string; sources?: string[] };
  deepThinking?: string;
  libraryDocs?: string;
  arxivPapers?: ArxivResult;
  subQuestionResults?: Array<{ question: string; perplexityResult?: { content: string }; deepThinking?: string }>;
}

export async function executeResearchPlan(ctx: ExecutionContext): Promise<ExecutionResult> {
  const result: ExecutionResult = {};
  const { query, enrichedContext, actionPlan, palClient, context7Client, options } = ctx;

  // Determine which tools to run based on plan and depth level
  const shouldRunPerplexity = actionPlan.steps.some(s => s.includes('perplexity') || s.includes('web'));
  const shouldRunDeepThinking = actionPlan.steps.some(s => s.includes('deep') || s.includes('pal') || s.includes('thinking'));
  const shouldRunArxiv = (ctx.depth >= 3 || actionPlan.steps.some(s => s.includes('arxiv') || s.includes('papers'))) && !actionPlan.toolsToSkip?.includes('arxiv_search');
  const shouldRunContext7 = actionPlan.steps.some(s => s.includes('context7') || s.includes('library') || s.includes('docs'));

  // PHASE 1: Run all data gathering in parallel
  console.error('[Exec] Phase 1: Gathering data in parallel...');
  const gatheringTasks: Promise<void>[] = [];

  if (shouldRunPerplexity) {
    gatheringTasks.push((async () => {
      console.error('[Exec] → Perplexity search...');
      result.perplexityResult = await perplexitySearch(withContext(query, enrichedContext));
    })());
  }

  if (shouldRunArxiv) {
    gatheringTasks.push((async () => {
      console.error('[Exec] → arXiv search...');
      const arxivResult = await arxivSearch(query, 5);
      result.arxivPapers = arxivResult;
      // Summarize papers in parallel (don't wait for other tasks)
      if (arxivResult.papers.length > 0 && palClient) {
        result.arxivPapers = { ...arxivResult, papers: await summarizePapers(palClient, arxivResult.papers) };
      }
    })());
  }

  if (shouldRunContext7 && options?.techStack?.length && context7Client) {
    gatheringTasks.push((async () => {
      console.error('[Exec] → Library docs...');
      const docs = await Promise.all(options.techStack!.map(lib => searchLibraryDocs(context7Client, lib, query)));
      result.libraryDocs = docs.filter(Boolean).join('\n\n---\n\n');
    })());
  }

  // Sub-questions run in parallel with main query
  if (options?.subQuestions?.length) {
    gatheringTasks.push((async () => {
      console.error(`[Exec] → ${options.subQuestions!.length} sub-questions...`);
      result.subQuestionResults = await Promise.all(
        options.subQuestions!.map(async (sq) => {
          const sub: any = { question: sq };
          sub.perplexityResult = await perplexitySearch(withContext(sq, enrichedContext));
          return sub;
        })
      );
    })());
  }

  // Wait for all gathering tasks
  await Promise.all(gatheringTasks);

  // PHASE 2: Deep analysis (needs perplexity results for best quality)
  if (shouldRunDeepThinking && palClient) {
    console.error('[Exec] Phase 2: Deep analysis...');
    result.deepThinking = await palChat(
      palClient,
      buildDeepAnalysisPrompt(query, enrichedContext, result.perplexityResult?.content),
      'gemini-2.5-flash'
    );
  }

  return result;
}

async function summarizePapers(palClient: Client, papers: ArxivPaper[]): Promise<ArxivPaper[]> {
  return Promise.all(papers.map(async (p) => {
    try {
      // Use fast model for simple summarization to avoid timeouts
      const rawSummary = await palChat(palClient, `Summarize in <300 chars: ${p.title}\n${p.summary}`, 'gemini-2.5-flash');
      // Extract content from JSON wrapper if present
      const summary = extractContent(rawSummary);
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
