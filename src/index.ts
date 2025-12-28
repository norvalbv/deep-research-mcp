import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ResearchController } from './controller.js';
import { ComplexityLevel } from './types/index.js';
import { createArxivClient } from './clients/arxiv.js';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import {
  jobs,
  generateJobId,
  saveJob,
  loadJob,
  ResearchJob,
  JOBS_DIR,
} from './jobs.js';
import { buildPanelOutput, generateFilename, buildEnrichedContext, generateReportId } from './panel-output.js';
import { registerReport } from './storage/report-registry.js';
import { compressText } from './clients/llm.js';
import { formatCondensedView, generateSectionSummaries } from './sectioning.js';
import { startResearchJob } from './job-orchestrator.js';

// In-memory check count tracking (avoids race condition on concurrent status checks)
// This is purely cosmetic - only used for "Still running (X/5 checks)" message
const jobCheckCounts = new Map<string, number>();

// Create the MCP server
const server = new McpServer({
  name: 'deep-research-mcp',
  version: '1.0.0',
});

// Initialize research controller (will be initialized on first use with env from MCP)
let controller: ResearchController | null = null;
let arxivClientPromise: Promise<Awaited<ReturnType<typeof createArxivClient>>> | null = null;

function getController(): ResearchController {
  if (!controller) {
    // Note: process.env is populated by MCP server at runtime from mcp.json
    controller = new ResearchController(process.env as Record<string, string>);
  }
  return controller;
}

/**
 * Lazy initialization of arXiv client.
 * Only creates the client when actually needed (when read_paper or download_paper is called).
 * This prevents server initialization failures in isolated environments where uv may not be in PATH.
 */
function getArxivClient(): Promise<Awaited<ReturnType<typeof createArxivClient>>> {
  if (!arxivClientPromise) {
    arxivClientPromise = createArxivClient(process.env.ARXIV_STORAGE_PATH);
  }
  return arxivClientPromise;
}

// ==================== ASYNC JOB STORAGE ====================
// In-memory storage for async research jobs
// Jobs are automatically cleaned up after 1 hour


