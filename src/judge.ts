/**
 * LLM Judge for selecting the best research plan from multiple proposals
 */

import { callLLM } from './clients/llm.js';
import { ResearchActionPlan } from './planning.js';

interface PlanningProposal {
  model: string;
  plan: ResearchActionPlan;
  confidence: number;
}

/**
 * Select the best plan using an LLM as judge
 */
export async function selectBestPlan(
  geminiKey: string,
  proposals: PlanningProposal[],
  query: string,
  enrichedContext?: string
): Promise<PlanningProposal> {
  if (proposals.length === 1) {
    return proposals[0];
  }

  console.error(`[Judge] Evaluating ${proposals.length} plans...`);

  const judgePrompt = buildJudgePrompt(query, proposals, enrichedContext);

  try {
    const response = await callLLM(judgePrompt, {
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      apiKey: geminiKey
    });
    const selectedIndex = parseJudgeResponse(response.content, proposals.length);

    console.error(`[Judge] Selected plan ${selectedIndex + 1} from ${proposals[selectedIndex].model}`);
    return proposals[selectedIndex];
  } catch (error) {
    console.error('[Judge] LLM judge failed, falling back to confidence:', error);
    // Fallback: sort by confidence
    proposals.sort((a, b) => b.confidence - a.confidence);
    return proposals[0];
  }
}

function buildJudgePrompt(query: string, proposals: PlanningProposal[], enrichedContext?: string): string {
  const plansDescription = proposals
    .map((p, i) => `
**Plan ${i + 1}** (from ${p.model}, confidence: ${p.confidence.toFixed(2)}):
- Complexity: ${p.plan.complexity}/5
- Reasoning: ${p.plan.reasoning}
- Steps: ${p.plan.steps.join(' → ')}
- Tools to skip: ${p.plan.toolsToSkip.length > 0 ? p.plan.toolsToSkip.join(', ') : 'none'}
`)
    .join('\n');

  return `
You are a research planning judge. Select the BEST plan for answering this query.

**Original Query:** ${query}

${enrichedContext ? `Context:\n${enrichedContext}\n` : ''}

**Candidate Plans:**
${plansDescription}

**Evaluation Criteria:**
1. **Appropriateness**: Does the complexity match the query difficulty?
2. **Efficiency**: Does it avoid unnecessary steps while being thorough?
3. **Coverage**: Will it gather sufficient information?
4. **Practicality**: Is the step sequence logical?

IMPORTANT: Return ONLY valid JSON with no other text. No markdown code blocks, no explanation.

Format:
{
  "selected": <1-${proposals.length}>,
  "reasoning": "Why this plan is best"
}`.trim();
}

function parseJudgeResponse(response: string, maxIndex: number): number {
  try {
    // Remove markdown code blocks if present
    let cleaned = response.replace(/```json\s*/g, '').replace(/```\s*/g, '');
    
    // Try to find JSON
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found in response');

    const parsed = JSON.parse(jsonMatch[0]);
    const selected = parseInt(parsed.selected, 10);

    if (selected >= 1 && selected <= maxIndex) {
      return selected - 1; // Convert to 0-indexed
    }
    
    throw new Error(`Selected ${selected} is out of range (1-${maxIndex})`);
  } catch (error) {
    console.error('[Judge] Parse error:', error);
  }

  // Fallback to first plan
  return 0;
}









