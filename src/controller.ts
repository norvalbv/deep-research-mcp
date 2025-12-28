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
import { runChallenge, runSectionChallenge, runConsensusValidation, runSufficiencyVote, validateCodeAgainstDocs, runPVRVerification, getPVRConfig, ChallengeResult, SufficiencyVote, CategorizedCritique } from './validation.js';
import { GlobalManifest, PVRVerificationResult } from './types/index.js';
import { formatMarkdown, ResearchResult, resolveCitations } from './formatting.js';
import { buildValidationContent } from './validation-content.js';
import { generateSectionSummaries } from './sectioning.js';
import { compressText } from './clients/llm.js';
import { ProgressInfo } from './jobs.js';

// Progress callback type for real-time step updates
export type OnProgressCallback = (progress: ProgressInfo) => void;

export interface ResearchOptions {
  subQuestions?: string[];
  constraints?: string[];
  includeCodeExamples?: boolean;
  techStack?: string[];
  papersRead?: string[];
  outputFormat?: 'summary' | 'detailed' | 'actionable_steps' | 'direct';
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

  async execute({ query, enrichedContext, depthLevel, options, onProgress }: { 
    query: string; 
    enrichedContext: string; 
    depthLevel?: ComplexityLevel; 
    options?: ResearchOptions;
    onProgress?: OnProgressCallback;
  }): Promise<{ 
    markdown: string; 
    result: ResearchResult;
    sections: Record<string, Section>;
    executiveSummary: ExecutiveSummary;
  }> {
    if (!this.isInitialized) await this.initialize();

    // Progress tracking: base steps = 8, can extend to 10 if re-synthesis needed
    let totalSteps = 8;
    let currentStep = 1;
    const emitProgress = (step: string, estSecondsRemaining: number, note?: string) => {
      if (onProgress) {
        onProgress({
          currentStep: step,
          stepNumber: currentStep,
          totalSteps,
          estimatedSecondsRemaining: estSecondsRemaining,
          note,
        });
      }
    };

    // Step 1: Consensus Planning
    emitProgress('Planning', 85);
    const actionPlan = await this.getActionPlan(query, enrichedContext, depthLevel, options);
    const complexity = (depthLevel || actionPlan.complexity) as ComplexityLevel;
    
    // Resolve includeCodeExamples: explicit user value > plan decision > false
    const resolvedIncludeCode = options?.includeCodeExamples ?? actionPlan.includeCodeExamples ?? false;
    // Resolve outputFormat: explicit user value > plan decision > 'summary'
    const resolvedOutputFormat = options?.outputFormat ?? actionPlan.outputFormat ?? 'summary';
    console.error(`[Research] Plan: ${complexity}/4, steps=${actionPlan.steps.join(', ')}, code=${resolvedIncludeCode}, format=${resolvedOutputFormat} (user=${options?.outputFormat}, plan=${actionPlan.outputFormat})`);
    
    // Create resolved options with planner-decided includeCodeExamples and outputFormat
    const resolvedOptions: ResearchOptions = {
      ...options,
      includeCodeExamples: resolvedIncludeCode,
      outputFormat: resolvedOutputFormat,
    };
    currentStep++;

    // Step 2: Dynamic Execution (gather data)
    emitProgress('Gathering data', 70);
    const execution = await executeResearchPlan({
      query, enrichedContext, depth: complexity, actionPlan,
      context7Client: this.context7Client?.client || null,
      options: resolvedOptions,
      env: this.env,
    });
    currentStep++;

    // Step 3: Extract Global Constraint Manifest from sources
    // This ensures all synthesis calls share consistent facts (arxiv:2310.03025)
    emitProgress('Extracting manifest', 55);
    console.error('[Research] Extracting global constraint manifest from sources...');
    const manifest = await extractGlobalManifest(execution, this.env.GEMINI_API_KEY);
    
    // Store manifest in execution for prompt injection
    const manifestContext = formatManifestForPrompt(manifest);
    const enrichedWithManifest = manifestContext 
      ? `${enrichedContext || ''}\n\n${manifestContext}`
      : enrichedContext;
    currentStep++;

    // Step 4: Synthesize findings into unified answer
    // Automatically uses phased synthesis if sub-questions exist (token-efficient)
    emitProgress('Synthesizing findings', 45);
    let synthesisOutput = await synthesizeFindings(
      this.env.GEMINI_API_KEY,
      query,
      enrichedWithManifest,
      execution,
      { ...resolvedOptions, depth: complexity }
    );
    currentStep++;

    // Step 5: PVR Verification - Check consistency across sections
    let pvrResult: PVRVerificationResult | undefined;
    if (options?.subQuestions?.length) {
      emitProgress('PVR Verification', 35);
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
          resolvedOptions
        );
        
        // Re-verify after re-roll (max 1 iteration)
        const reVerify = await runPVRVerification(synthesisOutput, manifest, this.env.GEMINI_API_KEY);
        console.error(`[Research] Post-reroll PVR score: ${reVerify.entailmentScore.toFixed(2)}`);
        pvrResult = reVerify;
      }
    }

    // Code validation pass (if Context7 docs available)
    if (execution.docCache && Object.keys(execution.docCache.base).length > 0) {
      synthesisOutput = await validateCodeAgainstDocs(
        this.env.GEMINI_API_KEY,
        synthesisOutput,
        execution.docCache
      );
    }
    currentStep++;

    // Step 6: Run challenge + consensus in PARALLEL to save time
    emitProgress('Challenge + Consensus', 25);
    console.error('[Research] Running challenge + consensus in parallel...');
    const challengeContext = {
      enrichedContext,
      constraints: resolvedOptions?.constraints,
      subQuestions: resolvedOptions?.subQuestions,
      includeCodeExamples: resolvedOptions.includeCodeExamples,  // Already resolved from plan
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
    currentStep++;

    // Step 7: Sufficiency Vote - synthesis vs critique
    // Early exit: if no significant gaps found, skip voting entirely
    // Only run at depth >= 3
    let sufficiency: SufficiencyVote | undefined;
    let improved = false;

    console.error('[Research] Challenge result:', challenge);
    console.error('[Research] Consensus result:', consensus);
    
    if (shouldRunVoting && challenge?.hasSignificantGaps) {
      emitProgress('Sufficiency Vote', 15);
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

      // Re-synthesis if critique wins (max 1 iteration)
      // Targeted approach (R-220053): Only re-roll failing sections unless overview fails
      if (sufficiency && !sufficiency.sufficient && sufficiency.failingSections.length > 0) {
        // Convergence criteria (R-235913:q2): Track MAJOR count before re-roll
        const initialMajorCount = sufficiency.details.reduce(
          (sum, d) => sum + d.critiques.filter(c => c.category === 'MAJOR').length, 0
        );
        console.error(`[Research] Initial MAJOR count before re-roll: ${initialMajorCount}`);
        
        // Differential validation (R-235913:q3): Cache critiques for unchanged sections
        const cachedCritiques: Record<string, CategorizedCritique[]> = {};
        const allCritiques = sufficiency.details.flatMap(d => d.critiques);
        for (const critique of allCritiques) {
          const section = critique.section || 'overview';
          if (!cachedCritiques[section]) cachedCritiques[section] = [];
          cachedCritiques[section].push(critique);
        }
        
        // Store previous synthesis in case quality degrades
        const previousSynthesis = { ...synthesisOutput };
        
        // Extend total steps for re-synthesis
        totalSteps = 10;
        improved = true;
        
        // Gather additional data for critical gaps
        await this.gatherDataForGaps(execution, sufficiency.criticalGaps, query);
        currentStep++;
        
        // Track which sections we're re-rolling
        const rerolledSections = sufficiency.failingSections.filter(s => s !== 'global');
        
        // Branch: targeted vs full re-synthesis based on which sections failed
        // 'global' = cross-section issues (spread across many sections) → full re-synthesis
        // 'overview'/'q1'/etc = section-specific → targeted re-roll
        if (sufficiency.failingSections.includes('global')) {
          // Global cross-section issues → full re-synthesis required
          emitProgress('Re-synthesis', 40, 'Cross-section issues detected - full re-synthesis required.');
          console.error('[Research] Global issues detected - full re-synthesis with gaps...');
          synthesisOutput = await this.resynthesizeWithGaps(
            query, enrichedContext, execution, resolvedOptions, sufficiency.criticalGaps, complexity
          );
        } else {
          // Specific sections failed (including overview) → targeted re-roll
          const failingCount = sufficiency.failingSections.length;
          emitProgress('Re-synthesis', 40, `Re-rolling ${failingCount} failing section(s): ${sufficiency.failingSections.join(', ')}`);
          console.error(`[Research] Targeted re-roll of ${failingCount} sections: ${sufficiency.failingSections.join(', ')}`);
          synthesisOutput = await this.rerollFailingSections(
            synthesisOutput,
            sufficiency.failingSections,
            allCritiques,
            execution,
            resolvedOptions
          );
        }
        
        const newSynthesisText = this.synthesisOutputToText(synthesisOutput);
        currentStep++;
        
        // Final challenge - use differential validation for targeted re-rolls (R-235913:q3)
        emitProgress('Final validation', 15);
        
        let finalChallenge: ChallengeResult | undefined;
        
        if (sufficiency.failingSections.includes('global')) {
          // Full re-synthesis → re-challenge everything
          finalChallenge = await runChallenge(this.env.GEMINI_API_KEY, query, newSynthesisText, challengeContext);
        } else {
          // Targeted re-roll → only challenge re-rolled sections
          console.error(`[Research] Differential validation: only challenging ${rerolledSections.join(', ')}`);
          
          // Build section contents for re-rolled sections only
          const sectionContents: Record<string, string> = {};
          for (const sectionId of rerolledSections) {
            if (sectionId === 'overview') {
              sectionContents['overview'] = synthesisOutput.overview;
            } else if (synthesisOutput.subQuestions?.[sectionId]) {
              sectionContents[sectionId] = synthesisOutput.subQuestions[sectionId].answer;
            }
          }
          
          // Run section-specific challenge
          const sectionChallenge = await runSectionChallenge(
            this.env.GEMINI_API_KEY,
            sectionContents,
            query,
            { includeCodeExamples: resolvedOptions.includeCodeExamples, constraints: resolvedOptions?.constraints }
          );
          
          // Merge: new critiques for re-rolled sections + cached critiques for unchanged sections
          const mergedCritiques: Array<{ section: string; issue: string }> = [];
          
          // Add new critiques from re-rolled sections
          if (sectionChallenge?.critiques) {
            mergedCritiques.push(...sectionChallenge.critiques);
          }
          
          // Add cached critiques from unchanged sections
          for (const [section, critiques] of Object.entries(cachedCritiques)) {
            if (!rerolledSections.includes(section)) {
              console.error(`[Research] Keeping ${critiques.length} cached critiques for unchanged section: ${section}`);
              mergedCritiques.push(...critiques.map(c => ({ section: c.section, issue: c.issue })));
            }
          }
          
          finalChallenge = {
            critiques: mergedCritiques,
            hasSignificantGaps: mergedCritiques.length > 0,
            rawResponse: 'Merged from differential validation',
          };
          
          console.error(`[Research] Merged critiques: ${mergedCritiques.length} (${sectionChallenge?.critiques?.length || 0} new + ${mergedCritiques.length - (sectionChallenge?.critiques?.length || 0)} cached)`);
        }
        
        if (finalChallenge?.hasSignificantGaps) {
          const newSufficiency = await runSufficiencyVote(
            this.env.GEMINI_API_KEY, 
            query, 
            newSynthesisText, 
            finalChallenge, 
            this.env,
            manifest.keyFacts,
            challengeContext.validSources
          );
          
          if (!newSufficiency) {
            console.error(`[Research] Vote failed - keeping original synthesis`);
          } else {
            // Convergence criteria (R-235913:q2): Check if quality improved
            const newMajorCount = newSufficiency.details.reduce(
              (sum, d) => sum + d.critiques.filter(c => c.category === 'MAJOR').length, 0
            );
            console.error(`[Research] New MAJOR count after re-roll: ${newMajorCount} (was ${initialMajorCount})`);
            
            // If quality degraded (MAJOR count increased or didn't decrease), revert to previous version
            if (newMajorCount >= initialMajorCount) {
              console.error(`[Research] Quality degraded or unchanged - reverting to previous synthesis`);
              synthesisOutput = previousSynthesis;
              // Keep original sufficiency (it was better)
            } else {
              console.error(`[Research] Quality improved - using re-synthesized version`);
              sufficiency = newSufficiency;
            }
          }
        } else {
          // No gaps after re-synthesis, synthesis wins
          sufficiency = {
            sufficient: true,
            criticalGaps: [],
            details: [{ model: 'default', reasoning: 'No gaps after re-synthesis', critiques: [] }],
            stylisticPreferences: [],
            hasCriticalGap: false,
            failingSections: [],
          };
        }
      }
    } else {
      console.error('[Research] No significant gaps - skipping vote');
      sufficiency = {
        sufficient: true,
        criticalGaps: [],
        details: [{ model: 'default', reasoning: 'Challenge found no significant gaps', critiques: [] }],
        stylisticPreferences: [],
        hasCriticalGap: false,
        failingSections: [],
      };
    }
    currentStep++;

    // Step 8: Build sections from structured synthesis output + validation data
    emitProgress('Building sections', 5);
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
      outputFormat: resolvedOptions.outputFormat,
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
    if (complexity >= 4 && sufficiency?.sufficient) return 'high';
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
   * Targeted re-roll: Only re-synthesize sections that failed validation
   * Based on R-220053 (granular validation)
   * - 'overview' → re-roll overview, keep sub-questions as reference
   * - 'q1'/'q2'/etc → re-roll sub-question, use overview as anchor
   */
  private async rerollFailingSections(
    synthesis: SynthesisOutput,
    failingSections: string[],
    critiques: CategorizedCritique[],
    execution: any,
    options: ResearchOptions | undefined
  ): Promise<SynthesisOutput> {
    const result: SynthesisOutput = {
      overview: synthesis.overview,
      subQuestions: { ...synthesis.subQuestions },
      additionalInsights: synthesis.additionalInsights,
    };

    // Handle overview re-roll first (if needed)
    if (failingSections.includes('overview')) {
      const overviewCritiques = critiques
        .filter(c => c.section === 'overview')
        .map(c => `[${c.category}] ${c.issue}`)
        .join('\n');

      console.error(`[Research] Re-rolling overview due to critiques: ${overviewCritiques.slice(0, 100)}...`);

      const overviewPrompt = this.buildOverviewRerollPrompt(
        synthesis.overview,
        overviewCritiques,
        execution,
        options
      );

      try {
        const { callLLM } = await import('./clients/llm.js');
        const response = await callLLM(overviewPrompt, {
          provider: 'gemini',
          model: 'gemini-2.5-flash-lite',
          apiKey: this.env.GEMINI_API_KEY,
          timeout: 30000,
          maxOutputTokens: 4000,
          temperature: 0.2,
        });
        result.overview = response.content.trim();
      } catch (error) {
        console.error(`[Research] Failed to re-roll overview:`, error);
      }
    }

    // Re-roll each failing sub-question
    for (const sectionId of failingSections) {
      if (sectionId === 'overview' || sectionId === 'global') continue;
      if (!result.subQuestions?.[sectionId]) continue;

      const subQ = result.subQuestions[sectionId];
      const subQIndex = parseInt(sectionId.replace('q', ''), 10) - 1;
      const subQData = execution.subQuestionResults?.[subQIndex];
      
      // Include current answer for minimal edit approach (R-235913:q1)
      const subQDataWithAnswer = {
        ...subQData,
        synthesis: subQ.answer, // Pass current answer so LLM can make minimal edits
      };

      const sectionCritiques = critiques
        .filter(c => c.section === sectionId)
        .map(c => `[${c.category}] ${c.issue}`)
        .join('\n');

      console.error(`[Research] Re-rolling section ${sectionId} due to critiques: ${sectionCritiques.slice(0, 100)}...`);

      const rerollPrompt = this.buildCritiqueRerollPrompt(
        subQ.question,
        result.overview, // Use potentially updated overview as anchor
        sectionCritiques,
        subQDataWithAnswer,
        options
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
      }
    }

    return result;
  }

  /**
   * Build prompt for overview re-roll using MINIMAL LOCALIZED EDITS (R-235913:q1)
   * Only fix the specific issues, don't rewrite the entire section
   */
  private buildOverviewRerollPrompt(
    currentOverview: string,
    critiqueContext: string,
    execution: any,
    options?: ResearchOptions
  ): string {
    const codeInstruction = options?.includeCodeExamples
      ? 'You MAY include code examples if relevant to fixing the critiques.'
      : 'Do NOT add code examples.';

    const sourceSummary = execution.perplexityResult?.content
      ? `\nSource Data (for reference):\n${execution.perplexityResult.content.slice(0, 1500)}\n`
      : '';

    return `You are making MINIMAL EDITS to fix specific issues in an overview section.

CURRENT OVERVIEW:
${currentOverview}

CRITIQUES TO FIX:
${critiqueContext}

${sourceSummary}

CRITICAL INSTRUCTIONS (R-235913):
- Make ONLY the smallest changes necessary to address each critique
- DO NOT rewrite sentences that are not mentioned in the critiques
- DO NOT change the structure, ordering, or length significantly
- DO NOT introduce new topics, claims, or content not in the original
- Preserve all content that is NOT criticized
- ${codeInstruction}

Return the overview with MINIMAL targeted fixes applied. Keep unchanged content EXACTLY as-is.`.trim();
  }

  /**
   * Build prompt for critique-driven re-rolling using MINIMAL LOCALIZED EDITS (R-235913:q1)
   * Only fix the specific issues, don't rewrite the entire section
   */
  private buildCritiqueRerollPrompt(
    question: string,
    overviewAnchor: string,
    critiqueContext: string,
    subQData?: any,
    options?: ResearchOptions
  ): string {
    const dataSection = subQData?.perplexityResult?.content
      ? `\nSource Data (for reference):\n${subQData.perplexityResult.content.slice(0, 1500)}\n`
      : '';

    const codeInstruction = options?.includeCodeExamples
      ? 'You MAY include code if relevant to fixing the critiques.'
      : 'Do NOT add code examples.';

    // Get current answer if available from subQData
    const currentAnswer = subQData?.synthesis || '';
    const currentSection = currentAnswer 
      ? `\nCURRENT ANSWER:\n${currentAnswer}\n`
      : '';

    return `You are making MINIMAL EDITS to fix specific issues in a sub-question answer.

SUB-QUESTION: ${question}
${currentSection}
ANCHOR (main overview - ensure consistency):
${overviewAnchor.slice(0, 1500)}

CRITIQUES TO FIX:
${critiqueContext}

${dataSection}

CRITICAL INSTRUCTIONS (R-235913):
- Make ONLY the smallest changes necessary to address each critique
- DO NOT rewrite sentences that are not mentioned in the critiques
- DO NOT change the structure or length significantly
- MUST align with the anchor overview
- Preserve all content that is NOT criticized
- ${codeInstruction}

Return the answer with MINIMAL targeted fixes applied. Keep unchanged content EXACTLY as-is.`;
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

