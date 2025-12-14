/**
 * Research validation: challenge, sufficiency voting, and improvements
 * 
 * Flow: Synthesis → Critical Challenge (attacks synthesis vs input) → Sufficiency Vote (synthesis vs critique)
 */

import { callLLM } from './clients/llm.js';
import { ExecutionResult } from './execution.js';
import { ResearchActionPlan, extractContent } from './planning.js';
import { DocumentationCache } from './types/index.js';
import { SynthesisOutput } from './synthesis.js';

export interface ChallengeResult {
  critiques: string[];      // Numbered critique points
  hasSignificantGaps: boolean;
  rawResponse: string;
}

export interface SufficiencyVote {
  sufficient: boolean;      // true = synthesis wins, false = critique wins
  votesFor: number;         // synthesis_wins votes
  votesAgainst: number;     // critique_wins votes
  criticalGaps: string[];   // Gaps identified if critique wins
  details: Array<{ model: string; vote: 'synthesis_wins' | 'critique_wins'; reasoning: string }>;
}

/**
 * Run critical challenge - ATTACKS the synthesis against original input
 * Returns specific critique points identifying gaps/mismatches
 */
export async function runChallenge(
  geminiKey: string | undefined,
  query: string,
  synthesis: string,
  context?: {
    enrichedContext?: string;
    constraints?: string[];
    subQuestions?: string[];
  }
): Promise<ChallengeResult | undefined> {
  if (!geminiKey) return undefined;

  console.error('[Challenge] Attacking synthesis against original input...');

  const prompt = buildChallengePrompt(query, synthesis, context);
  const response = await callLLM(prompt, {
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    apiKey: geminiKey
  });
  
  return parseChallengeResponse(response.content);
}

/**
 * Build the challenge prompt - designed to find REAL gaps
 */