// COMMENTED OUT: Synchronous research tool exceeds Cursor's 1-2 min MCP timeout
// Once Cursor and other MCP clients add configurable timeouts, this can be re-enabled
// Use start_research + check_research_status instead (async pattern)
/*
server.registerTool(
  'research',
  {
    title: 'Consensus-Driven Research Orchestrator',
    description: `Performs **validated, multi-source research** using consensus from 3-5 LLMs to plan strategy, then executes dynamically with automatic quality checks. Every response is validated by multiple models and improved if insufficient.

**When to use this tool:**
- Investigating new technologies, frameworks, or methodologies you're unfamiliar with
- Comparing multiple approaches or solutions (e.g., "React vs Vue vs Angular")
- Understanding complex technical concepts that require deep analysis
- Finding best practices and real-world implementation patterns
- Researching cutting-edge topics requiring academic papers
- Validating architectural decisions with multi-source evidence
- Learning about APIs, libraries, or tools before implementation

**What you get:**
Returns validated markdown report with:
- Action plan showing which tools were used and in what order
- Complexity assessment with reasoning
- Web search results with sources
- Deep analysis (auto-triggered based on plan)
- Library documentation with code examples (when tech_stack provided)
- Academic papers with AI summaries <300 chars (depth ≥ 4)
- Multi-model consensus (depth ≥ 5)
- Critical challenge findings
- Quality validation showing model votes and any improvements made
`,
    inputSchema: {
      query: z.string().describe('The specific research question. Example: "How to create high-quality evaluation datasets for LLM testing?"'),
      
      project_description: z
        .string()
        .optional()
        .describe('What you are building. Example: "AI companion app with semantic memory that extracts entities and deduplicates memories"'),
      
      current_state: z
        .string()
        .optional()
        .describe('Where you are now. Example: "Have 85 test examples, need 600+. Current examples from unit tests, not real user data."'),
      
      problem_statement: z
        .string()
        .optional()
        .describe('The specific problem to solve. Example: "Template-based generation creates unrealistic data that doesn\'t capture real-world linguistic complexity"'),
      
      constraints: z
        .array(z.string())
        .optional()
        .describe('Budget, time, technical limits. Example: ["Solo developer", "20 hours budget", "No access to real user data", "High-stakes: errors corrupt data"]'),
      
      domain: z
        .string()
        .optional()
        .describe('Research domain/area. Example: "LLM evaluation datasets", "entity extraction", "memory deduplication"'),
      
      date_range: z
        .string()
        .optional()
        .describe('Preferred date range for sources. Example: "2024-2025", "latest", "last 2 years"'),
      
      depth_level: z
        .number()
        .int()
        .min(1)
        .max(4)
        .optional()
        .describe('OPTIONAL: Set to skip auto-detection. 1=quick web search (~20s), 2=+analysis (~40s), 3=+library docs (~80s), 4=+papers+consensus (~180s). If omitted, depth is auto-detected via LLM consensus.'),
      
      papers_read: z
        .array(z.string())
        .optional()
        .describe('Papers/resources already reviewed (prevents redundancy). Example: ["2508.11715v1 Excel Formula Repair", "DAHL Biomedical Benchmark", "LLM Synthetic Data Survey"]'),
      
      key_findings: z
        .array(z.string())
        .optional()
        .describe('What you already know from prior research. Example: ["Synthetic data 40% simpler than real data", "618 examples sufficient for specialized benchmark"]'),
      
      rejected_approaches: z
        .array(z.string())
        .optional()
        .describe('Approaches already ruled out and why. Example: ["Random template filling - creates unrealistic patterns", "Pure LLM generation - too simple"]'),
      
      output_format: z
        .enum(['summary', 'detailed', 'actionable_steps', 'direct'])
        .optional()
        .describe('Preferred output format. "summary" for overview, "detailed" for comprehensive analysis, "actionable_steps" for implementation guide, "direct" for answer-only output with no report wrapper (for strict formatting prompts)'),
      
      include_code_examples: z
        .boolean()
        .optional()
        .describe('Request code snippets in the synthesis output. If omitted, the planning agent decides based on query context. Set explicitly to true/false to override.'),
      
      sub_questions: z
        .array(z.string())
        .optional()
        .describe('Specific sub-questions to answer. Example: ["What makes data representative?", "How to generate hard negatives?", "Edge cases for entity extraction?"]'),
      
      tech_stack: z
        .array(z.string())
        .optional()
        .describe('Technologies in use. Example: ["Python", "Neo4j", "LangSmith", "Gemini"]'),
      
      existing_data_samples: z
        .string()
        .optional()
        .describe('Actual examples from your current dataset for context. Example: "\'Alex likes coffee\' + \'Alex loves coffee\' → UPDATE"'),
      
      target_metrics: z
        .array(z.string())
        .optional()
        .describe('Metrics you\'re optimizing for. Example: ["Entity F1", "Precision", "Recall", "False Positive Rate"]'),

      report: z
        .boolean()
        .optional()
        .describe('Generate and save report as markdown file. When true, saves the research output to a local .md file. Example: true'),

      report_path: z
        .string()
        .optional()
        .describe('Custom directory for report file. If not provided, uses ~/research-reports/. Example: "/Users/name/Documents/reports/"'),

      for_panel: z
        .boolean()
        .optional()
        .describe('Return structured JSON for direct use with agent-chat send_message. When true, returns summary, key_findings, and recommendations that can be passed directly to the panel.'),
    },
  },
  async (params) => {
    const {
      query,
      project_description,
      current_state,
      problem_statement,
      constraints,
      domain,
      date_range,
      depth_level,
      papers_read,
      key_findings,
      rejected_approaches,
      output_format,
      include_code_examples,
      sub_questions,
      tech_stack,
      existing_data_samples,
      target_metrics,
      report,
      report_path,
      for_panel,
    } = params;

    console.error(`\n[Research MCP] Starting research for: "${query}"`);
    console.error(`[Research MCP] Depth level: ${depth_level || 'auto'}`);
    console.error(`[Research MCP] Domain: ${domain || 'general'}`);
    if (sub_questions?.length) {
      console.error(`[Research MCP] Sub-questions: ${sub_questions.length}`);
    }
    if (constraints?.length) {
      console.error(`[Research MCP] Constraints: ${constraints.join(', ')}`);
    }
    if (papers_read?.length) {
      console.error(`[Research MCP] Prior research: ${papers_read.length} papers`);
    }
    console.error('');

    try {
      // Initialize controller if needed
      await controller.initialize();

      // Build enriched context from structured fields
      const enrichedContext = buildEnrichedContext({
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
      });

      // Execute research
      const result = await controller.execute({
        query,
        enrichedContext,
        depthLevel: (depth_level || 2) as ComplexityLevel,
        options: {
          subQuestions: sub_questions,
          constraints,
          includeCodeExamples: include_code_examples,  // undefined = let planner decide
          techStack: tech_stack,
          papersRead: papers_read,
          outputFormat: output_format,
        },
      });

      console.error(`\n[Research MCP] Research complete!\n`);

      // Handle for_panel output - structured JSON for agent-chat integration
      if (for_panel) {
        // Always save report when for_panel is true (needed for full context)
        const reportDir = report_path || join(homedir(), 'research-reports');
        const filename = generateFilename(query);
        const filepath = join(reportDir, filename);
        
        try {
          await mkdir(reportDir, { recursive: true });
          await writeFile(filepath, result.markdown, 'utf-8');
          console.error(`[Research MCP] Report saved to: ${filepath}\n`);
          
          // Register report in registry for future reference
          const panelOutput = buildPanelOutput(result.result, query, filepath);
          registerReport({
            path: filepath,
            timestamp: new Date().toISOString(),
            query,
            summary: panelOutput.summary.slice(0, 200) + (panelOutput.summary.length > 200 ? '...' : ''),
            keyFindings: panelOutput.key_findings?.slice(0, 3),
            keyGaps: panelOutput.key_gaps?.slice(0, 3),
          });
        } catch (error: any) {
          console.error('[Research MCP] Error saving report:', error);
        }
        
        // Extract structured data from the markdown result
        const panelOutput = buildPanelOutput(result.result, query, filepath);
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(panelOutput, null, 2),
            },
          ],
        };
      }

      // Save report to file if requested
      if (report) {
        try {
          const reportDir = report_path || join(homedir(), 'research-reports');
          const filename = generateFilename(query);
          const filepath = join(reportDir, filename);

          // Create directory if it doesn't exist
          await mkdir(reportDir, { recursive: true });

          // Write markdown to file
          await writeFile(filepath, result.markdown, 'utf-8');

          console.error(`[Research MCP] Report saved to: ${filepath}\n`);
          
          // Register in registry for future reference
          registerReport({
            path: filepath,
            timestamp: new Date().toISOString(),
            query,
            summary: result.markdown.slice(0, 200) + '...',
          });

          // Return markdown with file path
          return {
            content: [
              {
                type: 'text',
                text: result.markdown,
              },
              {
                type: 'text',
                text: `\n\n---\n**Report saved to**: \`${filepath}\``,
              },
            ],
          };
        } catch (error: any) {
          console.error('[Research MCP] Error saving report:', error);
          // Still return the markdown even if file save fails
          return {
            content: [
              {
                type: 'text',
                text: result.markdown,
              },
              {
                type: 'text',
                text: `\n\n---\n**Error saving report**: ${error.message}`,
              },
            ],
          };
        }
      }

      // Return the formatted markdown
      return {
        content: [
          {
            type: 'text',
            text: result.markdown,
          },
        ],
      };
    } catch (error: any) {
      console.error('[Research MCP] Error:', error);
      
      // Build detailed error message
      const errorDetails = [
        `# Research Error`,
        ``,
        `An error occurred during research:`,
        ``,
        '```',
        error.message || String(error),
        '```',
        ``,
        `## Debug Info`,
        ``,
        `**Environment Variables (from mcp.json):**`,
        `- PERPLEXITY_API_KEY: Check your mcp.json env configuration`,
        `- GEMINI_API_KEY: Check your mcp.json env configuration`,
        `- OPENAI_API_KEY: Check your mcp.json env configuration`,
        `- CONTEXT7_API_KEY: Check your mcp.json env configuration`,
        ``,
        `**If connection issues occur:**`,
        `1. Verify all API keys are set in your mcp.json env configuration`,
        `2. Check network connectivity`,
        ``,
        `**Stack trace:**`,
        '```',
        error.stack || 'No stack trace available',
        '```',
      ].join('\n');
      
      return {
        content: [
          {
            type: 'text',
            text: errorDetails,
          },
        ],
        isError: true,
      };
    }
  }
);
*/

