import { selectBestPlan } from './judge.js';
import { callLLMsParallel, getVotingConfigs, LLMResponse } from './clients/llm.js';

export interface ResearchActionPlan {
  complexity: number; // 1-5
  reasoning: string;
  steps: string[]; // e.g., ['perplexity_search', 'deep_analysis', 'arxiv_search']
  modelVotes: Array<{ model: string; complexity: number }>;
  toolsToUse: string[];
  toolsToSkip: string[];
}

interface PlanningProposal {
  model: string;
  plan: ResearchActionPlan;
  confidence: number;
}

/**
 * Generate a research action plan using TRUE parallel LLM voting
 * Uses direct API calls for parallel voting
 */
export async function generateConsensusPlan(
  geminiKey: string,
  query: string,
  enrichedContext?: string,
  options?: {
    constraints?: string[];
    papersRead?: string[];
    techStack?: string[];
    subQuestions?: string[];
    maxDepth?: number;  // User-requested maximum depth (1-5)
  },
  env?: Record<string, string>
): Promise<ResearchActionPlan> {
  const planningPrompt = buildPlanningPrompt(query, enrichedContext, options);
  const configs = getVotingConfigs(geminiKey);

  if (configs.length === 0) {
    console.error('[Planning] No API keys configured, using fallback plan');
    return createFallbackPlan(options);
  }

  // TRUE parallel LLM calls via direct API
  const responses = await callLLMsParallel(planningPrompt, configs);

  // Parse responses into proposals, respecting maxDepth cap
  const maxDepth = options?.maxDepth;
  const validProposals: PlanningProposal[] = responses
    .filter((r): r is LLMResponse => !r.error && r.content.length > 0)
    .map((r) => {
      const plan = parseActionPlan(r.content, maxDepth);
      return { model: r.model, plan, confidence: calculateConfidence(plan) };
    });

  if (validProposals.length === 0) {
    return createFallbackPlan(options);
  }

  console.error(`[Planning] Received ${validProposals.length} valid proposals`);

  // Select best plan via LLM judge
  const selectedPlan = await selectBestPlan(geminiKey, validProposals, query, enrichedContext);

  console.error(`[Planning] Selected plan from ${selectedPlan.model} (confidence: ${selectedPlan.confidence})`);

  return {
    ...selectedPlan.plan,
    modelVotes: validProposals.map(p => ({ model: p.model, complexity: p.plan.complexity })),
  };
}

export function createFallbackPlan(options?: { techStack?: string[]; subQuestions?: string[]; maxDepth?: number }): ResearchActionPlan {
  const maxDepth = options?.maxDepth ?? 3;
  const complexity = Math.min(3, maxDepth);
  
  const steps = ['perplexity_search'];
  
  // Only add deep_analysis at depth >= 2
  if (complexity >= 2) {
    steps.push('deep_analysis');
  }
  
  // Only add library_docs at depth >= 3
  if (complexity >= 3 && options?.techStack?.length) {
    steps.push('library_docs');
  }
  
  if (options?.subQuestions?.length) {
    steps.push('sub_questions');
  }
  
  // Only add challenge at depth >= 2
  if (complexity >= 2) {
    steps.push('challenge');
  }

  return {
    complexity,
    reasoning: `Fallback plan (LLM planning failed)${options?.maxDepth ? ` - capped at depth ${options.maxDepth}` : ''}`,
    steps,
    modelVotes: [],
    toolsToUse: steps,
    toolsToSkip: [],
  };
}

/**
 * Build the planning prompt for LLMs
 */