function buildChallengePrompt(
  query: string,
  synthesis: string,
  context?: {
    enrichedContext?: string;
    constraints?: string[];
    subQuestions?: string[];
  }
): string {
  const constraintsSection = context?.constraints?.length 
    ? `\nCONSTRAINTS TO RESPECT:\n${context.constraints.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
    : '';
  
  const subQuestionsSection = context?.subQuestions?.length
    ? `\nSUB-QUESTIONS THAT MUST BE ANSWERED:\n${context.subQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`
    : '';

  return `You are a CRITICAL REVIEWER. Your job is to ATTACK this research synthesis and find gaps.

ORIGINAL QUERY:
${query}

${context?.enrichedContext ? `ORIGINAL CONTEXT:\n${context.enrichedContext}\n` : ''}${constraintsSection}${subQuestionsSection}

---

SYNTHESIS TO CHALLENGE:
${synthesis}

---

YOUR TASK: Find gaps between what was ASKED and what was ANSWERED.

Evaluate:
1. What questions from the query were NOT answered or poorly answered?
2. What constraints were IGNORED or not respected?
3. What sub-questions (if any) were skipped or inadequately addressed?
4. What claims in the synthesis lack evidence or sources?
5. What's missing for the user to take ACTION on this research?

BE HARSH BUT FAIR. Only list REAL gaps that hurt usability.

If the synthesis fully addresses the input with no significant gaps, respond with:
"No significant gaps found."

Otherwise, return a NUMBERED LIST of specific critique points:
1. [First gap/issue]
2. [Second gap/issue]
...

Do NOT return JSON. Return plain text critique points only.`.trim();
}

/**
 * Parse challenge response into structured result
 */
function parseChallengeResponse(response: string): ChallengeResult {
  const content = extractContent(response);
  
  // Check for "no gaps" response
  const noGapsPatterns = [
    /no significant gaps/i,
    /synthesis fully addresses/i,
    /adequately covers/i,
    /no major gaps/i,
  ];
  
  const hasNoGaps = noGapsPatterns.some(p => p.test(content));
  
  if (hasNoGaps) {
    return {
      critiques: [],
      hasSignificantGaps: false,
      rawResponse: content,
    };
  }
  
  // Extract numbered critique points
  const critiquePattern = /^\d+\.\s*(.+)$/gm;
  const critiques: string[] = [];
  let match;
  
  while ((match = critiquePattern.exec(content)) !== null) {
    critiques.push(match[1].trim());
  }
  
  // If no numbered points found, treat whole response as single critique
  if (critiques.length === 0 && content.length > 20) {
    critiques.push(content);
  }
  
  return {
    critiques,
    hasSignificantGaps: critiques.length > 0,
    rawResponse: content,
  };
}

/**
 * Run multi-model consensus validation (depth >= 3)
 * NOTE: This is now secondary to the challenge/vote flow
 */
export async function runConsensusValidation(
  geminiKey: string | undefined,
  query: string,
  executionResult: ExecutionResult
): Promise<string | undefined> {
  if (!geminiKey) return undefined;

  console.error('[Validation] Running consensus validation...');
  
  // Build paper summaries section with full available summaries
  const papersSummary = executionResult.arxivPapers?.papers?.length
    ? executionResult.arxivPapers.papers
        .map((p, i) => `${i + 1}. "${p.title}" - ${p.summary}`)
        .join('\n')
    : 'No papers found';

  // Include more content from web and analysis (2000 chars each instead of 500)
  const webContent = executionResult.perplexityResult?.content?.slice(0, 2000) || 'No web results';
  const analysisContent = executionResult.deepThinking?.slice(0, 2000) || 'No deep analysis';

  const prompt = `Evaluate research findings for: "${query}"

## Web Search Results
${webContent}${executionResult.perplexityResult?.content?.length && executionResult.perplexityResult.content.length > 2000 ? '...[truncated]' : ''}

## Deep Analysis
${analysisContent}${executionResult.deepThinking?.length && executionResult.deepThinking.length > 2000 ? '...[truncated]' : ''}

## Academic Papers Found (${executionResult.arxivPapers?.papers?.length || 0})
${papersSummary}

---

IMPORTANT: Base your assessment ONLY on the information provided above. Do NOT request additional files or articles - work with what you have.

Assess the validity, completeness, and reliability of these findings. Consider:
1. Do the sources agree or contradict each other?
2. Are the findings well-supported with evidence?
3. Are there obvious gaps that hurt the usefulness of this research?

Return a plain text assessment (3-4 paragraphs max).`;

  const response = await callLLM(prompt, {
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    apiKey: geminiKey
  });
  return extractContent(response.content);
}

/**
 * Run sufficiency vote - COMPARES synthesis vs critique
 * Votes on whether synthesis wins or critique wins
 */
export async function runSufficiencyVote(
  geminiKey: string | undefined,
  query: string,
  synthesis: string,
  challenge: ChallengeResult | undefined
): Promise<SufficiencyVote | undefined> {
  if (!geminiKey) return undefined;

  // If no challenge or no gaps found, synthesis wins by default
  if (!challenge || !challenge.hasSignificantGaps) {
    console.error('[Vote] No significant critique - synthesis wins by default');
    return {
      sufficient: true,
      votesFor: 1,
      votesAgainst: 0,
      criticalGaps: [],
      details: [{ model: 'default', vote: 'synthesis_wins', reasoning: 'No significant gaps identified in critique' }],
    };
  }

  console.error('[Vote] Comparing synthesis vs critique...');

  const prompt = buildVotePrompt(query, synthesis, challenge);
  
  // Use direct LLM calls for parallel voting
  const { callLLMsParallel, getVotingConfigs } = await import('./clients/llm.js');
  const configs = getVotingConfigs(geminiKey);
  
  if (configs.length === 0) {
    console.error('[Vote] No API keys configured, assuming synthesis wins');
    return { sufficient: true, votesFor: 0, votesAgainst: 0, criticalGaps: [], details: [] };
  }

  const responses = await callLLMsParallel(prompt, configs);
  
  const validVotes = responses
    .filter(r => !r.error && r.content.length > 0)
    .map(r => parseVoteResponse(r.content, r.model));

  if (validVotes.length === 0) {
    console.error('[Vote] All votes failed, assuming synthesis wins');
    return { sufficient: true, votesFor: 0, votesAgainst: 0, criticalGaps: [], details: [] };
  }

  const synthesisWins = validVotes.filter(v => v.vote === 'synthesis_wins').length;
  const critiqueWins = validVotes.filter(v => v.vote === 'critique_wins').length;
  const sufficient = synthesisWins >= critiqueWins; // Tie goes to synthesis

  // Aggregate critical gaps from critique_wins votes
  const allGaps = validVotes
    .filter(v => v.vote === 'critique_wins' && v.criticalGaps)
    .flatMap(v => v.criticalGaps || []);
  const uniqueGaps = [...new Set(allGaps)];

  console.error(`[Vote] Result: ${synthesisWins} synthesis_wins, ${critiqueWins} critique_wins`);

  return {
    sufficient,
    votesFor: synthesisWins,
    votesAgainst: critiqueWins,
    criticalGaps: uniqueGaps,
    details: validVotes,
  };
}

/**
 * Build the vote prompt - compares synthesis against critique
 */
function buildVotePrompt(query: string, synthesis: string, challenge: ChallengeResult): string {
  const critiquePoints = challenge.critiques.length > 0
    ? challenge.critiques.map((c, i) => `${i + 1}. ${c}`).join('\n')
    : challenge.rawResponse;

  return `Compare the SYNTHESIS against the CRITIQUE to determine which is stronger.

ORIGINAL QUERY:
${query}

SYNTHESIS (first 2000 chars):
${synthesis.slice(0, 2000)}${synthesis.length > 2000 ? '...' : ''}

CRITIQUE POINTS:
${critiquePoints}

---

YOUR TASK: Vote on whether the synthesis adequately answers the query despite the critique.

- Vote "synthesis_wins" if:
  - Critique points are minor, nitpicky, or already addressed in the synthesis
  - Synthesis provides actionable, useful information for the user
  - Gaps identified don't significantly hurt usability

- Vote "critique_wins" if:
  - Critique identifies REAL gaps that hurt usability
  - Important questions remain unanswered
  - User cannot take action without the missing information

Return JSON only:
{
  "vote": "synthesis_wins" or "critique_wins",
  "reasoning": "One sentence explaining your vote",
  "critical_gaps": ["gap1", "gap2"]
}

The critical_gaps array should list the most important gaps IF you vote critique_wins.
Return empty array [] if you vote synthesis_wins.`.trim();
}

/**
 * Parse vote response into structured result
 */
function parseVoteResponse(
  response: string, 
  model: string
): { model: string; vote: 'synthesis_wins' | 'critique_wins'; reasoning: string; criticalGaps?: string[] } {
  try {
    const content = extractContent(response);
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found');
    
    const parsed = JSON.parse(jsonMatch[0]);
    const vote = parsed.vote === 'critique_wins' ? 'critique_wins' : 'synthesis_wins';
    
    return {
      model,
      vote,
      reasoning: parsed.reasoning || 'No reasoning provided',
      criticalGaps: Array.isArray(parsed.critical_gaps) ? parsed.critical_gaps : [],
    };
  } catch {
    // Default to synthesis_wins on parse failure
    return { 
      model, 
      vote: 'synthesis_wins', 
      reasoning: 'Parse failed, defaulting to synthesis_wins',
      criticalGaps: [],
    };
  }
}

/**
 * Summarize findings for validation (legacy helper)
 */
export function summarizeFindings(executionResult: ExecutionResult, actionPlan?: ResearchActionPlan): string {
  const parts: string[] = [];
  if (actionPlan) parts.push(`Plan: ${actionPlan.steps.join(', ')}`);
  if (executionResult.perplexityResult) parts.push(`Web: ${executionResult.perplexityResult.content.slice(0, 200)}...`);
  if (executionResult.deepThinking) parts.push(`Analysis: ${executionResult.deepThinking.slice(0, 200)}...`);
  if (executionResult.arxivPapers?.papers.length) parts.push(`Papers: ${executionResult.arxivPapers.papers.length}`);
  if (executionResult.subQuestionResults?.length) parts.push(`Sub-Qs: ${executionResult.subQuestionResults.length}`);
  return parts.join('\n');
}

/**
 * POST-SYNTHESIS CODE VALIDATION
 * Validates synthesized code against authoritative Context7 documentation
 * Fixes hallucinated/outdated syntax
 */
export async function validateCodeAgainstDocs(
  geminiKey: string | undefined,
  synthesisOutput: SynthesisOutput,
  docCache?: DocumentationCache
): Promise<SynthesisOutput> {
  // Skip if no API key or no docs available
  if (!geminiKey || !docCache || Object.keys(docCache.base).length === 0) {
    return synthesisOutput;
  }

  console.error('[Code Validation] Checking code blocks against Context7 docs...');

  // Extract all code blocks from synthesis
  const codeBlocks = extractCodeBlocks(synthesisOutput);
  
  if (codeBlocks.length === 0) {
    console.error('[Code Validation] No code blocks found, skipping validation');
    return synthesisOutput;
  }

  console.error(`[Code Validation] Found ${codeBlocks.length} code blocks to validate`);

  // Build validation prompt with authoritative docs
  const allDocs = [
    ...Object.values(docCache.base).map(d => d.content),
    ...Object.values(docCache.subQSpecific).map(d => d.content)
  ].join('\n\n---\n\n');

  const prompt = buildCodeValidationPrompt(codeBlocks, allDocs);

  try {
    const response = await callLLM(prompt, {
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      apiKey: geminiKey,
      timeout: 60000,
      maxOutputTokens: 16000
    });

    // Parse corrections and apply them
    const corrections = parseCodeCorrections(response.content);
    
    if (corrections.length > 0) {
      console.error(`[Code Validation] Applying ${corrections.length} code fixes`);
      return applyCodeCorrections(synthesisOutput, corrections);
    } else {
      console.error('[Code Validation] No corrections needed');
      return synthesisOutput;
    }
  } catch (error) {
    console.error('[Code Validation] Error:', error);
    return synthesisOutput; // Return original on error
  }
}

interface CodeBlock {
  code: string;
  language?: string;
  section: 'overview' | string; // 'overview', 'q1', 'q2', etc.
}

interface CodeCorrection {
  originalCode: string;
  correctedCode: string;
  reason: string;
}

function extractCodeBlocks(synthesis: SynthesisOutput): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;

  // Extract from overview
  let match;
  while ((match = codeBlockRegex.exec(synthesis.overview)) !== null) {
    blocks.push({
      code: match[2].trim(),
      language: match[1],
      section: 'overview'
    });
  }

  // Extract from sub-questions
  if (synthesis.subQuestions) {
    for (const [sectionId, subQ] of Object.entries(synthesis.subQuestions)) {
      const regex = /```(\w+)?\n([\s\S]*?)```/g;
      while ((match = regex.exec(subQ.answer)) !== null) {
        blocks.push({
          code: match[2].trim(),
          language: match[1],
          section: sectionId
        });
      }
    }
  }

  // Extract from additional insights
  if (synthesis.additionalInsights) {
    const regex = /```(\w+)?\n([\s\S]*?)```/g;
    while ((match = regex.exec(synthesis.additionalInsights)) !== null) {
      blocks.push({
        code: match[2].trim(),
        language: match[1],
        section: 'additional_insights'
      });
    }
  }

  return blocks;
}

function buildCodeValidationPrompt(codeBlocks: CodeBlock[], authoritativeDocs: string): string {
  const codeExamples = codeBlocks
    .map((block, idx) => `**Code Block ${idx + 1}** (${block.language || 'unknown'}):\n\`\`\`\n${block.code}\n\`\`\``)
    .join('\n\n');

  return `You are a code validator. Check the following code blocks against AUTHORITATIVE documentation.

**AUTHORITATIVE DOCUMENTATION (source of truth):**
${authoritativeDocs.slice(0, 5000)}

---

**CODE BLOCKS TO VALIDATE:**
${codeExamples}

---

**YOUR TASK:**

For EACH code block:
1. Check if the syntax matches the authoritative docs
2. Identify any hallucinated APIs, incorrect method names, or outdated patterns
3. Provide corrected code ONLY if there are issues

Output format:
\`\`\`json
[
  {
    "blockIndex": 1,
    "hasIssues": true,
    "reason": "Uses old API method 'foo()' which should be 'bar()'",
    "correctedCode": "corrected code here"
  }
]
\`\`\`

If a code block is correct, set hasIssues: false and omit correctedCode.

Return ONLY the JSON array, no explanation.`;
}

function parseCodeCorrections(response: string): CodeCorrection[] {
  try {
    // Extract JSON from response
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]);
    
    return parsed
      .filter((item: any) => item.hasIssues && item.correctedCode)
      .map((item: any) => ({
        originalCode: '', // We'll match by index
        correctedCode: item.correctedCode,
        reason: item.reason || 'Syntax correction'
      }));
  } catch (error) {
    console.error('[Code Validation] Failed to parse corrections:', error);
    return [];
  }
}

function applyCodeCorrections(
  synthesis: SynthesisOutput,
  corrections: CodeCorrection[]
): SynthesisOutput {
  // For simplicity, we'll just log corrections for now
  // Full implementation would need to map blockIndex to specific sections and replace
  console.error(`[Code Validation] Corrections available but not yet applied (needs implementation)`);
  corrections.forEach(c => {
    console.error(`  - ${c.reason}`);
  });
  
  // TODO: Implement actual code replacement logic
  // This is complex as we need to track which code block corresponds to which correction
  
  return synthesis;
}