// Register passthrough arXiv tools
const callArxivPassthroughTool = async (params: {
  arxivClient: any;
  toolName: 'read_paper' | 'download_paper';
  arxivId: string;
}): Promise<any> => {
  const { arxivClient, toolName, arxivId } = params;

  // Different arXiv MCP servers have used different parameter names historically.
  // Try the most common/strict ones first, falling back for compatibility.
  const argumentVariants: Array<Record<string, string>> = [
    { paper_id: arxivId },
    { arxiv_id: arxivId },
    { arXivID: arxivId },
  ];

  let lastError: unknown;
  for (const args of argumentVariants) {
    try {
      return await arxivClient.callTool({
        name: toolName,
        arguments: args,
      });
    } catch (err) {
      lastError = err;
    }
  }

  // Surface last failure (includes upstream validation details)
  throw lastError;
}

server.registerTool(
  'read_paper',
  {
    title: 'Read Full arXiv Paper',
    description: `Reads the complete full text of an arXiv academic paper. Use this tool when:
- The research tool provides an arXiv paper summary and you need the full details
- You need to extract specific technical details, methodology, or results
- The user asks to read or analyze a specific arXiv papers
- You MUST download the paper before reading it using the download_paper tool.

The tool returns the full paper content including abstract, introduction, methodology, results, and conclusions.
This is different from the brief summaries provided by the research tool - this gives you the complete paper text.`,
    inputSchema: {
      arxiv_id: z.string().describe('arXiv ID from the research results (e.g., 2505.17125v1, 1906.09756v1)'),
      maximum_output_length: z.number().max(10000).optional().describe('Research papers can be long. Use this to limit the output length. The entire research paper will be returned if not provided. Whe provided, the entire paper will be summarized to your target length. Default: 2500. Max length: 10000'), 
    },
  },
  async ({ arxiv_id, maximum_output_length }) => {
    const arxivClient = (await getArxivClient()).client;
    const result = await callArxivPassthroughTool({
      arxivClient,
      toolName: 'read_paper',
      arxivId: arxiv_id,
    });

    // Ensure result has content property
    if ('content' in result && result.content) {
      return result as any;
    }

    if (maximum_output_length) {
      const compressedContent = await compressText(result.content, maximum_output_length);
      return {
        content: [
          { type: 'text' as const, text: compressedContent },
        ],
      };
    }

    // Fallback: wrap toolResult in content
    return {
      content: [
        {
          type: 'text' as const,
          text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

server.registerTool(
  'download_paper',
  {
    title: 'Download arXiv Paper PDF',
    description: `Downloads the PDF version of an arXiv academic paper to local storage. Use this tool when:
- You want to save a paper for offline reading or archival
- The user asks to download a specific paper
- You need the PDF format for citation or reference purposes

The tool downloads the paper PDF and returns the local file path where it was saved.
Note: Use read_paper if you want to analyze the paper content immediately - this tool only downloads the PDF file.`,
    inputSchema: {
      arxiv_id: z.string().describe('arXiv ID from the research results (e.g., 2505.17125v1, 1906.09756v1)'),
    },
  },
  async ({ arxiv_id }) => {
    const arxivClient = (await getArxivClient()).client;
    const result = await callArxivPassthroughTool({
      arxivClient,
      toolName: 'download_paper',
      arxivId: arxiv_id,
    });

    // Ensure result has content property
    if ('content' in result && result.content) {
      return result as any;
    }

    // Fallback: wrap toolResult in content
    return {
      content: [
        {
          type: 'text' as const,
          text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// ==================== READ REPORT TOOL ====================
// Read specific lines or sections from research reports using unified citation format

server.registerTool(
  'read_report',
  {
    title: 'Read Research Report (Condensed or Sectioned)',
    description: `Read research reports with support for condensed views, specific sections, or full content.
    
**Default behavior (condensed view) - RECOMMENDED:**
- Returns executive summary + section index (~200 words vs ~5k words)
- Prevents context bloat and improves AI reasoning
- Gives you a clear overview without overwhelming your context

**When to read specific sections:**
- Use section citations like \`R-135216:overview\` or \`R-135216:q1\` to read just what you need
- Much more efficient than reading the entire report
- Keeps your context clean and focused

**When to read full report (LAST RESORT):**
- User explicitly asks to see everything
- You need to analyze critique/validation details in depth
- Condensed view + sections aren't sufficient (very rare)

**Unified citation format:**
- \`R-135216\` - condensed view (executive summary + section index) ✅ DEFAULT
- \`R-135216:overview\` - read specific section
- \`R-135216:q1\` - read sub-question section
- \`R-135216:section:5-19\` - read lines 5-19 within section
- \`R-135216:5-19\` - read line range (legacy format)

**Full report:**
- Set full=true ONLY when absolutely necessary
- Full reports are ~5k words and will bloat your context

Use this to efficiently read research without bloating context.`,
    inputSchema: {
      citation: z.string().optional().describe('Unified citation format: "R-135216" (condensed), "R-135216:section_id" (specific section), "R-135216:section_id:5-19" (lines within section), or "R-135216:5-19" (legacy line range)'),
      report_path: z.string().optional().describe('Direct path to report file (alternative to citation)'),
      full: z.boolean().optional().describe('Set to true ONLY if user explicitly asks to read the entire report. Default condensed view is recommended.'),
    },
  },
  async ({ citation, report_path, full }) => {
    try {
      let targetPath: string | undefined = report_path;
      let reportId: string | undefined;
      let sectionId: string | undefined;
      let lineRange: { start: number; end: number } | undefined;

      // Parse unified citation format
      if (citation) {
        // Remove brackets if present: [R-135216:section:5-19] -> R-135216:section:5-19
        const cleanCitation = citation.replace(/^\[|\]$/g, '');
        
        // Split by colons to parse components
        const parts = cleanCitation.split(':');
        
        // First part must be report ID (R-NNNNNN)
        if (!parts[0] || !/^R-\d+$/.test(parts[0])) {
          return {
            content: [{
              type: 'text' as const,
              text: `Invalid citation format: "${citation}". Expected format: R-NNNNNNN, R-NNNNNNN:section_id, R-NNNNNNN:section_id:N-N, or R-NNNNNNN:N-N`
            }]
          };
        }
        
        reportId = parts[0];
        
        // Parse remaining parts
        if (parts.length === 2) {
          // Could be: R-135216:section_id OR R-135216:5-19
          const lineMatch = parts[1].match(/^(\d+)-(\d+)$/);
          if (lineMatch) {
            // Line range format: R-135216:5-19
            lineRange = { start: parseInt(lineMatch[1]), end: parseInt(lineMatch[2]) };
          } else {
            // Section ID format: R-135216:key_findings
            sectionId = parts[1];
          }
        } else if (parts.length === 3) {
          // Format: R-135216:section_id:5-19
          sectionId = parts[1];
          const lineMatch = parts[2].match(/^(\d+)-(\d+)$/);
          if (lineMatch) {
            lineRange = { start: parseInt(lineMatch[1]), end: parseInt(lineMatch[2]) };
          }
        }

        // Find report by ID using registry
        const { getReportById } = await import('./storage/report-registry.js');
        const report = getReportById(reportId);
        
        if (!report) {
          return {
            content: [{
              type: 'text' as const,
              text: `Report ${reportId} not found in registry. Available reports can be viewed via the report registry.`
            }]
          };
        }

        targetPath = report.path;
      }

      // Validate target path
      if (!targetPath) {
        return {
          content: [{
            type: 'text' as const,
            text: 'Error: Either citation or report_path must be provided'
          }]
        };
      }

      // Check if it's a job JSON file (new structure) or markdown file (legacy)
      const isJobJson = targetPath.endsWith('.json');
      
      if (isJobJson) {
        // Read from job JSON with structured sections
        const { readFileSync, existsSync } = await import('fs');
        
        if (!existsSync(targetPath)) {
          return {
            content: [{
              type: 'text' as const,
              text: `Report file not found: ${targetPath}`
            }]
          };
        }

        const jobData = JSON.parse(readFileSync(targetPath, 'utf-8'));
        const structured = jobData.structured;
        
        // Check if report has new sectioned structure
        if (structured?.sections && structured?.executiveSummary) {
          // NEW STRUCTURE: Support condensed/sectioned reading
          
          if (sectionId) {
            // Return specific section (with optional line range within section)
            const { formatSectionView } = await import('./sectioning.js');
            const section = structured.sections[sectionId];
            
            if (!section) {
              const available = Object.keys(structured.sections).join(', ');
              return {
                content: [{
                  type: 'text' as const,
                  text: `Section "${sectionId}" not found. Available sections: ${available}`
                }]
              };
            }
            
            // If line range specified, extract those lines from section content
            if (lineRange) {
              const sectionLines = section.content.split('\n');
              const extractedLines = sectionLines.slice(lineRange.start - 1, lineRange.end);
              return {
                content: [{
                  type: 'text' as const,
                  text: `# Section: ${section.title} (${reportId}) - Lines ${lineRange.start}-${lineRange.end}\n\n${extractedLines.join('\n')}`
                }]
              };
            }
            
            return {
              content: [{
                type: 'text' as const,
                text: formatSectionView(reportId || 'Unknown', sectionId, section)
              }]
            };
          } else if (lineRange) {
            // Line range on full report (legacy behavior)
            const allLines = (jobData.result || '').split('\n');
            const extractedLines = allLines.slice(lineRange.start - 1, lineRange.end);
            return {
              content: [{
                type: 'text' as const,
                text: `Lines ${lineRange.start}-${lineRange.end} from ${reportId}:\n\n${extractedLines.join('\n')}`
              }]
            };
          } else if (full) {
            // Return full report
            return {
              content: [{
                type: 'text' as const,
                text: jobData.result || 'Report content not available'
              }]
            };
          } else {
            // Return condensed view (default)
            const { formatCondensedView } = await import('./sectioning.js');
            return {
              content: [{
                type: 'text' as const,
                text: formatCondensedView(
                  reportId || 'Unknown',
                  jobData.query,
                  structured.executiveSummary,
                  structured.sections
                )
              }]
            };
          }
        } else {
          // OLD STRUCTURE: Fall back to full markdown (or line range if specified)
          if (lineRange) {
            const allLines = (jobData.result || '').split('\n');
            const extractedLines = allLines.slice(lineRange.start - 1, lineRange.end);
            return {
              content: [{
                type: 'text' as const,
                text: `Lines ${lineRange.start}-${lineRange.end}:\n\n${extractedLines.join('\n')}`
              }]
            };
          }
          return {
            content: [{
              type: 'text' as const,
              text: jobData.result || 'Report content not available'
            }]
          };
        }
      } else {
        // LEGACY: Read from markdown file
        const { readFileSync, existsSync } = await import('fs');
        
        if (!existsSync(targetPath)) {
          return {
            content: [{
              type: 'text' as const,
              text: `Report file not found: ${targetPath}`
            }]
          };
        }

        const content = readFileSync(targetPath, 'utf-8');
        const allLines = content.split('\n');

        if (lineRange) {
          // Return specific line range (1-indexed)
          const resultLines = allLines.slice(lineRange.start - 1, lineRange.end);
          return {
            content: [{
              type: 'text' as const,
              text: `Lines ${lineRange.start}-${lineRange.end} from ${targetPath}:\n\n${resultLines.join('\n')}`
            }]
          };
        } else {
          // Return full report
          return {
            content: [{
              type: 'text' as const,
              text: `Full report from ${targetPath}:\n\n${content}`
            }]
          };
        }
      }
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error reading report: ${error instanceof Error ? error.message : String(error)}`
        }]
      };
    }
  }
);

// ==================== ASYNC RESEARCH TOOLS ====================
// For long-running research that may exceed MCP timeout limits

server.registerTool(
  'start_research',
  {
    title: 'Consensus-Driven Research Orchestrator (Async)',
    description: `Performs **validated, multi-source research** using consensus from 3-5 LLMs to plan strategy, then executes dynamically with automatic quality checks. Every response is validated by multiple models and improved if insufficient.

**When to use this tool:**
- Investigating new technologies, frameworks, or methodologies you're unfamiliar with
- Comparing multiple approaches or solutions (e.g., "React vs Vue vs Angular")
- Understanding complex technical concepts that require deep analysis
- Finding best practices and real-world implementation patterns
- Researching cutting-edge topics requiring academic papers
- Validating architectural decisions with multi-source evidence
- Learning about APIs, libraries, or tools before implementation`,
    inputSchema: {
      query: z.string().describe('The specific research question. Example: "How to create high-quality evaluation datasets for LLM testing?"'),
      
      project_description: z
        .string()
        .optional()
        .describe('What you are building. Example: "AI companion app with semantic memory that extracts entities and deduplicates memories"'),
      
      current_state: z
        .string()
        .optional()
        .describe('Where you are now. Example: "Have 85 test examples, need 600+. Current examples from unit tests, not real user data."'),
      
      problem_statement: z
        .string()
        .optional()
        .describe('The specific problem to solve. Example: "Template-based generation creates unrealistic data that doesn\'t capture real-world linguistic complexity"'),
      
      constraints: z
        .array(z.string())
        .optional()
        .describe('Budget, time, technical limits. Example: ["Solo developer", "20 hours budget", "No access to real user data", "High-stakes: errors corrupt data"]'),
      
      domain: z
        .string()
        .optional()
        .describe('Research domain/area. Example: "LLM evaluation datasets", "entity extraction", "memory deduplication"'),
      
      date_range: z
        .string()
        .optional()
        .describe('Preferred date range for sources. Example: "2024-2025", "latest", "last 2 years"'),
      
      depth_level: z
        .number()
        .int()
        .min(1)
        .max(4)
        .optional()
        .describe('OPTIONAL: Set to skip auto-detection. 1=quick web search (~20s), 2=+analysis (~40s), 3=+library docs (~80s), 4=+papers+consensus (~180s). If omitted, depth is auto-detected via LLM consensus.'),
      
      papers_read: z
        .array(z.string())
        .optional()
        .describe('Papers/resources already reviewed (prevents redundancy). Example: ["2508.11715v1 Excel Formula Repair", "DAHL Biomedical Benchmark", "LLM Synthetic Data Survey"]'),
      
      key_findings: z
        .array(z.string())
        .optional()
        .describe('What you already know from prior research. Example: ["Synthetic data 40% simpler than real data", "618 examples sufficient for specialized benchmark"]'),
      
      rejected_approaches: z
        .array(z.string())
        .optional()
        .describe('Approaches already ruled out and why. Example: ["Random template filling - creates unrealistic patterns", "Pure LLM generation - too simple"]'),
      
      output_format: z
        .enum(['summary', 'detailed', 'actionable_steps', 'direct'])
        .optional()
        .describe('Preferred output format. "summary" for overview, "detailed" for comprehensive analysis, "actionable_steps" for implementation guide, "direct" for answer-only output with no report wrapper (for strict formatting prompts)'),
      
      include_code_examples: z
        .boolean()
        .optional()
        .describe('Request code snippets in the synthesis output. If omitted, the planning agent decides based on query context. Set explicitly to true/false to override.'),
      
      sub_questions: z
        .array(z.string())
        .optional()
        .describe('Specific sub-questions to answer. Use this if you want to answer specific questions about the research. Example: ["What makes data representative?", "How to generate hard negatives?", "Edge cases for entity extraction?"]'),
      
      tech_stack: z
        .array(z.string())
        .optional()
        .describe('Technologies in use. Example: ["Python", "Neo4j", "LangSmith", "Gemini"]'),
      
      existing_data_samples: z
        .string()
        .optional()
        .describe('Actual examples from your current dataset for context. Example: "\'Alex likes coffee\' + \'Alex loves coffee\' → UPDATE"'),
      
      target_metrics: z
        .array(z.string())
        .optional()
        .describe('Metrics you\'re optimizing for. Example: ["Entity F1", "Precision", "Recall", "False Positive Rate"]'),
      
      // TODO for future panel integration 😝
      // for_panel: z
      //   .boolean()
      //   .optional()
      //   .describe('Return structured JSON for direct use with agent-chat send_message. When true, returns { summary, key_findings, recommendations, report_path } that can be passed directly to send_message(research_findings: ...). This ensures research findings are formatted correctly for panel discussions.'),
    },
  },
  async (params: { query: string; project_description: string | undefined; current_state: string | undefined; problem_statement: string | undefined; constraints: string[] | undefined; domain: string | undefined; date_range: string | undefined; depth_level: number | undefined; papers_read: string[] | undefined; key_findings: string[] | undefined; rejected_approaches: string[] | undefined; output_format: 'summary' | 'detailed' | 'actionable_steps' | 'direct' | undefined; include_code_examples: boolean | undefined; sub_questions: string[] | undefined; tech_stack: string[] | undefined; existing_data_samples: string | undefined; target_metrics: string[] | undefined; }) => {
    const { query, project_description, current_state, problem_statement, constraints, domain, date_range, depth_level, papers_read, key_findings, rejected_approaches, output_format, include_code_examples, sub_questions, tech_stack, existing_data_samples, target_metrics } = params;
    const jobId = generateJobId();
    const job: ResearchJob = {
      id: jobId,
      status: 'pending',
      query: query,
      createdAt: Date.now(),
      progress: 'Initializing...',
      // forPanel: params.for_panel, // Store for later use
    };
    jobs.set(jobId, job);
    await saveJob(job); // Persist to file

    console.error(`[Jobs] Created job ${jobId} for: "${query}"`);

    // Start research job (awaits planning, fires execution in background)
    const { jobId: startedJobId, determinedDepth, estimatedSeconds } = await startResearchJob(
      job,
      params,
      getController()
    );

    // Return with accurate wait time based on determined depth
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            job_id: startedJobId,
            status: 'pending',
            message: `Research job started (depth ${determinedDepth}). IMPORTANT: Wait at LEAST ${estimatedSeconds} seconds before calling check_research_status. Research typically takes about ${Math.round(estimatedSeconds / 60)} minute(s) to complete but can take longer if the research is complex.`,
            estimated_duration_seconds: estimatedSeconds,
            next_action: `Run sleep in the terminal for ${estimatedSeconds} seconds before calling check_research_status. Or alternatively, tell the user you must wait and exit.`,
            query,
          }, null, 2),
        },
      ],
    };
  }
);

server.registerTool(
  'check_research_status',
  {
    title: 'Check Research Job Status',
    description: `Check the status of an async research job started with start_research.

**Status values:**
- pending: Job is queued
- running: Research is in progress  
- completed: Research finished, condensed view returned by default
- failed: Research failed, error is included

**IMPORTANT - Default behavior prevents context bloat:**
- By default, returns a condensed executive summary + section index (~200 words)
- This gives you enough information to understand the results without bloating context
- DO NOT read the full report unless absolutely necessary

**When to use full=true (rare):**
- User explicitly asks for complete details
- You need to analyze the entire validation/critique process
- Condensed view doesn't contain enough detail for a specific question

**Result format:**
- Default: Returns condensed executive summary + section index (~200 words vs ~5k words)
- Set full=true to get complete report (~5k words) - USE SPARINGLY

**After research completes:**
1. Check this status endpoint (you'll get the condensed view automatically)
2. Read the executive summary to understand if the query was answered
3. Use \`read_report\` with section citations to read specific parts (e.g., \`R-135216:key_findings\`)
4. ONLY use full=true if user explicitly requests the complete report

Poll this endpoint every ~30 seconds until status is "completed" or "failed".`,
    inputSchema: {
      job_id: z.string().describe('The job_id returned from start_research'),
      full: z.boolean().optional().describe('Set to true ONLY if user explicitly asks for the complete report. Default condensed view is usually sufficient.'),
    },
  },
  async ({ job_id, full }) => {
    // First check in-memory cache
    let job = jobs.get(job_id);
    
    // If not in memory, try loading from file (handles server restart case)
    if (!job) {
      const fileJob = await loadJob(job_id);
      if (fileJob) {
        job = fileJob;
        // Re-cache in memory for future lookups
        jobs.set(job_id, job);
        console.error(`[Jobs] Loaded job ${job_id} from file`);
      }
    }

    if (!job) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'Job not found',
              message: `No job with ID "${job_id}". Jobs expire after 1 hour.`,
            }, null, 2),
          },
        ],
        isError: true,
      };
    }

    // Track check count atomically in-memory (avoids race condition on concurrent calls)
    const MAX_CHECKS = 5;
    if (job.status === 'running' && job.progress && typeof job.progress === 'object') {
      // Atomic increment using in-memory Map (single-threaded Node.js guarantees atomicity)
      const currentCount = (jobCheckCounts.get(job_id) || 0) + 1;
      jobCheckCounts.set(job_id, currentCount);
      
      // Update progress object for response (not persisted - cosmetic only)
      job.progress.checkCount = currentCount;
      job.progress.maxChecks = MAX_CHECKS;
    }

    const response: Record<string, unknown> = {
      job_id: job.id,
      status: job.status,
      query: job.query,
      created_at: new Date(job.createdAt).toISOString(),
    };

    // Add structured progress or string progress
    if (job.status === 'running') {
      if (typeof job.progress === 'object') {
        response.progress = {
          ...job.progress,
          ...(job.progress.checkCount && job.progress.checkCount >= 3 ? {
            message: `Still running (${job.progress.checkCount}/${MAX_CHECKS} checks). If unresponsive after ${MAX_CHECKS} checks, inform user and exit.`
          } : {}),
        };
      } else {
        response.progress = job.progress;
      }
    }

    if (job.completedAt) {
      response.completed_at = new Date(job.completedAt).toISOString();
      response.duration_seconds = Math.round((job.completedAt - job.createdAt) / 1000);
      // Clean up in-memory check counter for completed/failed jobs
      jobCheckCounts.delete(job_id);
    }

    if (job.status === 'completed' && job.result) {
      // If for_panel was requested, return structured JSON directly (no parsing)
      if (job.forPanel && job.reportPath) {
        const panelOutput = buildPanelOutput(job.structured, job.query, job.reportPath);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(panelOutput, null, 2),
            },
          ],
        };
      }
      
      // Return condensed view by default if sections are available
      if (!full && job.structured?.sections && job.structured?.executiveSummary && job.reportPath) {
        const reportId = generateReportId(job.reportPath);
        
        // Check if summaries are actually summaries (not full content)
        // If any summary is >1000 chars, regenerate all summaries on-the-fly
        const sections = job.structured.sections;
        const needsRegeneration = Object.values(sections).some(
          (section: any) => !section.summary || section.summary.length > 1000
        );
        
        if (needsRegeneration) {
          console.error('[Jobs] Old job detected, regenerating summaries on-the-fly...');
          
          const ctrl = getController();
          await generateSectionSummaries(sections, ctrl.getEnv().GEMINI_API_KEY);
        }
        
        const condensedView = formatCondensedView(
          reportId,
          job.query,
          job.structured.executiveSummary,
          sections
        );
        
        return {
          content: [
            {
              type: 'text',
              text: condensedView + `\n\n---\n**Report saved to**: \`${job.reportPath}\``,
            },
          ],
        };
      }
      
      // Return full report if requested or if sections not available
      response.result = job.result;
      if (job.reportPath) {
        response.report_path = job.reportPath;
      }
    }

    if (job.status === 'failed' && job.error) {
      response.error = job.error;
    }

    return {
      content: [
        {
          type: 'text',
          text: job.status === 'completed' && job.result 
            ? job.result + (job.reportPath ? `\n\n---\n**Report saved to**: \`${job.reportPath}\`` : '')
            : JSON.stringify(response, null, 2),
        },
      ],
    };
  }
);


/**
 * Build structured output for agent-chat panel integration
 * Uses the structured ResearchResult directly - NO PARSING/REGEX NEEDED
 * 
 * This is the smart approach: preserve structure from generation time
 * rather than trying to parse it back from markdown (which is brittle).
 */

// Start the server
async function main() {
  console.error('[Research MCP] Starting server...');
  
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  console.error('[Research MCP] Server ready on stdio');
  console.error('[Research MCP] Available tools: start_research, check_research_status, read_report, read_paper, download_paper');
  console.error('[Research MCP] Note: Synchronous "research" tool is disabled due to Cursor MCP timeout limits');

  // Cleanup on exit
  process.on('SIGINT', async () => {
    console.error('\n[Research MCP] Shutting down...');
    const ctrl = getController();
    await ctrl.cleanup();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.error('\n[Research MCP] Shutting down...');
    const ctrl = getController();
    await ctrl.cleanup();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('[Research MCP] Fatal error:', error);
  process.exit(1);
});

