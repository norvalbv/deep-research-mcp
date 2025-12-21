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
import { synthesizeFindings, SynthesisOutput, extractGlobalManifest, formatManifestForPrompt } from './synthesis.js';
import { runChallenge, runConsensusValidation, runSufficiencyVote, validateCodeAgainstDocs, runPVRVerification, getPVRConfig, ChallengeResult, SufficiencyVote } from './validation.js';
import { GlobalManifest, PVRVerificationResult } from './types/index.js';
import { formatMarkdown, ResearchResult, resolveCitations } from './formatting.js';
import { buildValidationContent } from './validation-content.js';
import { generateSectionSummaries } from './sectioning.js';
import { compressText } from './clients/llm.js';

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
    console.error(`[Research] Plan: ${complexity}/4, ${actionPlan.steps.join(', ')}`);

    // Step 2: Dynamic Execution (gather data)
    const execution = await executeResearchPlan({
      query, enrichedContext, depth: complexity, actionPlan,
      context7Client: this.context7Client?.client || null,
      options,
      env: this.env,
    });

    // Step 2.5: Extract Global Constraint Manifest from sources
    // This ensures all synthesis calls share consistent facts (arxiv:2310.03025)
    console.error('[Research] Extracting global constraint manifest from sources...');
    const manifest = await extractGlobalManifest(execution, this.env.GEMINI_API_KEY);
    
    // Store manifest in execution for prompt injection
    const manifestContext = formatManifestForPrompt(manifest);
    const enrichedWithManifest = manifestContext 
      ? `${enrichedContext || ''}\n\n${manifestContext}`
      : enrichedContext;

    // Step 3: Synthesize findings into unified answer
    // Automatically uses phased synthesis if sub-questions exist (token-efficient)
    let synthesisOutput = await synthesizeFindings(
      this.env.GEMINI_API_KEY,
      query,
      enrichedWithManifest,
      execution,
      { ...options, depth: complexity }  // Pass depth to gate code examples
    );

    // Step 3.5: PVR Verification - Check consistency across sections
    let pvrResult: PVRVerificationResult | undefined;
    if (options?.subQuestions?.length) {
      console.error('[Research] Running PVR verification...');
      pvrResult = await runPVRVerification(synthesisOutput, manifest, this.env.GEMINI_API_KEY);
      
      // Speculative re-rolling: Only re-synthesize contradicting sections
      if (!pvrResult.isConsistent && pvrResult.sectionsToReroll.length > 0) {
        console.error(`[Research] Re-rolling ${pvrResult.sectionsToReroll.length} contradicting sections...`);
        synthesisOutput = await this.rerollContradictingSections(
          synthesisOutput,
          pvrResult,
          manifest,
          query,
          enrichedWithManifest,
          execution,
          options
        );
        
        // Re-verify after re-roll (max 1 iteration)
        const reVerify = await runPVRVerification(synthesisOutput, manifest, this.env.GEMINI_API_KEY);
        console.error(`[Research] Post-reroll PVR score: ${reVerify.entailmentScore.toFixed(2)}`);
        pvrResult = reVerify;
      }
    }

    // Step 3.6: Code validation pass (if Context7 docs available)
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
      // Include valid sources so challenger knows which citations are legitimate
      validSources: {
        arxivPapers: execution.arxivPapers?.papers?.map(p => ({ id: p.id, title: p.title })),
        perplexitySources: execution.perplexityResult?.sources,
      },
    };
    
    // Convert structured output to text for challenge/consensus
    const synthesisText = this.synthesisOutputToText(synthesisOutput);
    
    // Gate validation by depth level:
    // - Challenge: depth >= 2
    // - Consensus: depth >= 4
    // - Voting: depth >= 3
    const shouldRunChallenge = complexity >= 2;
    const shouldRunVoting = complexity >= 3;
    
    console.error(`[Research] Validation gates: challenge=${shouldRunChallenge}, voting=${shouldRunVoting}, consensus=${complexity >= 4}`);
    
    const [challenge, consensus] = await Promise.all([
      shouldRunChallenge 
        ? runChallenge(this.env.GEMINI_API_KEY, query, synthesisText, challengeContext)
        : Promise.resolve(undefined),
      complexity >= 4 
        ? runConsensusValidation(this.env.GEMINI_API_KEY, query, execution) 
        : Promise.resolve(undefined),
    ]);

    // Step 5: Sufficiency Vote - synthesis vs critique
    // Early exit: if no significant gaps found, skip voting entirely
    // Only run at depth >= 3
    let sufficiency: SufficiencyVote | undefined;
    let improved = false;
    
    if (shouldRunVoting && challenge?.hasSignificantGaps) {
      console.error('[Research] Running sufficiency vote (synthesis vs critique)...');
      sufficiency = await runSufficiencyVote(
        this.env.GEMINI_API_KEY, 
        query, 
        synthesisText, 
        challenge, 
        this.env,
        manifest.keyFacts,
        challengeContext.validSources
      );

      // Step 6: Re-synthesis if critique wins (max 1 iteration)
      if (sufficiency && !sufficiency.sufficient && sufficiency.criticalGaps.length > 0) {
        console.error('[Research] Critique wins - re-synthesizing with gaps...');
        improved = true;
        
        // Gather additional data for critical gaps
        await this.gatherDataForGaps(execution, sufficiency.criticalGaps, query);
        
        // Re-synthesize with gap awareness
        synthesisOutput = await this.resynthesizeWithGaps(
          query, enrichedContext, execution, options, sufficiency.criticalGaps, complexity
        );
        
        const newSynthesisText = this.synthesisOutputToText(synthesisOutput);
        
        // Final challenge (no more iterations)
        const finalChallenge = await runChallenge(this.env.GEMINI_API_KEY, query, newSynthesisText, challengeContext);
        
        if (finalChallenge?.hasSignificantGaps) {
          sufficiency = await runSufficiencyVote(
            this.env.GEMINI_API_KEY, 
            query, 
            newSynthesisText, 
            finalChallenge, 
            this.env,
            manifest.keyFacts,
            challengeContext.validSources
          );
        } else {
          // No gaps after re-synthesis, synthesis wins
          sufficiency = {
            sufficient: true,
            votesFor: 1,
            votesAgainst: 0,
            criticalGaps: [],
            details: [{ model: 'default', vote: 'synthesis_wins', reasoning: 'No gaps after re-synthesis', critiques: [] }],
            stylisticPreferences: [],
            hasCriticalGap: false,
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
        details: [{ model: 'default', vote: 'synthesis_wins', reasoning: 'Challenge found no significant gaps', critiques: [] }],
        stylisticPreferences: [],
        hasCriticalGap: false,
      };
    }

    // Build sections from structured synthesis output + validation data
    console.error('[Research] Building sections from structured output...');
    const sections = this.buildSectionsFromResult(
      synthesisOutput, 
      { challenge, consensus, sufficiency, improved },
      execution,  // Pass execution for arxiv papers
      complexity  // Pass complexity to gate validation section
    );
    
    // Generate summaries for each section
    await generateSectionSummaries(sections, this.env.GEMINI_API_KEY);

    // Build result (keep synthesisText for markdown rendering + add arxiv to execution)
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
      keyRecommendation: await this.extractKeyRecommendation(synthesisOutput.overview, this.env.GEMINI_API_KEY),
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
   * Resolves [perplexity:N] citations to actual URLs
   */
  private buildSectionsFromResult(
    output: SynthesisOutput,
    validation: {
      challenge?: ChallengeResult;
      consensus?: string;
      sufficiency?: SufficiencyVote;
      improved?: boolean;
    },
    execution: { 
      arxivPapers?: { papers: Array<{ id: string; title: string; summary: string; url: string }> };
      perplexityResult?: { sources?: string[] };
    },
    complexity?: ComplexityLevel
  ): Record<string, Section> {
    const sections: Record<string, Section> = {};
    
    // Helper to resolve citations in content
    const resolve = (text: string) => resolveCitations(text, execution as any);
    
    // Overview section - resolve citations
    sections.overview = {
      title: 'Overview',
      content: resolve(output.overview),
      summary: '', // Will be filled by generateSectionSummaries
    };
    
    // Sub-question sections - resolve citations
    if (output.subQuestions) {
      for (const [key, value] of Object.entries(output.subQuestions)) {
        sections[key] = {
          title: value.question,
          content: resolve(value.answer),
          summary: '', // Will be filled by generateSectionSummaries
        };
      }
    }
    
    // Additional insights section (if present) - resolve citations
    if (output.additionalInsights && output.additionalInsights.trim()) {
      sections.additional_insights = {
        title: 'Additional Insights',
        content: resolve(output.additionalInsights),
        summary: '',
      };
    }
    
    // Academic Papers section (if present)
    if (execution?.arxivPapers?.papers && execution.arxivPapers.papers.length > 0) {
      const arxivContent = execution.arxivPapers.papers
        .map((paper, i) => `**${i + 1}. ${paper.title}**\n- arXiv ID: ${paper.id}\n- Summary: ${paper.summary}\n- URL: ${paper.url}`)
        .join('\n\n');
      
      sections.arxiv_papers = {
        title: 'Academic Papers',
        content: arxivContent + '\n\n*Use `read_paper` or `download_paper` tools for full paper content.*',
        summary: `${execution.arxivPapers.papers.length} academic papers found and summarized`,
      };
    }
    
    // Validation section - uses shared utility (consistent with formatting.ts)
    const validationContent = buildValidationContent(
      { challenge: validation.challenge, sufficiency: validation.sufficiency, improved: validation.improved },
      complexity ?? 3,
      { includeConsensus: false }  // Consensus handled separately below
    );
    if (validationContent) {
      sections.validation = {
        title: 'Validation',
        content: validationContent,
        summary: '',
      };
    }
    
    // Consensus section (if present, as separate section for read_report access)
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
   * Extract key recommendation using LLM-based summarization (~50 words / ~200 chars)
   */
  private async extractKeyRecommendation(synthesis: string, apiKey?: string): Promise<string> {
    if (!apiKey || synthesis.length < 200) {
      // Fallback: return as-is if short or no API key
      return synthesis.length > 200 
        ? synthesis.slice(0, 200).trim() + '...' 
        : synthesis;
    }
    
    // LLM-based summarization (~50 words = ~200 chars)
    return await compressText(synthesis, 50, apiKey);
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
    gaps: string[],
    depth: number
  ): Promise<SynthesisOutput> {
    const gapContext = `\n\nCRITICAL GAPS TO ADDRESS:\n${gaps.map((g, i) => `${i + 1}. ${g}`).join('\n')}\n\nYou MUST address these gaps in your synthesis.`;
    
    return synthesizeFindings(
      this.env.GEMINI_API_KEY,
      query,
      (enrichedContext || '') + gapContext,
      execution,
      { ...options, depth }
    );
  }

  /**
   * Speculative re-rolling: Only re-synthesize sections that contain contradictions
   * Based on arxiv:2310.03025 (PVR architecture)
   * 
   * Uses overview as "anchor" section - keeps it stable, re-rolls sub-questions
   */
  private async rerollContradictingSections(
    synthesis: SynthesisOutput,
    pvrResult: PVRVerificationResult,
    manifest: GlobalManifest,
    query: string,
    enrichedContext: string | undefined,
    execution: any,
    options: ResearchOptions | undefined
  ): Promise<SynthesisOutput> {
    // Keep overview as anchor (source of truth)
    const result: SynthesisOutput = {
      overview: synthesis.overview,
      subQuestions: { ...synthesis.subQuestions },
      additionalInsights: synthesis.additionalInsights,
    };

    // Build contradiction context for re-rolling
    const contradictionContext = pvrResult.contradictions
      .filter(c => c.severity === 'high')
      .map(c => `Contradiction: "${c.claimA}" vs "${c.claimB}"`)
      .join('\n');

    // Re-roll only the contradicting sub-questions
    for (const sectionId of pvrResult.sectionsToReroll) {
      if (!result.subQuestions?.[sectionId]) continue;

      const subQ = result.subQuestions[sectionId];
      const subQIndex = parseInt(sectionId.replace('q', ''), 10) - 1;
      const subQData = execution.subQuestionResults?.[subQIndex];

      console.error(`[Research] Re-rolling section ${sectionId}: ${subQ.question.slice(0, 50)}...`);

      // Build re-roll prompt with anchor context
      const rerollPrompt = this.buildRerollPrompt(
        subQ.question,
        synthesis.overview,
        manifest,
        contradictionContext,
        subQData
      );

      try {
        const { callLLM } = await import('./clients/llm.js');
        const response = await callLLM(rerollPrompt, {
          provider: 'gemini',
          model: 'gemini-2.5-flash-lite',
          apiKey: this.env.GEMINI_API_KEY,
          timeout: 30000,
          maxOutputTokens: 4000,
          temperature: 0.2,
        });

        result.subQuestions[sectionId] = {
          question: subQ.question,
          answer: response.content.trim(),
        };
      } catch (error) {
        console.error(`[Research] Failed to re-roll ${sectionId}:`, error);
        // Keep original on failure
      }
    }

    return result;
  }

  /**
   * Build prompt for speculative re-rolling
   * Forces alignment with overview (anchor section)
   */
  private buildRerollPrompt(
    question: string,
    overviewAnchor: string,
    manifest: GlobalManifest,
    contradictionContext: string,
    subQData?: any
  ): string {
    const manifestSection = manifest.keyFacts.length > 0
      ? `\nGLOBAL FACTS (use these EXACT values):\n${manifest.keyFacts.map(f => `- ${f}`).join('\n')}\n`
      : '';

    const dataSection = subQData?.perplexityResult?.content
      ? `\nResearch Data:\n${subQData.perplexityResult.content.slice(0, 1500)}\n`
      : '';

    return `You are re-synthesizing a section that CONTRADICTED the main overview.

SUB-QUESTION: ${question}

ANCHOR (main overview - this is the source of truth):
${overviewAnchor.slice(0, 2000)}

${manifestSection}

DETECTED CONTRADICTIONS (you must RESOLVE these):
${contradictionContext}

${dataSection}

YOUR TASK:
Re-write the answer to this sub-question so that it:
1. ALIGNS with the anchor overview above
2. Uses the EXACT numeric values from Global Facts
3. Does NOT contradict the main findings
4. Provides a thorough answer with citations

Write the answer directly, no preamble.`;
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
      execution.arxivPapers = await arxivSearch(query, 5, 3, this.env.GEMINI_API_KEY);
    }
    
    // If gaps mention code/implementation/example, fetch library docs
    if ((gapText.includes('code') || gapText.includes('implementation') || gapText.includes('example')) && !execution.libraryDocs && this.context7Client) {
      console.error('[Research] Fetching library docs for gap...');
      execution.libraryDocs = await searchLibraryDocs(this.context7Client.client, 'general', query);
    }
  }

  /**
   * Public method for external callers (e.g., job-orchestrator) to get action plan
   */
  async plan(query: string, ctx?: string, depth?: ComplexityLevel, opts?: ResearchOptions): Promise<ResearchActionPlan> {
    return this.getActionPlan(query, ctx, depth, opts);
  }

  private async getActionPlan(query: string, ctx?: string, depth?: ComplexityLevel, opts?: ResearchOptions): Promise<ResearchActionPlan> {
    if (this.env.GEMINI_API_KEY) {
      return generateConsensusPlan(this.env.GEMINI_API_KEY, query, ctx, {
        constraints: opts?.constraints, papersRead: opts?.papersRead,
        techStack: opts?.techStack, subQuestions: opts?.subQuestions,
        maxDepth: depth,  // Pass user's requested depth as cap
      }, this.env);
    }
    // Fallback
    return createFallbackPlan({
      techStack: opts?.techStack,
      subQuestions: opts?.subQuestions,
      maxDepth: depth,
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

