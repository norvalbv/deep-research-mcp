/**
 * Research Controller - Orchestrates the research flow per README
 * Flow: Planning → Execute → SYNTHESIZE → Challenge (vs input) → Vote (synthesis vs critique) → [Re-synth if needed] → Output
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { searchLibraryDocs } from './clients/context7.js';
import { createArxivClient, ArxivClient } from './clients/arxiv.js';
import { arxivSearch } from './services/arxiv.js';
import { ComplexityLevel, Section, ExecutiveSummary } from './types/index.js';
import { createFallbackPlan, generateConsensusPlan, ResearchActionPlan } from './planning.js';
import { executeResearchPlan } from './execution.js';
import { synthesizeFindings, SynthesisOutput } from './synthesis.js';
import { runChallenge, runConsensusValidation, runSufficiencyVote, validateCodeAgainstDocs, ChallengeResult, SufficiencyVote } from './validation.js';
import { formatMarkdown, ResearchResult } from './formatting.js';
import { generateSectionSummaries } from './sectioning.js';

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

  getEnv(): Record<string, string> {
    return this.env;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    console.error('[Research] Initializing...');
    this.isInitialized = true;
  }

  async execute({ query, enrichedContext, depthLevel, options }: { query: string; enrichedContext: string; depthLevel: ComplexityLevel; options?: ResearchOptions }): Promise<{ 
    markdown: string; 
    result: ResearchResult;
    sections: Record<string, Section>;
    executiveSummary: ExecutiveSummary;
  }> {
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
    // Automatically uses phased synthesis if sub-questions exist (token-efficient)
    let synthesisOutput = await synthesizeFindings(
      this.env.GEMINI_API_KEY,
      query,
      enrichedContext,
      execution,
      options
    );

    // Step 3.5: Code validation pass (if Context7 docs available)
    if (execution.docCache && Object.keys(execution.docCache.base).length > 0) {
      synthesisOutput = await validateCodeAgainstDocs(
        this.env.GEMINI_API_KEY,
        synthesisOutput,
        execution.docCache
      );
    }

    // Step 4: Run challenge + consensus in PARALLEL to save time
    console.error('[Research] Running challenge + consensus in parallel...');
    const challengeContext = {
      enrichedContext,
      constraints: options?.constraints,
      subQuestions: options?.subQuestions,
    };
    
    // Convert structured output to text for challenge/consensus
    const synthesisText = this.synthesisOutputToText(synthesisOutput);
    
    // Only run consensus for depth >= 4
    const [challenge, consensus] = await Promise.all([
      runChallenge(this.env.GEMINI_API_KEY, query, synthesisText, challengeContext),
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
      sufficiency = await runSufficiencyVote(this.env.GEMINI_API_KEY, query, synthesisText, challenge);

      // Step 6: Re-synthesis if critique wins (max 1 iteration)
      if (sufficiency && !sufficiency.sufficient && sufficiency.criticalGaps.length > 0) {
        console.error('[Research] Critique wins - re-synthesizing with gaps...');
        improved = true;
        
        // Gather additional data for critical gaps
        await this.gatherDataForGaps(execution, sufficiency.criticalGaps, query);
        
        // Re-synthesize with gap awareness
        synthesisOutput = await this.resynthesizeWithGaps(
          query, enrichedContext, execution, options, sufficiency.criticalGaps
        );
        
        const newSynthesisText = this.synthesisOutputToText(synthesisOutput);
        
        // Final challenge (no more iterations)
        const finalChallenge = await runChallenge(this.env.GEMINI_API_KEY, query, newSynthesisText, challengeContext);
        
        if (finalChallenge?.hasSignificantGaps) {
          sufficiency = await runSufficiencyVote(this.env.GEMINI_API_KEY, query, newSynthesisText, finalChallenge);
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

    // Build sections from structured synthesis output + validation data
    console.error('[Research] Building sections from structured output...');
    const sections = this.buildSectionsFromResult(synthesisOutput, { challenge, consensus, sufficiency, improved });
    
    // Generate summaries for each section
    await generateSectionSummaries(sections, this.env.GEMINI_API_KEY);

    // Build result (keep synthesisText for markdown rendering)
    const result: ResearchResult = {
      query, complexity, complexityReasoning: actionPlan.reasoning,
      actionPlan, execution, synthesis: synthesisOutput, consensus, challenge, sufficiency, improved,
    };

    // Format markdown from structured data
    console.error('[Research] Rendering markdown from structured sections...');
    const markdown = formatMarkdown(result);
    
    // Build executive summary
    const executiveSummary: ExecutiveSummary = {
      queryAnswered: sufficiency?.sufficient ?? true,
      confidence: this.determineConfidence(complexity, sufficiency),
      keyRecommendation: this.extractKeyRecommendation(synthesisOutput.overview),
      budgetFeasibility: this.extractBudgetFeasibility(enrichedContext, synthesisOutput.overview),
      availableSections: Object.keys(sections),
    };

    return { markdown, result, sections, executiveSummary };
  }

  /**
   * Convert structured synthesis output to plain text for challenge/validation
   */
  private synthesisOutputToText(output: SynthesisOutput): string {
    const parts: string[] = [];
    
    // Overview
    parts.push('## Overview\n');
    parts.push(output.overview);
    parts.push('');
    
    // Sub-questions
    if (output.subQuestions) {
      for (const [key, value] of Object.entries(output.subQuestions)) {
        parts.push(`## ${value.question}\n`);
        parts.push(value.answer);
        parts.push('');
      }
    }
    
    // Additional insights
    if (output.additionalInsights) {
      parts.push('## Additional Insights\n');
      parts.push(output.additionalInsights);
      parts.push('');
    }
    
    return parts.join('\n');
  }

  /**
   * Build Section objects from structured synthesis output + validation data
   */
  private buildSectionsFromResult(
    output: SynthesisOutput,
    validation: {
      challenge?: ChallengeResult;
      consensus?: string;
      sufficiency?: SufficiencyVote;
      improved?: boolean;
    }
  ): Record<string, Section> {
    const sections: Record<string, Section> = {};
    
    // Overview section
    sections.overview = {
      title: 'Overview',
      content: output.overview,
      summary: '', // Will be filled by generateSectionSummaries
    };
    
    // Sub-question sections
    if (output.subQuestions) {
      for (const [key, value] of Object.entries(output.subQuestions)) {
        sections[key] = {
          title: value.question,
          content: value.answer,
          summary: '', // Will be filled by generateSectionSummaries
        };
      }
    }
    
    // Additional insights section (if present)
    if (output.additionalInsights && output.additionalInsights.trim()) {
      sections.additional_insights = {
        title: 'Additional Insights',
        content: output.additionalInsights,
        summary: '',
      };
    }
    
    // Validation section - combines challenge + sufficiency
    if (validation.challenge || validation.sufficiency) {
      const validationParts: string[] = [];
      
      // Critical Challenge
      if (validation.challenge) {
        validationParts.push('### Critical Challenge\n');
        if (validation.challenge.hasSignificantGaps && validation.challenge.critiques.length > 0) {
          validation.challenge.critiques.forEach((critique, i) => {
            validationParts.push(`${i + 1}. ${critique}`);
          });
        } else {
          validationParts.push('No significant gaps found in the synthesis.');
        }
        validationParts.push('');
      }
      
      // Quality Vote
      if (validation.sufficiency) {
        validationParts.push('### Quality Vote\n');
        validationParts.push(`**Result**: ${validation.sufficiency.votesFor} synthesis_wins, ${validation.sufficiency.votesAgainst} critique_wins`);
        
        if (validation.improved) {
          validationParts.push('**Status**: ⚠️ Synthesis improved after critique identified gaps\n');
        } else if (validation.sufficiency.sufficient) {
          validationParts.push('**Status**: ✅ Synthesis validated (addresses the query adequately)\n');
        } else {
          validationParts.push('**Status**: ⚠️ Critique identified gaps (see below)\n');
        }
        
        if (validation.sufficiency.criticalGaps && validation.sufficiency.criticalGaps.length > 0) {
          validationParts.push('**Critical Gaps Identified**:');
          validation.sufficiency.criticalGaps.forEach((gap) => {
            validationParts.push(`- ${gap}`);
          });
          validationParts.push('');
        }
        
        validationParts.push('**Model Reasoning**:');
        validation.sufficiency.details.forEach((vote) => {
          const status = vote.vote === 'synthesis_wins' ? '✅' : '❌';
          validationParts.push(`- ${status} **${vote.model}**: ${vote.reasoning}`);
        });
      }
      
      sections.validation = {
        title: 'Validation',
        content: validationParts.join('\n'),
        summary: '',
      };
    }
    
    // Consensus section (if present)
    if (validation.consensus) {
      sections.consensus = {
        title: 'Multi-Model Consensus',
        content: validation.consensus,
        summary: '',
      };
    }
    
    return sections;
  }

  /**
   * Determine confidence level based on complexity and validation
   */
  private determineConfidence(
    complexity: ComplexityLevel,
    sufficiency?: SufficiencyVote
  ): 'high' | 'medium' | 'low' {
    if (sufficiency && !sufficiency.sufficient) return 'low';
    if (complexity >= 4 && (sufficiency?.votesFor ?? 0) >= 2) return 'high';
    if (complexity >= 3) return 'medium';
    return 'medium';
  }

  /**
   * Extract key recommendation (first 1-2 sentences from synthesis)
   */
  private extractKeyRecommendation(synthesis: string): string {
    const sentences = synthesis
      .split(/[.!?]+/)
      .map(s => s.trim())
      .filter(s => s.length > 20);
    
    if (sentences.length === 0) return 'See full report for recommendations.';
    
    const recommendation = sentences.slice(0, 2).join('. ') + '.';
    return recommendation.length > 200 
      ? recommendation.substring(0, 197) + '...'
      : recommendation;
  }

  /**
   * Extract budget feasibility from context or synthesis
   */
  private extractBudgetFeasibility(
    enrichedContext: string | undefined,
    synthesis: string
  ): string | undefined {
    // Check if context mentions budget/time constraints
    if (!enrichedContext) return undefined;
    
    const contextLower = enrichedContext.toLowerCase();
    if (contextLower.includes('hours') || contextLower.includes('budget') || contextLower.includes('time')) {
      // Try to extract budget mention from synthesis
      const synthesisLower = synthesis.toLowerCase();
      if (synthesisLower.includes('realistic') || synthesisLower.includes('feasible')) {
        return 'Realistic based on constraints';
      }
      if (synthesisLower.includes('challenging') || synthesisLower.includes('ambitious')) {
        return 'Challenging but achievable';
      }
    }
    
    return undefined;
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
  ): Promise<SynthesisOutput> {
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

