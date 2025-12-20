/**
 * HCSP Evaluation (Hierarchical Constraint Satisfaction Protocol)
 * 
 * LLM-as-a-Judge for semantic evaluation.
 * Based on RGB (arxiv:2309.01431v2), RAGBench (arxiv:2407.11005v2).
 */

import { callLLM } from '../src/clients/llm.js';
import type { HCSPMetrics, BenchmarkSummary, EvaluationResult } from './types.js';

/**
 * Evaluate a synthesis against HCSP metrics using LLM-as-a-Judge
 */
export async function evaluateHCSP(
  output: string,
  constraints: string[],
  judgeApiKey: string,
  judgeModel: string = 'gemini-2.5-flash-lite'
): Promise<HCSPMetrics> {
  const prompt = buildHCSPPrompt(output, constraints);
  
  try {
    const judgeResponse = await callLLM(prompt, {
      provider: judgeModel.startsWith('gpt') ? 'openai' : 'gemini',
      model: judgeModel,
      apiKey: judgeApiKey,
      timeout: 30000,
      maxOutputTokens: 3000,
      temperature: 0.1,
    });
    
    return parseHCSPResponse(judgeResponse.content, constraints);
  } catch (error) {
    console.error('[HCSP] Evaluation failed:', error);
    return {
      ccr: 0,
      satisfiedConstraints: [],
      failedConstraints: constraints,
      citationFidelity: 0,
      verifiedClaims: 0,
      totalClaims: 0,
      specificityScore: 1,
      critiques: [{ type: 'CRITICAL_GAP', issue: `Evaluation error: ${error}` }],
      hasCriticalGap: true,
    };
  }
}

function buildHCSPPrompt(output: string, constraints: string[]): string {
  const constraintList = constraints.map((c, i) => `${i + 1}. ${c}`).join('\n');
  
  return `You are a RIGOROUS TECHNICAL AUDITOR using Hierarchical Constraint Satisfaction Protocol (HCSP).

**OUTPUT TO EVALUATE:**
${output.slice(0, 6000)}${output.length > 6000 ? '\n...[truncated]' : ''}

---

**CONSTRAINTS TO CHECK:**
${constraintList}

---

**YOUR TASK:**

1. **Constraint Coverage Ratio (CCR)**: For each constraint above, determine if it is satisfied.

2. **Citation Fidelity**: For each factual claim in the output, check if:
   - A citation is provided (e.g., [arxiv:id], [perplexity:N], [context7:lib])
   - The citation appears to be from a legitimate source context

3. **Specificity Score (1-5)**:
   - 1: Vague ("the system is fast")
   - 2: Somewhat specific ("response time is good")
   - 3: Moderately specific ("response time under 500ms")
   - 4: Specific ("response time 200ms p95 on M2 chip")
   - 5: Highly specific with context ("response time 45ms on H100 with FP8, measured via prometheus")

4. **Categorize Issues**: For any failures, categorize as:
   - CRITICAL_GAP: Logic errors, hallucinations, TODO/FIXME in code, undefined values
   - STYLISTIC_PREFERENCE: Tone, formatting, minor wording

Return ONLY valid JSON:
{
  "satisfied_constraints": [1, 3, 5],
  "failed_constraints": [2, 4],
  "verified_claims": 8,
  "total_claims": 10,
  "specificity_score": 4,
  "critiques": [
    {"type": "CRITICAL_GAP", "issue": "Code contains TODO placeholder"},
    {"type": "STYLISTIC_PREFERENCE", "issue": "Could use more examples"}
  ]
}`;
}

function parseHCSPResponse(response: string, constraints: string[]): HCSPMetrics {
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found');
    
    const parsed = JSON.parse(jsonMatch[0]);
    
    const satisfiedIndices = Array.isArray(parsed.satisfied_constraints) 
      ? parsed.satisfied_constraints : [];
    const failedIndices = Array.isArray(parsed.failed_constraints)
      ? parsed.failed_constraints : [];
    
    const satisfiedConstraints = satisfiedIndices
      .filter((i: number) => i >= 1 && i <= constraints.length)
      .map((i: number) => constraints[i - 1]);
    
    const failedConstraints = failedIndices
      .filter((i: number) => i >= 1 && i <= constraints.length)
      .map((i: number) => constraints[i - 1]);
    
    const ccr = constraints.length > 0 
      ? satisfiedConstraints.length / constraints.length 
      : 1;
    
    const critiques: HCSPMetrics['critiques'] = [];
    if (Array.isArray(parsed.critiques)) {
      for (const c of parsed.critiques) {
        if (c && typeof c.issue === 'string') {
          critiques.push({
            type: c.type === 'CRITICAL_GAP' ? 'CRITICAL_GAP' : 'STYLISTIC_PREFERENCE',
            issue: c.issue,
          });
        }
      }
    }
    
    const hasCriticalGap = critiques.some(c => c.type === 'CRITICAL_GAP');
    const verifiedClaims = typeof parsed.verified_claims === 'number' ? parsed.verified_claims : 0;
    const totalClaims = typeof parsed.total_claims === 'number' ? parsed.total_claims : 1;
    const citationFidelity = totalClaims > 0 ? verifiedClaims / totalClaims : 1;
    
    return {
      ccr,
      satisfiedConstraints,
      failedConstraints,
      citationFidelity,
      verifiedClaims,
      totalClaims,
      specificityScore: typeof parsed.specificity_score === 'number' ? parsed.specificity_score : 1,
      critiques,
      hasCriticalGap,
    };
  } catch (error) {
    return {
      ccr: 0,
      satisfiedConstraints: [],
      failedConstraints: constraints,
      citationFidelity: 0,
      verifiedClaims: 0,
      totalClaims: 0,
      specificityScore: 1,
      critiques: [{ type: 'CRITICAL_GAP', issue: `Parse error: ${error}` }],
      hasCriticalGap: true,
    };
  }
}

export function aggregateHCSPMetrics(results: EvaluationResult[]): BenchmarkSummary['hcspSummary'] {
  const hcspResults = results.filter(r => r.hcsp);
  
  if (hcspResults.length === 0) return undefined;
  
  const avgCCR = hcspResults.reduce((sum, r) => sum + (r.hcsp?.ccr || 0), 0) / hcspResults.length;
  const avgCitationFidelity = hcspResults.reduce((sum, r) => sum + (r.hcsp?.citationFidelity || 0), 0) / hcspResults.length;
  const avgSpecificityScore = hcspResults.reduce((sum, r) => sum + (r.hcsp?.specificityScore || 0), 0) / hcspResults.length;
  const criticalGapCount = hcspResults.reduce((sum, r) => 
    sum + (r.hcsp?.critiques.filter(c => c.type === 'CRITICAL_GAP').length || 0), 0);
  const samplesWithCriticalGaps = hcspResults.filter(r => r.hcsp?.hasCriticalGap).length;
  
  return { avgCCR, avgCitationFidelity, avgSpecificityScore, criticalGapCount, samplesWithCriticalGaps };
}

export function checkHCSPThresholds(summary: BenchmarkSummary['hcspSummary']): {
  ccr: boolean;
  citationFidelity: boolean;
  specificityScore: boolean;
  noCriticalGaps: boolean;
} {
  if (!summary) {
    return { ccr: false, citationFidelity: false, specificityScore: false, noCriticalGaps: false };
  }
  
  return {
    ccr: summary.avgCCR >= 0.90,
    citationFidelity: summary.avgCitationFidelity >= 0.95,
    specificityScore: summary.avgSpecificityScore >= 4.0,
    noCriticalGaps: summary.samplesWithCriticalGaps === 0,
  };
}

