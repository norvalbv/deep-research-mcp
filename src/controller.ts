/**
 * Research Controller - Orchestrates the research flow per README
 * Flow: Planning → Execute → SYNTHESIZE → Challenge (vs input) → Vote (synthesis vs critique) → [Re-synth if needed] → Output
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { searchLibraryDocs } from './clients/context7.js';
import { createArxivClient, ArxivClient } from './clients/arxiv.js';
import { arxivSearch } from './services/arxiv.js';
import { ComplexityLevel } from './types/index.js';
import { createFallbackPlan, generateConsensusPlan, ResearchActionPlan } from './planning.js';
import { executeResearchPlan } from './execution.js';
import { synthesizeFindings } from './synthesis.js';
import { runChallenge, runConsensusValidation, runSufficiencyVote, ChallengeResult, SufficiencyVote } from './validation.js';
import { formatMarkdown, ResearchResult } from './formatting.js';

export interface ResearchOptions {
  subQuestions?: string[];
  constraints?: string[];
  includeCodeExamples?: boolean;
  techStack?: string[];
  papersRead?: string[];
  outputFormat?: 'summary' | 'detailed' | 'actionable_steps';
}

interface Context7Wrapper { client: Client; close: () => Promise<void>; }

export class ResearchController {
  private context7Client: Context7Wrapper | null = null;
  private arxivClient: ArxivClient | null = null;
  private isInitialized = false;
  private env: Record<string, string> = {};

  constructor(env?: Record<string, string>) {
    this.env = env || {};
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    console.error('[Research] Initializing...');
    this.isInitialized = true;
  }

  async execute({ query, enrichedContext, depthLevel, options }: { query: string; enrichedContext: string; depthLevel: ComplexityLevel; options?: ResearchOptions }): Promise<{ markdown: string; result: ResearchResult }> {
    if (!this.isInitialized) await this.initialize();

    // Step 1: Consensus Planning
    const actionPlan = await this.getActionPlan(query, enrichedContext, depthLevel, options);
    const complexity = (depthLevel || actionPlan.complexity) as ComplexityLevel;
    console.error(`[Research] Plan: ${complexity}/5, ${actionPlan.steps.join(', ')}`);

    // Step 2: Dynamic Execution (gather data)
    const execution = await executeResearchPlan({
      query, enrichedContext, depth: complexity, actionPlan,
      context7Client: this.context7Client?.client || null,
      options,
      env: this.env,
    });

    // Step 3: Synthesize findings into unified answer
    let synthesis = await synthesizeFindings(
      this.env.GEMINI_API_KEY,
      query,
      enrichedContext,
      execution,
      options
    );

    // Step 4: Run challenge + consensus in PARALLEL to save time
    console.error('[Research] Running challenge + consensus in parallel...');
    const challengeContext = {
      enrichedContext,
      constraints: options?.constraints,
      subQuestions: options?.subQuestions,
    };
    
    // Only run consensus for depth >= 4
    const [challenge, consensus] = await Promise.all([
      runChallenge(this.env.GEMINI_API_KEY, query, synthesis, challengeContext),
      complexity >= 4 
        ? runConsensusValidation(this.env.GEMINI_API_KEY, query, execution) 
        : Promise.resolve(undefined),
    ]);

    // Step 5: Sufficiency Vote - synthesis vs critique
    // Early exit: if no significant gaps found, skip voting entirely
    let sufficiency: SufficiencyVote | undefined;
    let improved = false;
    
    if (challenge?.hasSignificantGaps) {
      console.error('[Research] Running sufficiency vote (synthesis vs critique)...');
      sufficiency = await runSufficiencyVote(this.env.GEMINI_API_KEY, query, synthesis, challenge);

      // Step 6: Re-synthesis if critique wins (max 1 iteration)
      if (sufficiency && !sufficiency.sufficient && sufficiency.criticalGaps.length > 0) {
        console.error('[Research] Critique wins - re-synthesizing with gaps...');
        improved = true;
        
        // Gather additional data for critical gaps
        await this.gatherDataForGaps(execution, sufficiency.criticalGaps, query);
        
        // Re-synthesize with gap awareness
        synthesis = await this.resynthesizeWithGaps(
          query, enrichedContext, execution, options, sufficiency.criticalGaps
        );
        
        // Final challenge (no more iterations)
        const finalChallenge = await runChallenge(this.env.GEMINI_API_KEY, query, synthesis, challengeContext);
        
        if (finalChallenge?.hasSignificantGaps) {
          sufficiency = await runSufficiencyVote(this.env.GEMINI_API_KEY, query, synthesis, finalChallenge);
        } else {
          // No gaps after re-synthesis, synthesis wins
          sufficiency = {
            sufficient: true,
            votesFor: 1,
            votesAgainst: 0,
            criticalGaps: [],
            details: [{ model: 'default', vote: 'synthesis_wins', reasoning: 'No gaps after re-synthesis' }],
          };
        }
      }
    } else {
      console.error('[Research] No significant gaps - skipping vote');
      sufficiency = {
        sufficient: true,
        votesFor: 1,
        votesAgainst: 0,
        criticalGaps: [],
        details: [{ model: 'default', vote: 'synthesis_wins', reasoning: 'Challenge found no significant gaps' }],
      };
    }

    // Build result
    const result: ResearchResult = {
      query, complexity, complexityReasoning: actionPlan.reasoning,
      actionPlan, execution, synthesis, consensus, challenge, sufficiency, improved,
    };

    return { markdown: formatMarkdown(result), result };
  }

  /**
   * Re-synthesize with explicit gap awareness
   */
  private async resynthesizeWithGaps(
    query: string,
    enrichedContext: string | undefined,
    execution: any,
    options: ResearchOptions | undefined,
    gaps: string[]
  ): Promise<string> {
    const gapContext = `\n\nCRITICAL GAPS TO ADDRESS:\n${gaps.map((g, i) => `${i + 1}. ${g}`).join('\n')}\n\nYou MUST address these gaps in your synthesis.`;
    
    return synthesizeFindings(
      this.env.GEMINI_API_KEY,
      query,
      (enrichedContext || '') + gapContext,
      execution,
      options
    );
  }

  /**
   * Gather additional data to fill critical gaps
   */
  private async gatherDataForGaps(
    execution: any,
    gaps: string[],
    query: string
  ): Promise<void> {
    // Analyze gaps to determine what data to fetch
    const gapText = gaps.join(' ').toLowerCase();
    
    // If gaps mention papers/research/academic, fetch more papers
    if ((gapText.includes('paper') || gapText.includes('research') || gapText.includes('academic')) && !execution.arxivPapers) {
      console.error('[Research] Fetching papers for gap...');
      execution.arxivPapers = await arxivSearch(query, 5);
    }
    
    // If gaps mention code/implementation/example, fetch library docs
    if ((gapText.includes('code') || gapText.includes('implementation') || gapText.includes('example')) && !execution.libraryDocs && this.context7Client) {
      console.error('[Research] Fetching library docs for gap...');
      execution.libraryDocs = await searchLibraryDocs(this.context7Client.client, 'general', query);
    }
  }

  private async getActionPlan(query: string, ctx?: string, depth?: ComplexityLevel, opts?: ResearchOptions): Promise<ResearchActionPlan> {
    if (this.env.GEMINI_API_KEY) {
      return generateConsensusPlan(this.env.GEMINI_API_KEY, query, ctx, {
        constraints: opts?.constraints, papersRead: opts?.papersRead,
        techStack: opts?.techStack, subQuestions: opts?.subQuestions,
      }, this.env);
    }
    // Fallback
    return createFallbackPlan({
      techStack: opts?.techStack,
      subQuestions: opts?.subQuestions,
    });
  }

  async getArxivClient(): Promise<ArxivClient> {
    if (!this.arxivClient) {
      this.arxivClient = await createArxivClient(this.env.ARXIV_STORAGE_PATH);
    }
    return this.arxivClient;
  }

  async cleanup(): Promise<void> {
    if (this.context7Client) await this.context7Client.close();
    if (this.arxivClient) await this.arxivClient.close();
    this.isInitialized = false;
  }
}

