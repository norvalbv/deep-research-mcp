/**
 * A/B Testing Comparison
 * 
 * Blind comparison between MCP and Perplexity using LLM-as-a-Judge.
 */

import { callLLM } from '../src/clients/llm.js';
import type { EvaluationSample } from './types.js';

export interface ComparisonResult {
  winner: 'system' | 'baseline' | 'tie';
  reasoning: string;
  systemScore: number;
  baselineScore: number;
}

/**
 * Compare system output vs baseline (Perplexity) using blind A/B test
 */
export async function compareWithBaseline(
  sample: EvaluationSample,
  systemResponse: string,
  baselineResponse: string,
  judgeApiKey: string,
  judgeModel: string = 'gemini-2.5-flash-lite'
): Promise<ComparisonResult> {
  // Randomize order to remove bias
  const systemFirst = Math.random() > 0.5;
  const [responseA, responseB] = systemFirst 
    ? [systemResponse, baselineResponse]
    : [baselineResponse, systemResponse];
  
  const prompt = `You are an expert research evaluator conducting a blind comparison.

**Query:** ${sample.query}

**Gold Standard:** ${sample.goldStandard.answer}

---

**Response A:**
${responseA}

---

**Response B:**
${responseB}

---

Compare these responses on:
1. Accuracy and completeness
2. Citation quality and verifiability
3. Reasoning depth
4. Practical utility

Return ONLY valid JSON:
{
  "winner": "A" | "B" | "tie",
  "response_a_score": <1-5>,
  "response_b_score": <1-5>,
  "reasoning": "<brief comparison>"
}`;

  try {
    const judgeResponse = await callLLM(prompt, {
      provider: judgeModel.startsWith('gpt') ? 'openai' : 'gemini',
      model: judgeModel,
      apiKey: judgeApiKey,
      timeout: 30000,
      temperature: 0.1,
    });
    
    const jsonMatch = judgeResponse.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');
    
    const parsed = JSON.parse(jsonMatch[0]);
    
    let winner: 'system' | 'baseline' | 'tie';
    if (parsed.winner === 'tie') {
      winner = 'tie';
    } else if ((parsed.winner === 'A') === systemFirst) {
      winner = 'system';
    } else {
      winner = 'baseline';
    }
    
    return {
      winner,
      reasoning: parsed.reasoning,
      systemScore: systemFirst ? parsed.response_a_score : parsed.response_b_score,
      baselineScore: systemFirst ? parsed.response_b_score : parsed.response_a_score,
    };
  } catch (error) {
    return {
      winner: 'tie',
      reasoning: `Error: ${error}`,
      systemScore: 0,
      baselineScore: 0,
    };
  }
}


