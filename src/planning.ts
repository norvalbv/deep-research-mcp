import { selectBestPlan } from './judge.js';
import { callLLMsParallel, getVotingConfigs, LLMResponse, callLLM } from './clients/llm.js';
import { RootPlan } from './types/index.js';

export interface ResearchActionPlan {
  complexity: number; // 1-5
  reasoning: string;
  steps: string[]; // e.g., ['perplexity_search', 'deep_analysis', 'arxiv_search']
  modelVotes: Array<{ model: string; complexity: number }>;
  toolsToUse: string[];
  toolsToSkip: string[];
  _rawPlan?: any;  // Stores new RootPlan structure if present
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

  // Select best plan via LLM judge
  const selectedPlan = await selectBestPlan(geminiKey, validProposals, query, enrichedContext);

  console.error(`[Planning] Selected plan from ${selectedPlan.model} (confidence: ${selectedPlan.confidence})`);

  return {
    ...selectedPlan.plan,
    modelVotes: validProposals.map(p => ({ model: p.model, complexity: p.plan.complexity })),
  };
}

/**
 * Plan a single sub-question (lightweight, fast)
 * Uses single LLM call for speed
 */
export async function planSubQuestion(
  geminiKey: string,
  subQuestion: string,
  mainContext?: string,
  techStack?: string[]
): Promise<{ tools: string[]; params?: any }> {
  if (!geminiKey) {
    // Fallback: just use Perplexity
    return { tools: ['perplexity'] };
  }

  const prompt = buildSubQuestionPlanningPrompt(subQuestion, mainContext, techStack);

  try {
    const response = await callLLM(prompt, {
      provider: 'gemini',
      model: 'gemini-2.5-flash',  // Fast model for sub-Q planning
      apiKey: geminiKey,
      timeout: 15000  // Quick 15s timeout
    });

    // Parse the sub-Q plan
    const plan = parseSubQuestionPlan(response.content);
    return plan;
  } catch (error) {
    console.error('[SubQ Planning] Error:', error);
    // Fallback based on tech stack
    if (techStack?.length) {
      return { tools: ['context7', 'perplexity'], params: { library: techStack[0] } };
    }
    return { tools: ['perplexity'] };
  }
}

function buildSubQuestionPlanningPrompt(
  subQuestion: string,
  mainContext?: string,
  techStack?: string[]
): string {
  return `
You are planning research for a sub-question. Choose the RIGHT tools quickly.

Sub-Question: ${subQuestion}

${mainContext ? `Main Research Context:\n${mainContext}\n` : ''}
${techStack?.length ? `Available Tech Stack: ${techStack.join(', ')}\n` : ''}

Available tools:
- perplexity: Web search
- context7: Library docs (if question is about specific library/framework)
- arxiv: Academic papers (if theoretical/research-heavy)

Return JSON:
{
  "tools": ["perplexity"],
  "params": {
    "context7Query": "specific topic",
    "library": "library-name"
  }
}

Rules:
1. Use context7 ONLY if question is specifically about a library in tech_stack
2. Use arxiv ONLY if question needs academic/theoretical research
3. Always include perplexity for web search
4. Keep it simple - most sub-Qs just need perplexity

Return ONLY JSON, no explanation.
`.trim();
}

function parseSubQuestionPlan(response: string): { tools: string[]; params?: any } {
  try {
    // Clean and parse JSON
    let jsonStr = response.trim()
      .replace(/^```(?:json)?\s*/gm, '')
      .replace(/```\s*$/gm, '');
    
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        tools: Array.isArray(parsed.tools) ? parsed.tools : ['perplexity'],
        params: parsed.params || {}
      };
    }
  } catch (error) {
    console.error('[SubQ Planning] Parse error:', error);
  }
  
  // Fallback
  return { tools: ['perplexity'] };
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
  const hasTechStack = options?.techStack?.length;
  
  return `
You are a research planning expert. Create a detailed action plan to answer this research query.

Query: ${query}

${enrichedContext ? `Context:\n${enrichedContext}\n` : ''}

${options?.constraints ? `Constraints:\n- ${options.constraints.join('\n- ')}\n` : ''}
${options?.papersRead ? `Papers Already Read (avoid):\n- ${options.papersRead.join('\n- ')}\n` : ''}
${hasTechStack ? `Tech Stack: ${options.techStack!.join(', ')}\n` : ''}

Available tools:
- perplexity: Web search for recent information and sources
- deep_analysis: AI reasoning and analysis
- context7: Library/framework documentation with code examples (specify library + topic)
- arxiv: Academic papers (with summaries)
- consensus: Multi-model validation (for critical findings)

Return a JSON action plan with this structure:
{
  "complexity": 1-5,
  "reasoning": "Why this complexity level",
  "mainQuery": {
    "steps": ["perplexity", "deep_analysis"],
    "actionSteps": [
      {
        "tool": "perplexity",
        "description": "What this achieves",
        "parameters": {"query": "specific query"}
      }
    ]
  }${hasTechStack ? `,
  "sharedDocumentation": {
    "libraries": ${JSON.stringify(options.techStack)},
    "topics": ["getting started", "api basics"]
  }` : ''}
}

Rules:
1. Complexity 1-2: Use perplexity only or + basic reasoning
2. Complexity 3: Add context7 (if tech_stack provided)
3. Complexity 4: Add consensus validation
4. Complexity 5: Add arxiv research papers
5. Focus ONLY on the main query - sub-questions will be planned separately
6. sharedDocumentation.topics should be common syntax/basics if tech_stack provided
7. Avoid tools for papers_read papers

Important: Do NOT plan for sub-questions - they will get their own planning calls.

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

  // Convert new structure to legacy format for backward compatibility
  // New structure: {mainQuery: {steps: []}, subQuestions: [], sharedDocumentation: {}}
  // Legacy structure: {steps: [], ...}
  
  let steps: string[] = [];
  
  if (parsed.mainQuery && parsed.mainQuery.steps) {
    // New structure detected
    steps = Array.isArray(parsed.mainQuery.steps) 
      ? parsed.mainQuery.steps 
      : extractSteps(parsed.mainQuery, response);
  } else if (parsed.steps) {
    // Legacy structure
    steps = extractSteps(parsed, response);
  }

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
    // Store new structure if present (for future use)
    _rawPlan: parsed.mainQuery || parsed.subQuestions || parsed.sharedDocumentation ? parsed : undefined,
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
