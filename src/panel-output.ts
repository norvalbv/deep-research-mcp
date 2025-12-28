/**
 * Panel output helpers - formatting research results for agent-chat
 */

import { StructuredResearchResult } from './jobs.js';

export interface PanelOutput {
  for_panel: true;
  query: string;
  summary: string;
  key_findings: string[];
  recommendations: string[];
  critical_challenge?: Array<{ section: string; issue: string }>;
  key_gaps?: string[];
  sources?: string[];
  papers?: Array<{ id: string; title: string; summary: string; url: string }>;
  report_path: string;
  report_id: string; // Short ID for citations (e.g., "R-123325")
  instruction: string;
}

/**
 * Generate short report ID from filename
 * e.g., "research-2025-12-12-123325-..." -> "R-123325"
 */
export function generateReportId(reportPath: string): string {
  const match = reportPath.match(/research-\d{4}-\d{2}-\d{2}-(\d{6})/);
  return match ? `R-${match[1]}` : `R-${Date.now().toString().slice(-6)}`;
}

/**
 * Build structured output for agent-chat panel
 */
export function buildPanelOutput(
  structured: StructuredResearchResult | undefined,
  query: string,
  reportPath: string
): PanelOutput {
  // Safety: if no structured data, provide minimal response
  if (!structured) {
    return {
      for_panel: true,
      query,
      summary: 'Research completed. See full report for details.',
      key_findings: ['See full report for detailed findings'],
      recommendations: ['Review full report and discuss with panel'],
      report_path: reportPath,
      report_id: generateReportId(reportPath),
      instruction: `SEND THIS TO PANEL: Use send_message with research_findings parameter. Full report: ${reportPath}`,
    };
  }

  // Summary: deterministic truncation (no regex, no parsing)
  const summary = structured.synthesis.slice(0, 600).trim();

  // Key findings: deterministic line-based extraction (no regex).
  // We take the first N non-empty non-heading lines.
  const key_findings: string[] = [];
  const rawLines = structured.synthesis.split('\n');
  for (const raw of rawLines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;      // skip markdown headings
    if (line.startsWith('```')) continue;    // skip code fences

    // Strip a small set of bullet prefixes without regex
    let cleaned = line;
    const prefixes = ['- ', '* ', '• '];
    for (const p of prefixes) {
      if (cleaned.startsWith(p)) {
        cleaned = cleaned.slice(p.length).trim();
        break;
      }
    }
    if (cleaned.length < 25) continue;
    key_findings.push(cleaned);
    if (key_findings.length >= 7) break;
  }

  // Build result using structured data directly
  const result: PanelOutput = {
    for_panel: true,
    query,
    summary,
    key_findings: key_findings.length > 0 ? key_findings : ['See full report for detailed findings'],
    recommendations: ['Review the full report and discuss next steps with the panel'],
    report_path: reportPath,
    report_id: generateReportId(reportPath),
    instruction: `SEND THIS TO PANEL: Use send_message with research_findings parameter. Full report: ${reportPath}`,
  };

  // Direct structured data - no parsing needed!
  if (structured.critiques?.length) {
    result.critical_challenge = structured.critiques;
  }
  
  if (structured.criticalGaps?.length) {
    result.key_gaps = structured.criticalGaps;
  } else if (structured.critiques?.length) {
    // Convert structured critiques to string array for key_gaps
    result.key_gaps = structured.critiques.map(c => `[${c.section}] ${c.issue}`);
  }

  if (structured.sources?.length) {
    result.sources = structured.sources;
  }

  if (structured.papers?.length) {
    result.papers = structured.papers;
  }

  return result;
}

/**
 * Generate a safe filename from query
 */
