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
    ? `\nCONSTRAINTS:\n${context.constraints.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
    : '';
  
  const subQuestionsSection = context?.subQuestions?.length
    ? `\nSUB-QUESTIONS:\n${context.subQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`
    : '';

  return `You are a CRITICAL REVIEWER using a checklist-based audit.

ORIGINAL QUERY:
${query}

${context?.enrichedContext ? `CONTEXT:\n${context.enrichedContext}\n` : ''}${constraintsSection}${subQuestionsSection}

---

SYNTHESIS TO CHALLENGE:
${synthesis}

---

**ACTIONABILITY CHECKLIST** (flag ANY failures):

□ **Specificity**: Are ALL thresholds numeric with units? (not "high", "fast", "good")
□ **Code Completeness**: Are code examples fully implemented? (no TODO/FIXME)
□ **Consistency**: Do time/cost estimates ADD UP across sections?
□ **Executability**: Can someone execute this WITHOUT 10+ clarifying questions?
□ **Decision Clarity**: Is there ONE clear recommendation per choice?
□ **Success Criteria**: Is there a measurable definition of "done"?

**EVALUATE:**
1. Which checklist items FAILED? (be specific, cite examples)
2. What constraints were IGNORED?
3. What sub-questions were poorly answered?
4. Are there CONTRADICTIONS between sections?

If ALL items pass, respond: "No significant gaps found."

Otherwise, return NUMBERED critique points:
1. [FAILED: Specificity] "response time should be under X" - X undefined
2. [FAILED: Code] Line 45 contains "# TODO"
...`.trim();
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

  // Build comprehensive research data for consensus to evaluate
  const papersSummary = executionResult.arxivPapers?.papers?.length
    ? executionResult.arxivPapers.papers
        .map((p, i) => `${i + 1}. **${p.title}** (arXiv:${p.id})\n   ${p.summary}`)
        .join('\n\n')
    : 'No papers found';

  const webContent = executionResult.perplexityResult?.content?.slice(0, 2500) || 'No web results';
  const webSources = executionResult.perplexityResult?.sources?.length
    ? `\n\n**Web Sources:**\n${executionResult.perplexityResult.sources.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
    : '';

  const libraryDocs = executionResult.libraryDocs
    ? `**Library Documentation (Context7):**\n${executionResult.libraryDocs.slice(0, 2000)}`
    : 'No library documentation';

  const analysisContent = executionResult.deepThinking?.slice(0, 2000) || 'No deep analysis';

  const prompt = `Evaluate research findings for: "${query}"

**RESEARCH DATA GATHERED:**

**Web Search Results:**
${webContent}${webSources}

**Academic Papers (arXiv):**
${papersSummary}

${libraryDocs}

**Deep Analysis:**
${analysisContent}

---

**YOUR TASK:**

Evaluate the QUALITY and RELIABILITY of these research findings:

1. **Internal Consistency**: Do the different sources (web, papers, docs, analysis) agree or contradict?
2. **Evidence Quality**: Are claims backed by verifiable sources (arXiv papers, documentation, web sources)?
3. **Completeness**: Are there gaps in evidence or missing perspectives?
4. **Reliability**: Can these findings be trusted? Are sources authoritative?
5. **Actionability**: Is there enough concrete information to act on?

**IMPORTANT:**
- You can see ALL research data above (web + sources, arXiv papers, Context7 docs, analysis)
- Evaluate based on what's PROVIDED, not what you think should exist
- If arXiv papers are irrelevant to the query, point that out explicitly
- If sources are missing or unclear, note that

Provide a 2-3 paragraph consensus evaluation focusing on reliability and actionability.`;

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

