import { Client } from '@modelcontextprotocol/sdk/client/index.js';
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
 * Uses direct API calls to bypass PAL MCP stdio serialization bottleneck
 */
export async function generateConsensusPlan(
  palClient: Client,
  query: string,
  enrichedContext?: string,
  options?: {
    constraints?: string[];
    papersRead?: string[];
    techStack?: string[];
    subQuestions?: string[];
  }
): Promise<ResearchActionPlan> {
  const planningPrompt = buildPlanningPrompt(query, enrichedContext, options);
  const configs = getVotingConfigs();

  if (configs.length === 0) {
    console.error('[Planning] No API keys configured, using fallback plan');
    return createFallbackPlan(options);
  }

  // TRUE parallel LLM calls via direct API (not through PAL MCP stdio)
  const responses = await callLLMsParallel(planningPrompt, configs);

  // Parse responses into proposals
  const validProposals: PlanningProposal[] = responses
    .filter((r): r is LLMResponse => !r.error && r.content.length > 0)
    .map((r) => {
      const plan = parseActionPlan(r.content);
      return { model: r.model, plan, confidence: calculateConfidence(plan) };
    });

  if (validProposals.length === 0) {
    return createFallbackPlan(options);
  }

  console.error(`[Planning] Received ${validProposals.length} valid proposals`);

  // Select best plan via LLM judge (still uses PAL - single sequential call is fine)
  const selectedPlan = await selectBestPlan(palClient, validProposals, query, enrichedContext);

  console.error(`[Planning] Selected plan from ${selectedPlan.model} (confidence: ${selectedPlan.confidence})`);

  return {
    ...selectedPlan.plan,
    modelVotes: validProposals.map(p => ({ model: p.model, complexity: p.plan.complexity })),
  };
}