export function generateFilename(query: string): string {
  // Include time + random suffix to avoid collisions between similar queries
  const iso = new Date().toISOString(); // e.g. 2025-12-11T21:03:16.480Z
  const date = iso.slice(0, 10); // YYYY-MM-DD
  const time = iso.slice(11, 19).replaceAll(':', ''); // HHMMSS
  const rand = Math.random().toString(36).slice(2, 8);

  // Sanitize without regex
  const lower = query.toLowerCase().slice(0, 80);
  let sanitized = '';
  let lastDash = false;
  for (const ch of lower) {
    const isAlphaNum =
      (ch >= 'a' && ch <= 'z') ||
      (ch >= '0' && ch <= '9');
    if (isAlphaNum) {
      sanitized += ch;
      lastDash = false;
    } else if (!lastDash) {
      sanitized += '-';
      lastDash = true;
    }
  }
  sanitized = sanitized.replaceAll('--', '-').replaceAll('---', '-');
  if (sanitized.startsWith('-')) sanitized = sanitized.slice(1);
  if (sanitized.endsWith('-')) sanitized = sanitized.slice(0, -1);

  return `research-${date}-${time}-${sanitized}-${rand}.md`;
}

export type EnrichedContext = {
  project_description?: string;
  current_state?: string;
  problem_statement?: string;
  constraints?: string[];
  domain?: string;
  date_range?: string;
  papers_read?: string[];
  key_findings?: string[];
  rejected_approaches?: string[];
  output_format?: 'summary' | 'detailed' | 'actionable_steps';
  include_code_examples?: boolean;
  sub_questions?: string[];
  tech_stack?: string[];
  existing_data_samples?: string;
  target_metrics?: string[];
};

/**
 * Build enriched context from structured parameters
 */
export function buildEnrichedContext({
  project_description,
  current_state,
  problem_statement,
  constraints,
  domain,
  date_range,
  papers_read,
  key_findings,
  rejected_approaches,
  output_format,
  include_code_examples,
  sub_questions,
  tech_stack,
  existing_data_samples,
  target_metrics,
}: EnrichedContext): string {
  const parts: string[] = [];

  // Project Context
  if (project_description) {
    parts.push(`**Project:** ${project_description}`);
  }

  if (current_state) {
    parts.push(`**Current State:** ${current_state}`);
  }

  if (problem_statement) {
    parts.push(`**Problem:** ${problem_statement}`);
  }

  if (domain) {
    parts.push(`**Domain:** ${domain}`);
  }

  // Constraints
  if (constraints && constraints.length > 0) {
    parts.push(`**Constraints:**\n- ${constraints.join('\n- ')}`);
  }

  // Research Scope
  const scopeParts: string[] = [];
  if (date_range) {
    scopeParts.push(`Date range: ${date_range}`);
  }
  if (output_format) {
    scopeParts.push(`Output format: ${output_format}`);
  }
  if (include_code_examples !== undefined) {
    scopeParts.push(`Include code: ${include_code_examples ? 'yes' : 'no'}`);
  }
  if (scopeParts.length > 0) {
    parts.push(`**Research Scope:** ${scopeParts.join(', ')}`);
  }

  // Prior Research (Critical - avoid redundancy)
  if (papers_read && papers_read.length > 0) {
    parts.push(`**Papers Already Reviewed (DO NOT re-summarize):**\n- ${papers_read.join('\n- ')}`);
  }

  if (key_findings && key_findings.length > 0) {
    parts.push(`**Known Findings (build on these):**\n- ${key_findings.join('\n- ')}`);
  }

  if (rejected_approaches && rejected_approaches.length > 0) {
    parts.push(`**Rejected Approaches (do not recommend):**\n- ${rejected_approaches.join('\n- ')}`);
  }

  // Specific Questions
  if (sub_questions && sub_questions.length > 0) {
    parts.push(`**Specific Questions to Answer:**\n${sub_questions.map((q: string, i: number) => `${i + 1}. ${q}`).join('\n')}`);
  }

  // Technical Context
  if (tech_stack && tech_stack.length > 0) {
    parts.push(`**Tech Stack:** ${tech_stack.join(', ')}`);
  }

  if (existing_data_samples) {
    parts.push(`**Data Samples:**\n${existing_data_samples}`);
  }

  if (target_metrics && target_metrics.length > 0) {
    parts.push(`**Target Metrics:** ${target_metrics.join(', ')}`);
  }

  return parts.join('\n\n');
}


