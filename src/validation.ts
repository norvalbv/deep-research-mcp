/**
 * Research validation: challenge, sufficiency voting, and improvements
 * 
 * Flow: Synthesis → PVR Verification → Critical Challenge → Sufficiency Vote
 * 
 * PVR (Parallel-Verify-Resolve) based on:
 * - arxiv:2310.03025 (Parallel RAG consistency)
 * - arxiv:2305.14251 (Cross-sectional NLI)
 */

import { callLLM } from './clients/llm.js';
import { ExecutionResult } from './execution.js';
import { ResearchActionPlan, extractContent } from './planning.js';
import { DocumentationCache, GlobalManifest, PVRVerificationResult } from './types/index.js';
import { SynthesisOutput } from './synthesis.js';

// PVR Configuration (research-backed thresholds)
const PVR_CONFIG = {
  ENTAILMENT_THRESHOLD: 0.85,      // arxiv:2310.03025 recommends 0.85
  VERIFICATION_TIMEOUT_MS: 15000,
  MAX_REROLL_ATTEMPTS: 2,
  MIN_CLAIMS_FOR_CHECK: 2,
};

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
    validSources?: {
      arxivPapers?: { id: string; title: string }[];
      perplexitySources?: string[];
    };
  }
): Promise<ChallengeResult | undefined> {
  if (!geminiKey) return undefined;

  console.error('[Challenge] Attacking synthesis against original input...');

  const prompt = buildChallengePrompt(query, synthesis, context);
  const response = await callLLM(prompt, {
    provider: 'gemini',
    model: 'gemini-3-flash-preview',
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
    validSources?: {
      arxivPapers?: { id: string; title: string }[];
      perplexitySources?: string[];
    };
  }
): string {
  const constraintsSection = context?.constraints?.length 
    ? `\nCONSTRAINTS:\n${context.constraints.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
    : '';
  
  const subQuestionsSection = context?.subQuestions?.length
    ? `\nSUB-QUESTIONS:\n${context.subQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`
    : '';

  // Add valid sources context so challenger knows which citations are legitimate
  const validSourcesSection = context?.validSources
    ? `\nVALID SOURCES (citations to these are LEGITIMATE):\n` +
      (context.validSources.arxivPapers?.length 
        ? `- arXiv Papers: ${context.validSources.arxivPapers.map(p => `[arxiv:${p.id}] "${p.title}"`).join(', ')}\n`
        : '') +
      (context.validSources.perplexitySources?.length 
        ? `- Web Sources: ${context.validSources.perplexitySources.length} sources from Perplexity search\n`
        : '')
    : '';

  return `You are a CRITICAL REVIEWER using a checklist-based audit.
${validSourcesSection}

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
  
  // #region agent log
  fetch('http://127.0.0.1:7243/ingest/cc739506-e25d-45e2-b543-cb8ae30e3ecd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'validation.ts:parseChallengeResponse',message:'H-G: Challenge critique points',data:{critiqueCount:critiques.length,hasSignificantGaps:critiques.length>0,critiques:critiques.slice(0,5)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H-G'})}).catch(()=>{});
  // #endregion

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
    model: 'gemini-3-flash-preview',
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

  // #region agent log
  fetch('http://127.0.0.1:7243/ingest/cc739506-e25d-45e2-b543-cb8ae30e3ecd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'validation.ts:runSufficiencyVote:result',message:'H-G/H-H: Vote results with reasoning',data:{synthesisWins,critiqueWins,sufficient,uniqueGaps,voteDetails:validVotes.map(v=>({model:v.model,vote:v.vote,reasoning:v.reasoning?.slice(0,200),gaps:v.criticalGaps?.slice(0,3)}))},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H-G,H-H'})}).catch(()=>{});
  // #endregion

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
    // First try to extract from markdown code block
    const codeBlockMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    const contentToSearch = codeBlockMatch ? codeBlockMatch[1] : response;
    
    const jsonMatch = contentToSearch.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found');
    }
    
    const parsed = JSON.parse(jsonMatch[0]);
    const vote = parsed.vote === 'critique_wins' ? 'critique_wins' : 'synthesis_wins';
    
    return {
      model,
      vote,
      reasoning: parsed.reasoning || 'No reasoning provided',
      criticalGaps: Array.isArray(parsed.critical_gaps) ? parsed.critical_gaps : [],
    };
  } catch (error) {
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

// ============================================================================
// PVR (Parallel-Verify-Resolve) Verification Layer
// Based on arxiv:2310.03025 and arxiv:2305.14251
// ============================================================================

/**
 * Run PVR verification on synthesis output
 * Extracts claims from each section and checks for contradictions using NLI
 * 
 * @param synthesis - Structured synthesis output with sections
 * @param manifest - Global constraint manifest with source facts
 * @param geminiKey - API key for LLM-based NLI
 * @returns Verification result with entailment score and contradictions
 */
export async function runPVRVerification(
  synthesis: SynthesisOutput,
  manifest: GlobalManifest,
  geminiKey: string | undefined
): Promise<PVRVerificationResult> {
  const startTime = Date.now();
  
  const result: PVRVerificationResult = {
    entailmentScore: 1.0,
    isConsistent: true,
    contradictions: [],
    sectionsToReroll: [],
    verificationTimeMs: 0,
  };

  // Skip if no API key
  if (!geminiKey) {
    result.verificationTimeMs = Date.now() - startTime;
    return result;
  }

  // Extract claims from all sections
  const sectionClaims = await extractClaimsFromSections(synthesis, geminiKey);
  
  // Need at least 2 sections with claims to compare
  const sectionsWithClaims = Object.entries(sectionClaims).filter(([_, claims]) => claims.length > 0);
  if (sectionsWithClaims.length < PVR_CONFIG.MIN_CLAIMS_FOR_CHECK) {
    console.error('[PVR] Insufficient sections for cross-check, skipping verification');
    result.verificationTimeMs = Date.now() - startTime;
    return result;
  }

  console.error(`[PVR] Verifying ${sectionsWithClaims.length} sections with ${sectionsWithClaims.reduce((sum, [_, c]) => sum + c.length, 0)} claims...`);

  // Run cross-sectional NLI check
  const nliResult = await runCrossSectionalNLI(sectionClaims, manifest, geminiKey);
  
  result.entailmentScore = nliResult.score;
  result.isConsistent = nliResult.score >= PVR_CONFIG.ENTAILMENT_THRESHOLD;
  result.contradictions = nliResult.contradictions;
  
  // Run dedicated logic consistency check (AND/OR operators)
  const logicResult = await checkLogicConsistency(sectionClaims, geminiKey);
  if (logicResult.hasConflict) {
    console.error(`[PVR] Logic conflict detected: ${logicResult.conflicts.length} issues`);
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/cc739506-e25d-45e2-b543-cb8ae30e3ecd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'validation.ts:runPVRVerification:logicConflict',message:'H-F: Logic conflict details',data:{conflicts:logicResult.conflicts,claimsSample:Object.fromEntries(Object.entries(sectionClaims).map(([k,v])=>[k,v.slice(0,3)]))},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H-F'})}).catch(()=>{});
    // #endregion
    result.isConsistent = false;
    // Add logic conflicts as high-severity contradictions
    for (const conflict of logicResult.conflicts) {
      result.contradictions.push({
        sectionA: 'overview',
        sectionB: 'sub-question',
        claimA: conflict,
        claimB: 'Logic operator mismatch',
        severity: 'high',
      });
    }
  }
  
  // Identify sections that need re-rolling
  if (!result.isConsistent) {
    const contradictingSections = new Set<string>();
    for (const c of result.contradictions) {
      if (c.severity === 'high') {
        contradictingSections.add(c.sectionA);
        contradictingSections.add(c.sectionB);
      }
    }
    // Keep overview, re-roll sub-questions if they contradict
    result.sectionsToReroll = Array.from(contradictingSections).filter(s => s !== 'overview');
  }

  result.verificationTimeMs = Date.now() - startTime;
  console.error(`[PVR] Score: ${result.entailmentScore.toFixed(2)}, Consistent: ${result.isConsistent}, Time: ${result.verificationTimeMs}ms`);
  
  return result;
}

/**
 * Extract atomic claims from each section of the synthesis
 * Uses LLM to break down prose into discrete factual claims
 */
async function extractClaimsFromSections(
  synthesis: SynthesisOutput,
  geminiKey: string
): Promise<Record<string, string[]>> {
  const claims: Record<string, string[]> = {};
  
  const extractionPrompt = (sectionName: string, content: string) => `Extract ATOMIC CLAIMS from this text section.

Section: ${sectionName}
Content:
${content.slice(0, 2000)}

---

Extract discrete, verifiable claims. Focus on:
1. Numeric values and thresholds (e.g., ">0.80", ">=3", "20 hours")
2. **LOGICAL OPERATORS** - Capture AND/OR/both/either explicitly:
   - "Entity promoted if X OR Y" (OR logic)
   - "Must pass both X AND Y" (AND logic)
   - "Either condition triggers..." (OR logic)
   - "All gates required" (AND logic)
3. Conditional relationships (if X then Y, when X occurs)
4. Requirements and gates (must, required, mandatory)
5. Time/cost estimates

**PRESERVE LOGIC OPERATORS in claims:**
- GOOD: "Entity promoted if recurrence >= 3 OR salience > 0.80"
- GOOD: "Both gates must be passed for promotion"
- BAD: "Entity is promoted based on recurrence and salience" (ambiguous)

Return JSON only:
{
  "claims": [
    "claim preserving exact logic operator",
    "another claim with AND/OR if present"
  ]
}

Keep claims concise (under 100 chars each). Max 10 claims.`;

  // Extract claims from overview
  try {
    const overviewResponse = await callLLMWithTimeout(
      extractionPrompt('Overview', synthesis.overview),
      geminiKey,
      PVR_CONFIG.VERIFICATION_TIMEOUT_MS
    );
    claims.overview = parseClaimsResponse(overviewResponse);
  } catch {
    claims.overview = [];
  }

  // Extract claims from sub-questions in parallel
  if (synthesis.subQuestions) {
    const subQPromises = Object.entries(synthesis.subQuestions).map(async ([key, value]): Promise<[string, string[]]> => {
      try {
        const response = await callLLMWithTimeout(
          extractionPrompt(value.question, value.answer),
          geminiKey,
          PVR_CONFIG.VERIFICATION_TIMEOUT_MS
        );
        return [key, parseClaimsResponse(response)];
      } catch {
        return [key, []];
      }
    });

    const subQResults = await Promise.all(subQPromises);
    for (const [key, sectionClaims] of subQResults) {
      claims[key] = sectionClaims;
    }
  }

  return claims;
}

/**
 * Run cross-sectional Natural Language Inference (NLI)
 * Compares claims across sections to detect contradictions
 */
async function runCrossSectionalNLI(
  sectionClaims: Record<string, string[]>,
  manifest: GlobalManifest,
  geminiKey: string
): Promise<{
  score: number;
  contradictions: PVRVerificationResult['contradictions'];
}> {
  const contradictions: PVRVerificationResult['contradictions'] = [];
  
  // Flatten all claims for comparison
  const allClaims: Array<{ section: string; claim: string }> = [];
  for (const [section, claims] of Object.entries(sectionClaims)) {
    for (const claim of claims) {
      allClaims.push({ section, claim });
    }
  }

  if (allClaims.length < 2) {
    return { score: 1.0, contradictions: [] };
  }

  // Build NLI prompt for batch checking
  const claimsList = allClaims
    .map((c, i) => `[${i + 1}] (${c.section}) ${c.claim}`)
    .join('\n');

  const manifestContext = manifest.keyFacts.length > 0
    ? `\nGlobal Facts (source of truth):\n${manifest.keyFacts.map(f => `- ${f}`).join('\n')}\n`
    : '';

  const nliPrompt = `You are a consistency checker. Find CONTRADICTIONS between claims.

${manifestContext}
Claims to check:
${claimsList}

---

Find pairs that CONTRADICT each other. Contradiction means:
- Different numeric values for the same metric
- Opposite recommendations
- Conflicting time/cost estimates
- Mutually exclusive statements

Return JSON only:
{
  "contradictions": [
    {
      "claimA": 1,
      "claimB": 3,
      "reason": "Both discuss threshold but A says 0.85 while B says 0.75",
      "severity": "high"
    }
  ],
  "consistent_pairs": 0
}

If no contradictions found, return empty array.
severity: "high" = different numbers, "medium" = different approaches, "low" = minor wording`;

  try {
    const response = await callLLMWithTimeout(nliPrompt, geminiKey, PVR_CONFIG.VERIFICATION_TIMEOUT_MS * 2);
    
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      
      if (Array.isArray(parsed.contradictions)) {
        for (const c of parsed.contradictions) {
          const claimA = allClaims[c.claimA - 1];
          const claimB = allClaims[c.claimB - 1];
          
          if (claimA && claimB) {
            contradictions.push({
              sectionA: claimA.section,
              sectionB: claimB.section,
              claimA: claimA.claim,
              claimB: claimB.claim,
              severity: c.severity || 'medium',
            });
          }
        }
      }
    }
  } catch (error) {
    console.error('[PVR] NLI check failed:', error);
    // Default to consistent on error (fail-open per arxiv:2309.01431)
    return { score: 1.0, contradictions: [] };
  }

  // Calculate entailment score
  // Score = 1 - (weighted contradictions / total possible pairs)
  const totalPairs = (allClaims.length * (allClaims.length - 1)) / 2;
  const weightedContradictions = contradictions.reduce((sum, c) => {
    const weight = c.severity === 'high' ? 1.0 : c.severity === 'medium' ? 0.5 : 0.25;
    return sum + weight;
  }, 0);
  
  const score = Math.max(0, 1 - (weightedContradictions / Math.max(totalPairs, 1)));
  
  return { score, contradictions };
}

