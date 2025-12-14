/**
 * Sectioning utilities - generate summaries for structured sections
 * Note: Sections are now built directly from structured JSON, no markdown parsing needed
 */

import { Section } from './types/index.js';
import { compressText } from './clients/llm.js';

/**
 * Normalize a section title into a valid section ID
 * Example: "Key Findings" -> "key_findings"
 */
export function normalizeSectionId(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '') // Remove special chars
    .trim()
    .replace(/\s+/g, '_');         // Replace spaces with underscores
}

/**
 * Generate a concise summary for each section using LLM compression
 * This is async and modifies the sections in place
 */
export async function generateSectionSummaries(
  sections: Record<string, Section>,
  apiKey: string | undefined
): Promise<void> {
  if (!apiKey) {
    console.error('[Sectioning] No API key - using fallback summaries');
    // Fallback: use first 100 words as summary
    for (const section of Object.values(sections)) {
      section.summary = extractFirstWords(section.content, 100);
    }
    return;
  }
  
  console.error(`[Sectioning] Generating summaries for ${Object.keys(sections).length} sections...`);
  
  // Generate summaries in parallel
  const summaryPromises = Object.entries(sections).map(async ([id, section]) => {
    try {
      // Use compressText to generate a ~100 word summary
      const summary = await compressText(section.content, 100, apiKey);
      section.summary = summary;
    } catch (error) {
      console.error(`[Sectioning] Failed to generate summary for ${id}:`, error);
      // Fallback to first 100 words
      section.summary = extractFirstWords(section.content, 100);
    }
  });
  
  await Promise.all(summaryPromises);
}

/**
 * Extract first N words from text as a simple summary fallback
 */
function extractFirstWords(text: string, wordCount: number): string {
  const words = text
    .replace(/^#+\s+/gm, '') // Remove headers
    .replace(/\n+/g, ' ')     // Replace newlines with spaces
    .split(/\s+/)
    .filter(w => w.length > 0);
  
  const extracted = words.slice(0, wordCount).join(' ');
  return extracted + (words.length > wordCount ? '...' : '');
}

/**
 * Build a condensed section index for the executive summary
 */
export function buildSectionIndex(sections: Record<string, Section>): string[] {
  return Object.entries(sections).map(([id, section]) => {
    const lineInfo = section.lineRange ? ` (Lines ${section.lineRange})` : '';
    return `**${id}** - ${section.title}${lineInfo}`;
  });
}

/**
 * Format the condensed view (executive summary + section index)
 */
export function formatCondensedView(
  reportId: string,
  query: string,
  executiveSummary: {
    queryAnswered: boolean;
    confidence: 'high' | 'medium' | 'low';
    keyRecommendation: string;
    budgetFeasibility?: string;
    availableSections: string[];
  },
  sections: Record<string, Section>
): string {
  const parts: string[] = [];
  
  parts.push(`# Research Report ${reportId}\n`);
  parts.push(`**Query:** ${query}\n`);
  
  parts.push(`## Executive Summary\n`);
  parts.push(`**Query Answered:** ${executiveSummary.queryAnswered ? 'Yes' : 'No'} (${capitalizeFirst(executiveSummary.confidence)} Confidence)`);
  parts.push(`**Key Recommendation:** ${executiveSummary.keyRecommendation}`);
  
  if (executiveSummary.budgetFeasibility) {
    parts.push(`**Budget Feasibility:** ${executiveSummary.budgetFeasibility}`);
  }
  
  parts.push('');
  parts.push(`## Available Sections\n`);
  
  Object.entries(sections).forEach(([id, section], index) => {
    // Format section title (humanize sub-questions)
    const displayTitle = section.title || formatSectionTitle(id);
    
    parts.push(`### ${index + 1}. ${displayTitle}`);
    parts.push(`- **ID:** \`${id}\``);
    
    if (section.lineRange) {
      parts.push(`- **Lines:** ${section.lineRange}`);
      parts.push(`- **Usage:** \`read_report(citation="${reportId}:${id}")\` or \`read_report(citation="${reportId}:${id}:LINE_START-LINE_END")\``);
    } else {
      parts.push(`- **Usage:** \`read_report(citation="${reportId}:${id}")\``);
    }
    
    if (section.summary) {
      parts.push(`- **Summary:** ${section.summary}`);
    }
    parts.push('');
  });
  
  parts.push(`## Quick Reference`);
  parts.push(`\`\`\`
# Read a specific section
read_report(citation="${reportId}:SECTION_ID")

# Read lines within a section (if line ranges shown above)
read_report(citation="${reportId}:SECTION_ID:LINE_START-LINE_END")

# Read entire report (use sparingly - may bloat context)
read_report(citation="${reportId}", full=true)
\`\`\``);
  
  return parts.join('\n');
}

/**
 * Format a single section view for reading
 */
export function formatSectionView(
  reportId: string,
  sectionId: string,
  section: Section
): string {
  const parts: string[] = [];
  
  parts.push(`# ${section.title}\n`);
  parts.push(`**Report:** ${reportId}`);
  parts.push(`**Section:** ${sectionId}\n`);
  
  parts.push(section.content);
  
  return parts.join('\n');
}

/**
 * Capitalize first letter of a string
 */
function capitalizeFirst(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Format a section ID into a human-readable title
 * e.g., "q1" -> "Question 1", "additional_insights" -> "Additional Insights"
 */
function formatSectionTitle(id: string): string {
  // Handle question IDs like "q1", "q2", etc.
  const qMatch = id.match(/^q(\d+)$/);
  if (qMatch) {
    return `Question ${qMatch[1]}`;
  }
  
  // Convert snake_case to Title Case
  return id
    .split('_')
    .map(word => capitalizeFirst(word))
    .join(' ');
}
