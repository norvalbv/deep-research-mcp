/**
 * Challenge Response Parser
 * 
 * Parses structured JSON responses from challenge LLM.
 * The LLM is instructed to respond in a specific JSON format.
 */

import { safeParseJSON } from './validation.js';

export interface ChallengeResult {
  critiques: string[];
  hasSignificantGaps: boolean;
  rawResponse: string;
}

/**
 * Expected JSON response format from challenge LLM.
 */
interface ChallengeJSON {
  pass: boolean;
  critiques: string[];
}

/**
 * Parse challenge response expecting structured JSON output.
 * LLM is instructed to respond with: {"pass": true/false, "critiques": [...]}
 */
export function parseChallengeResponse(response: string): ChallengeResult {
  // Try to parse as JSON first (expected format)
  const parsed = safeParseJSON<ChallengeJSON>(response, { pass: false, critiques: [] });
  
  // If we got valid JSON with explicit pass/critiques
  if (typeof parsed.pass === 'boolean') {
    return {
      critiques: Array.isArray(parsed.critiques) ? parsed.critiques : [],
      hasSignificantGaps: !parsed.pass,
      rawResponse: response,
    };
  }
  
  // Fallback: if JSON parsing gave default, check if response is very short (likely pass)
  if (response.trim().length < 30) {
    return {
      critiques: [],
      hasSignificantGaps: false,
      rawResponse: response,
    };
  }
  
  // Default: treat unparseable response as having gaps (fail-safe)
  return {
    critiques: [response.slice(0, 500)],
    hasSignificantGaps: true,
    rawResponse: response,
  };
}