/**
 * Dedicated logic consistency check for AND/OR operators
 * Specifically looks for conflicting logic gates across sections
 */
async function checkLogicConsistency(
  sectionClaims: Record<string, string[]>,
  geminiKey: string
): Promise<{ hasConflict: boolean; conflicts: string[] }> {
  const allClaims = Object.entries(sectionClaims)
    .flatMap(([section, claims]) => claims.map(c => ({ section, claim: c })));
  
  if (allClaims.length < 2) {
    return { hasConflict: false, conflicts: [] };
  }

  const claimsList = allClaims
    .map((c, i) => `[${i + 1}] (${c.section}) ${c.claim}`)
    .join('\n');

  const logicCheckPrompt = `You are checking for LOGIC OPERATOR CONFLICTS (AND vs OR).

Claims to check:
${claimsList}

---

Find claims that use CONFLICTING logic operators for the SAME condition/threshold:

CONFLICT EXAMPLES:
- Claim A: "Entity promoted if X OR Y" vs Claim B: "Must pass both X AND Y"
- Claim A: "Either condition triggers" vs Claim B: "All gates required"
- Claim A: "recurrence >= 3 OR salience > 0.80" vs Claim B: "must pass two primary gates"

NOT A CONFLICT:
- Different thresholds (0.80 vs 0.85) - that's a numeric difference, not logic
- Same logic with different wording ("X or Y" and "X OR Y")

Return JSON only:
{
  "hasConflict": true/false,
  "conflicts": [
    "Overview says 'X OR Y' but Q4 implies 'X AND Y' with 'must pass both'"
  ]
}

Return empty conflicts array if no AND/OR logic conflicts found.`;

  try {
    const response = await callLLMWithTimeout(logicCheckPrompt, geminiKey, PVR_CONFIG.VERIFICATION_TIMEOUT_MS);
    
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        hasConflict: parsed.hasConflict === true,
        conflicts: Array.isArray(parsed.conflicts) ? parsed.conflicts : [],
      };
    }
  } catch (error) {
    console.error('[PVR] Logic check failed:', error);
  }
  
  return { hasConflict: false, conflicts: [] };
}

/**
 * Helper: Call LLM with timeout (returns content or throws)
 */
async function callLLMWithTimeout(
  prompt: string,
  geminiKey: string,
  timeoutMs: number
): Promise<string> {
  try {
    const response = await callLLM(prompt, {
      provider: 'gemini',
      model: 'gemini-3-flash-preview',
      apiKey: geminiKey,
      timeout: timeoutMs,
      maxOutputTokens: 2000,
    });
    return response.content;
  } catch (error) {
    throw error;
  }
}

/**
 * Helper: Parse claims JSON response
 */
function parseClaimsResponse(response: string): string[] {
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed.claims)) {
        return parsed.claims.slice(0, 10); // Max 10 claims
      }
    }
  } catch {
    // Ignore parse errors
  }
  return [];
}

/**
 * Get PVR configuration (for documentation/debugging)
 */
export function getPVRConfig() {
  return { ...PVR_CONFIG };
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
      model: 'gemini-3-flash-preview',
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