export function createFallbackPlan(options?: { techStack?: string[]; subQuestions?: string[] }): ResearchActionPlan {
  const steps = ['perplexity_search', 'deep_analysis'];
  if (options?.techStack?.length) steps.push('library_docs');
  if (options?.subQuestions?.length) steps.push('sub_questions');
  steps.push('challenge');

  return {
    complexity: 3,
    reasoning: 'Fallback plan (LLM planning failed)',
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
  }
): string {
  return `
You are a research planning expert. Create a detailed action plan to answer this research query.

Query: ${query}

${enrichedContext ? `Context:\n${enrichedContext}\n` : ''}

${options?.constraints ? `Constraints:\n- ${options.constraints.join('\n- ')}\n` : ''}
${options?.papersRead ? `Papers Already Read (avoid):\n- ${options.papersRead.join('\n- ')}\n` : ''}
${options?.techStack ? `Tech Stack: ${options.techStack.join(', ')}\n` : ''}
${options?.subQuestions ? `Sub-questions:\n${options.subQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n` : ''}

Available tools:
- perplexity: Web search for recent information and sources
- pal_deep_thinking: AI reasoning and analysis
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
      "tool": "pal_deep_thinking",
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
1. Complexity 1-2: Use perplexity only or + basic reasoning
2. Complexity 3: Add context7 (if tech_stack)
3. Complexity 4: add consensus validation
4. Complexity 5: Add arxiv research papers
5. Mark steps as parallel: true if they can run simultaneously
6. Avoid tools for papers_read papers
7. Keep total time under constraints if specified

Return ONLY the JSON, no explanation.
`.trim();
}

function parseActionPlan(response: string): ResearchActionPlan {
  // DEBUG: Log first 300 chars of response
  console.error(`[Planning] Raw response preview: ${response.slice(0, 300).replace(/\n/g, '\\n')}`);
  
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

  const result = {
    complexity: Math.min(5, Math.max(1, parsed.complexity || 3)),
    reasoning: parsed.reasoning || 'No reasoning provided',
    steps,
    modelVotes: [],
    toolsToUse: steps,
    toolsToSkip: parsed.toolsToSkip || [],
  };
  
  console.error(`[Planning] Parsed plan: complexity=${result.complexity}, steps=${result.steps.join(', ')}`);
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
        if (tool.includes('deep') || tool.includes('pal') || tool.includes('thinking')) return 'deep_analysis';
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
    if (toolMentions.includes('deep') || toolMentions.includes('pal_deep') || toolMentions.includes('thinking')) steps.push('deep_analysis');
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
 * Cleans PAL's "AGENT'S TURN" footer, raw JSON artifacts, and challenge-specific wrappers
 */
export function extractContent(response: string): string {
  let content = response;
  
  // Try to extract from JSON wrapper (PAL often wraps responses)
  try {
    const parsed = JSON.parse(response);
    if (parsed.content && typeof parsed.content === 'string') {
      content = parsed.content;
    }
  } catch {
    // Not JSON, continue with raw response
  }
  
  // Remove PAL's "AGENT'S TURN" footer
  content = content.replace(/---\s*\n*AGENT'S TURN:[\s\S]*$/i, '').trim();
  
  // Remove raw JSON blocks that shouldn't be in final output
  // These patterns match common PAL/challenge JSON wrappers
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

/**
 * Run sufficiency vote with TRUE parallel LLM calls to validate response quality
 * Uses direct API calls to bypass PAL MCP stdio serialization bottleneck
 */
export async function runSufficiencyVote(
  palClient: Client,
  query: string,
  markdown: string,
  actionPlan?: ResearchActionPlan
): Promise<SufficiencyResult> {
  console.error('[Sufficiency] Running quality vote with TRUE parallel LLM calls...');

  const votePrompt = buildSufficiencyPrompt(query, markdown, actionPlan);
  const configs = getVotingConfigs();

  if (configs.length === 0) {
    console.error('[Sufficiency] No API keys configured, assuming sufficient');
    return { sufficient: true, votesFor: 0, votesAgainst: 0, suggestions: [], details: [] };
  }

  // TRUE parallel LLM calls via direct API (not through PAL MCP stdio)
  const responses = await callLLMsParallel(votePrompt, configs);

  // Parse responses into votes
  const validVotes: SufficiencyVote[] = responses
    .filter((r): r is LLMResponse => !r.error && r.content.length > 0)
    .map((r) => parseSufficiencyVote(r.content, r.model));

  if (validVotes.length === 0) {
    console.error('[Sufficiency] All votes failed, assuming sufficient');
    return { sufficient: true, votesFor: 0, votesAgainst: 0, suggestions: [], details: [] };
  }

  // Aggregate results
  const votesFor = validVotes.filter((v) => v.sufficient).length;
  const votesAgainst = validVotes.filter((v) => !v.sufficient).length;
  const sufficient = votesFor > votesAgainst; // Majority wins

  // Aggregate suggestions from insufficient votes
  const allSuggestions = validVotes
    .filter((v) => !v.sufficient && v.suggestions)
    .flatMap((v) => v.suggestions || []);
  const uniqueSuggestions = Array.from(new Set(allSuggestions));

  console.error(`[Sufficiency] Vote result: ${votesFor} sufficient, ${votesAgainst} insufficient`);
  if (!sufficient) {
    console.error(`[Sufficiency] Suggestions: ${uniqueSuggestions.join(', ')}`);
  }

  return {
    sufficient,
    votesFor,
    votesAgainst,
    suggestions: uniqueSuggestions,
    details: validVotes,
  };
}

/**
 * Build sufficiency vote prompt
 */
function buildSufficiencyPrompt(
  query: string,
  markdown: string,
  actionPlan?: ResearchActionPlan
): string {
  return `
You are a research quality validator. Evaluate if this research response sufficiently answers the user's query.

User Query: ${query}

${actionPlan ? `Action Plan Executed:\n${actionPlan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n` : ''}

Research Response:
${markdown.slice(0, 2000)}...

Evaluate:
1. Does the response fully answer the query?
2. Are there obvious gaps or missing information?
3. Is the depth appropriate for the complexity?

Return JSON:
{
  "sufficient": true/false,
  "reasoning": "Why sufficient or not",
  "suggestions": ["search_more_papers", "add_code_examples", "increase_complexity", "search_more_web"]
}

Possible suggestions:
- "search_more_papers": Need more academic research
- "add_code_examples": Need implementation examples
- "increase_complexity": Current depth too shallow
- "search_more_web": Need more recent sources
- "add_library_docs": Need framework/library documentation

Only return the JSON, no explanation.
`.trim();
}

/**
 * Parse sufficiency vote from LLM response
 */
function parseSufficiencyVote(response: string, model: string): SufficiencyVote {
  try {
    // Extract JSON from response
    let content = extractContent(response);

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found');
    }

    const parsed = JSON.parse(jsonMatch[0]);

    return {
      model,
      sufficient: parsed.sufficient !== false, // Default to true if unclear
      reasoning: parsed.reasoning || 'No reasoning provided',
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
    };
  } catch (error) {
    console.error(`[Sufficiency] Failed to parse vote from ${model}:`, error);
    // Fallback: assume sufficient if parsing fails
    return {
      model,
      sufficient: true,
      reasoning: 'Failed to parse, assuming sufficient',
      suggestions: [],
    };
  }
}

