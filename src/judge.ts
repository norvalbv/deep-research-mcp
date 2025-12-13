/**
 * LLM Judge for selecting the best research plan from multiple proposals
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { palChat } from './clients/pal.js';
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
  palClient: Client,
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
    const response = await palChat(palClient, judgePrompt, 'gemini-2.5-flash');
    const selectedIndex = parseJudgeResponse(response, proposals.length);

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

**Return JSON only:**
{
  "selected": <1-${proposals.length}>,
  "reasoning": "Why this plan is best"
}
`.trim();
}

function parseJudgeResponse(response: string, maxIndex: number): number {
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON');

    const parsed = JSON.parse(jsonMatch[0]);
    const selected = parseInt(parsed.selected, 10);

    if (selected >= 1 && selected <= maxIndex) {
      return selected - 1; // Convert to 0-indexed
    }
  } catch (error) {
    console.error('[Judge] Parse error:', error);
  }

  return 0; // Default to first plan
}









