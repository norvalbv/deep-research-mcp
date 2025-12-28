/**
 * Challenge Response Parser
 * 
 * Parses structured JSON responses from challenge LLM.
 * The LLM is instructed to respond in a specific JSON format.
 */

import { safeParseJSON } from './validation.js';

export interface ChallengeCritique {
  section: string;  // "overview" | "q1" | "q2" | etc.
  issue: string;
}

export interface ChallengeResult {
  critiques: ChallengeCritique[];
  hasSignificantGaps: boolean;
  rawResponse: string;
}

/**
 * Expected JSON response format from challenge LLM.
 * LLM returns: { "pass": false, "critiques": [{ "section": "q1", "issue": "..." }] }
 */
interface ChallengeJSON {
  pass: boolean;
  critiques: Array<{ section?: string; issue?: string }>;
}

/**
 * Valid section IDs (LLMs sometimes hallucinate checklist names as sections)
 */
const VALID_SECTION_PATTERN = /^(overview|global|q\d+)$/;

/**
 * Normalize section ID to a valid value.
 * Invalid sections (like "Code Completeness") get mapped to "overview".
 */
function normalizeSectionId(section: string | undefined): string {
  if (!section || typeof section !== 'string') return 'overview';
  const lower = section.toLowerCase().trim();
  if (VALID_SECTION_PATTERN.test(lower)) return lower;
  // Map invalid sections to 'overview' with a log
  console.error(`[Parser] Invalid section ID "${section}" mapped to "overview"`);
  return 'overview';
}

/**
 * Normalize a critique item into { section, issue } format.
 */
function normalizeCritique(c: unknown): ChallengeCritique | null {
  if (c && typeof c === 'object' && 'issue' in c) {
    const obj = c as { section?: string; issue?: string };
    if (typeof obj.issue === 'string') {
      return {
        section: normalizeSectionId(obj.section),
        issue: obj.issue,
      };
    }
  }
  return null;
}

/**
 * Parse challenge response expecting structured JSON output.
 * LLM is instructed to respond with: {"pass": true/false, "critiques": [{ section, issue }]}
 */
export function parseChallengeResponse(response: string): ChallengeResult {
  // Try to parse as JSON first (expected format)
  // Use a sentinel fallback to detect if parsing actually succeeded
  const sentinel = { pass: undefined as unknown as boolean, critiques: [] as never[] };
  const parsed = safeParseJSON<ChallengeJSON>(response, sentinel);
  
  // If we got valid JSON with explicit pass field (not the sentinel)
  if (typeof parsed.pass === 'boolean' && parsed !== sentinel) {
    const critiques: ChallengeCritique[] = [];
    if (Array.isArray(parsed.critiques)) {
      for (const c of parsed.critiques) {
        const normalized = normalizeCritique(c);
        if (normalized) critiques.push(normalized);
      }
    }
    return {
      critiques,
      hasSignificantGaps: !parsed.pass,
      rawResponse: response,
    };
  }
  
  // Fallback: if JSON parsing failed, check if response is very short (likely pass)
  if (response.trim().length < 30) {
    return {
      critiques: [],
      hasSignificantGaps: false,
      rawResponse: response,
    };
  }
  
  // Default: treat unparseable response as having gaps (fail-safe)
  return {
    critiques: [{ section: 'overview', issue: response.slice(0, 500) }],
    hasSignificantGaps: true,
    rawResponse: response,
  };
}