function buildPlanningPrompt(
  query: string,
  enrichedContext?: string,
  options?: {
    constraints?: string[];
    papersRead?: string[];
    techStack?: string[];
    subQuestions?: string[];
    maxDepth?: number;
  }
): string {
  const maxDepthInstruction = options?.maxDepth 
    ? `\n**IMPORTANT: User requested max depth level: ${options.maxDepth}. Do NOT exceed this complexity level.**\n`
    : '';
    
  return `
You are a research planning expert. Create a detailed action plan to answer this research query.

Query: ${query}
${maxDepthInstruction}
${enrichedContext ? `Context:\n${enrichedContext}\n` : ''}

${options?.constraints ? `Constraints:\n- ${options.constraints.join('\n- ')}\n` : ''}
${options?.papersRead ? `Papers Already Read (avoid):\n- ${options.papersRead.join('\n- ')}\n` : ''}
${options?.techStack ? `Tech Stack: ${options.techStack.join(', ')}\n` : ''}
${options?.subQuestions ? `Sub-questions:\n${options.subQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n` : ''}

Available tools:
- perplexity: Web search for recent information and sources
- deep_analysis: AI reasoning and analysis
- context7: Library/framework documentation with code examples
- arxiv: Academic papers (with summaries)
- consensus: Multi-model validation (for critical findings)

Return a JSON action plan with this structure:
{
  "complexity": 1-5,
  "reasoning": "Why this complexity level",
  "steps": [
    {
      "tool": "perplexity",
      "description": "What this step achieves",
      "parameters": {
        "query": "Specific search query"
      },
      "parallel": false
    },
    {
      "tool": "deep_analysis",
      "description": "Analyze findings",
      "parallel": false
    },
    {
      "tool": "context7",
      "description": "Library/framework documentation with code examples",
      "parameters": {
        "query": "Specific library/framework documentation"
      },
      "parallel": false
    },
    {
      "tool": "arxiv",
      "description": "Academic papers",
      "parameters": {
        "query": "Specific academic paper"
      },
      "parallel": false
    },
    {
      "tool": "consensus",
      "description": "Multi-model validation",
      "parameters": {
        "query": "Specific validation query"
      },
      "parallel": false
    }
  ],
  "estimated_time_seconds": 30
}

Rules:
1. Complexity 1: Use perplexity only
2. Complexity 2: Add deep_analysis
3. Complexity 3: Add context7 (if tech_stack provided)
4. Complexity 4: Add arxiv papers and consensus validation
5. Mark steps as parallel: true if they can run simultaneously
6. Avoid tools for papers_read papers
7. Keep total time under constraints if specified

Return ONLY the JSON, no explanation.
`.trim();
}

function parseActionPlan(response: string, maxDepth?: number): ResearchActionPlan {
  // DEBUG: Log first 300 chars of response
  console.error(`[Planning] Raw response preview: ${response.slice(0, 300).replace(/\n/g, '\\n')}${maxDepth ? ` (max depth: ${maxDepth})` : ''}`);
  
  // Step 1: Strip markdown code fences if present
  let jsonStr = response
    .replace(/^```(?:json)?\s*/gm, '')  // Remove opening fence
    .replace(/```\s*$/gm, '')            // Remove closing fence
    .trim();
  
  // Step 2: Try to find complete JSON first
  let parsed: any = null;
  
  const startIdx = jsonStr.indexOf('{');
  if (startIdx !== -1) {
    // Find matching closing brace
    let depth = 0;
    let endIdx = -1;
    for (let i = startIdx; i < jsonStr.length; i++) {
      if (jsonStr[i] === '{') depth++;
      if (jsonStr[i] === '}') depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
    
    if (endIdx !== -1) {
      const jsonContent = jsonStr.slice(startIdx, endIdx + 1);
      console.error(`[Planning] Extracted JSON (${jsonContent.length} chars)`);

      // Clean common JSON issues from LLMs
      let cleanJson = jsonContent
        .replace(/,\s*}/g, '}')  // Remove trailing commas before }
        .replace(/,\s*]/g, ']')  // Remove trailing commas before ]
        .replace(/'/g, '"');      // Replace single quotes with double
      
      try {
        parsed = JSON.parse(cleanJson);
        console.error(`[Planning] JSON parsed successfully`);
      } catch (e) {
        console.error(`[Planning] JSON parse failed, using regex fallback`);
      }
    } else {
      console.error(`[Planning] Incomplete JSON (no closing brace), using regex fallback`);
    }
  }
  
  // Step 3: Fallback - extract fields with regex from raw response
  // This handles truncated JSON where we can still get complexity/reasoning
  if (!parsed) {
    parsed = extractFieldsWithRegex(response);
  }

  // If it's a wrapped response, extract the content
  if (parsed.content && typeof parsed.content === 'string') {
    const contentMatch = parsed.content.match(/\{[\s\S]*\}/);
    if (contentMatch) {
      try { parsed = JSON.parse(contentMatch[0]); } catch {}
    }
  }

  // Convert ActionStep[] to string[] and deduplicate
  let steps: string[] = extractSteps(parsed, response);

  // Default steps based on complexity if none parsed
  if (steps.length === 0) {
    const c = parsed.complexity || 3;
    steps = ['perplexity_search'];
    if (c >= 2) steps.push('deep_analysis');
    if (c >= 4) steps.push('arxiv_search');
  }

  // Cap complexity at maxDepth if specified
  let complexity = Math.min(4, Math.max(1, parsed.complexity || 3));
  if (maxDepth !== undefined) {
    complexity = Math.min(complexity, maxDepth);
  }
  
  // Filter steps based on capped complexity (consistent with execution.ts)
  // - deep_analysis: depth >= 2
  // - context7/library: depth >= 3
  // - arxiv: depth >= 4
  // - consensus: depth >= 4
  let filteredSteps = steps;
  if (complexity < 2) {
    // Remove deep_analysis at depth < 2
    filteredSteps = filteredSteps.filter(s => !s.includes('deep') && !s.includes('thinking'));
  }
  if (complexity < 3) {
    // Remove context7/library_docs at depth < 3
    filteredSteps = filteredSteps.filter(s => !s.includes('library') && !s.includes('context'));
  }
  if (complexity < 4) {
    // Remove consensus and arxiv at depth < 4
    filteredSteps = filteredSteps.filter(s => !s.includes('consensus') && !s.includes('arxiv'));
  }
  
  const result = {
    complexity,
    reasoning: maxDepth !== undefined && parsed.complexity > maxDepth 
      ? `${parsed.reasoning || 'No reasoning provided'} (capped from ${parsed.complexity} to ${maxDepth})`
      : parsed.reasoning || 'No reasoning provided',
    steps: filteredSteps,
    modelVotes: [],
    toolsToUse: filteredSteps,
    toolsToSkip: parsed.toolsToSkip || [],
  };
  
  console.error(`[Planning] Parsed plan: complexity=${result.complexity}, steps=${result.steps.join(', ')}${maxDepth ? ` (max: ${maxDepth})` : ''}`);
  return result;
}

/**
 * Extract fields from response using regex (handles truncated JSON)
 */
function extractFieldsWithRegex(response: string): any {
  // Extract complexity - look for "complexity": 5 or complexity: 5
  const complexityMatch = response.match(/["']?complexity["']?\s*:\s*(\d)/);
  
  // Extract reasoning - handle multi-line strings
  let reasoning = 'Extracted from incomplete response';
  const reasoningMatch = response.match(/["']?reasoning["']?\s*:\s*["']([^"']{10,200})/);
  if (reasoningMatch) {
    reasoning = reasoningMatch[1].replace(/\\n/g, ' ').trim();
  }
  
  return {
    complexity: complexityMatch ? parseInt(complexityMatch[1]) : 3,
    reasoning,
    steps: [],
  };
}

/**
 * Extract steps from parsed object or raw response
 */
function extractSteps(parsed: any, rawResponse: string): string[] {
  let steps: string[] = [];
  
  // Try to get steps from parsed object
  if (Array.isArray(parsed.steps)) {
    const rawSteps: string[] = parsed.steps.map((s: any) => {
      if (typeof s === 'string') return s;
      if (s.tool) {
        const tool = s.tool.toLowerCase();
        if (tool.includes('perplexity')) return 'perplexity_search';
        if (tool.includes('deep') || tool.includes('thinking')) return 'deep_analysis';
        if (tool.includes('arxiv') || tool.includes('paper')) return 'arxiv_search';
        if (tool.includes('context') || tool.includes('library') || tool.includes('doc')) return 'library_docs';
        if (tool.includes('consensus')) return 'consensus';
        return tool + '_search';
      }
      return 'perplexity_search';
    });
    steps = [...new Set(rawSteps)];
  }
  
  // If no steps from parsed, try to extract tool mentions from raw response
  if (steps.length === 0) {
    const toolMentions = rawResponse.toLowerCase();
    if (toolMentions.includes('perplexity')) steps.push('perplexity_search');
    if (toolMentions.includes('deep') || toolMentions.includes('thinking')) steps.push('deep_analysis');
    if (toolMentions.includes('arxiv') || toolMentions.includes('paper')) steps.push('arxiv_search');
    if (toolMentions.includes('context7') || toolMentions.includes('library')) steps.push('library_docs');
    if (toolMentions.includes('consensus')) steps.push('consensus');
  }
  
  return steps;
}

/**
 * Calculate confidence score for a plan
 */
function calculateConfidence(plan: ResearchActionPlan): number {
  let score = 0.5; // Base confidence

  // Higher confidence if plan has clear steps
  if (plan.steps.length > 0) score += 0.2;
  if (plan.steps.length >= 3) score += 0.1;

  // Higher confidence if reasoning is detailed
  if (plan.reasoning.length > 50) score += 0.1;

  // Lower confidence if complexity seems off
  if (plan.complexity < 1 || plan.complexity > 5) score -= 0.3;

  return Math.min(1, Math.max(0, score));
}

/**
 * Parse content from LLM response that might be wrapped in JSON
 * Cleans common response artifacts and wrapper patterns
 */
export function extractContent(response: string): string {
  let content = response;
  
  // Try to extract from JSON wrapper (common LLM response pattern)
  try {
    const parsed = JSON.parse(response);
    if (parsed.content && typeof parsed.content === 'string') {
      content = parsed.content;
    }
  } catch {
    // Not JSON, continue with raw response
  }
  
  // Remove common "AGENT'S TURN" footer pattern
  content = content.replace(/---\s*\n*AGENT'S TURN:[\s\S]*$/i, '').trim();
  
  // Remove raw JSON blocks that shouldn't be in final output
  // These patterns match common JSON wrappers
  const jsonPatterns = [
    /\{"status":\s*"[^"]*"[\s\S]*?\}/g,                    // status wrapper
    /\{"challenge_accepted"[\s\S]*?\}/g,                   // challenge wrapper
    /\{"challenge_prompt"[\s\S]*?\}/g,                     // challenge prompt
    /\{"original_statement"[\s\S]*?\}/g,                   // original statement wrapper
    /\{"instructions"[\s\S]*?\}/g,                         // instructions wrapper
    /\{"mandatory_instructions"[\s\S]*?\}/g,               // mandatory instructions
    /\{"files_needed"[\s\S]*?\}/g,                         // files needed wrapper
    /\{"files_required_to_continue"[\s\S]*?\}/g,           // files required wrapper
  ];
  
  for (const pattern of jsonPatterns) {
    content = content.replace(pattern, '').trim();
  }
  
  // Remove markdown code blocks that contain only JSON (often leftover wrappers)
  content = content.replace(/```json\s*\{[\s\S]*?\}\s*```/g, '').trim();
  
  // Clean up multiple consecutive newlines
  content = content.replace(/\n{3,}/g, '\n\n');
  
  return content;
}
/**
 * Sufficiency vote result from a single model
 */
export interface SufficiencyVote {
  model: string;
  sufficient: boolean;
  reasoning: string;
  suggestions?: string[]; // What to add if insufficient
}

/**
 * Aggregated sufficiency result
 */
export interface SufficiencyResult {
  sufficient: boolean;
  votesFor: number;
  votesAgainst: number;
  suggestions: string[]; // Aggregated suggestions from all voters
  details: SufficiencyVote[];
}
