/**
 * Shared utility for building validation section content
 * Used by both formatting.ts (markdown output) and controller.ts (sections object)
 * 
 * Note: Local interface definitions used to avoid circular imports
 */

interface ChallengeCritique {
  section: string;
  issue: string;
}

interface ChallengeResult {
  critiques: ChallengeCritique[];
  hasSignificantGaps: boolean;
}

interface SufficiencyVote {
  sufficient: boolean;
  criticalGaps: string[];
  details: Array<{ model: string; reasoning: string }>;
}

export interface ValidationData {
  challenge?: ChallengeResult;
  sufficiency?: SufficiencyVote;
  improved?: boolean;
  consensus?: string;
}

/**
 * Build validation section content as markdown string
 * Returns null if no validation data or complexity < 2
 */
export function buildValidationContent(
  validation: ValidationData,
  complexity: number,
  options?: { includeConsensus?: boolean }
): string | null {
  // Skip entirely at depth 1 to save tokens
  if (complexity < 2) return null;
  if (!validation.challenge && !validation.sufficiency) return null;

  const parts: string[] = [];

  // Critical Challenge
  if (validation.challenge) {
    parts.push('### Critical Challenge\n');
    if (validation.challenge.hasSignificantGaps && validation.challenge.critiques.length > 0) {
      validation.challenge.critiques.forEach((critique, i) => {
        parts.push(`${i + 1}. [${critique.section}] ${critique.issue}`);
      });
    } else {
      parts.push('No significant gaps found in the synthesis.');
    }
    parts.push('');
  }

  // Quality Vote
  if (validation.sufficiency) {
    parts.push('### Quality Assessment\n');
    parts.push(`**Result**: ${validation.sufficiency.sufficient ? 'Passes quality thresholds' : 'Exceeds issue thresholds'}`);

    if (validation.improved) {
      parts.push('**Status**: Synthesis improved after critique identified gaps\n');
    } else if (validation.sufficiency.sufficient) {
      parts.push('**Status**: Synthesis validated (addresses the query adequately)\n');
    } else {
      parts.push('**Status**: Quality issues identified (see below)\n');
    }

    if (validation.sufficiency.criticalGaps && validation.sufficiency.criticalGaps.length > 0) {
      parts.push('**Critical Gaps Identified**:');
      validation.sufficiency.criticalGaps.forEach((gap) => {
        parts.push(`- ${gap}`);
      });
      parts.push('');
    }

    if (validation.sufficiency.details.length > 0) {
      parts.push('**Model Reasoning**:');
      validation.sufficiency.details.forEach((detail) => {
        parts.push(`- **${detail.model}**: ${detail.reasoning}`);
      });
      parts.push('');
    }
  }

  // Consensus (optional - formatting.ts includes it, controller.ts has it separate)
  if (options?.includeConsensus && validation.consensus) {
    parts.push('### Multi-Model Consensus\n');
    parts.push(validation.consensus);
    parts.push('');
  }

  return parts.join('\n');
}

