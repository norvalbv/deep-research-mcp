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
} from './jobs.js';
import { buildPanelOutput, generateFilename, buildEnrichedContext } from './panel-output.js';
import { registerReport } from './storage/report-registry.js';
import { compressText } from './clients/llm.js';

// Create the MCP server
const server = new McpServer({
  name: 'deep-research-mcp',
  version: '1.0.0',
});

// Initialize research controller (will be initialized on first use with env from MCP)
let controller: ResearchController | null = null;
const arxivClientPromise = createArxivClient();

function getController(): ResearchController {
  if (!controller) {
    // Note: process.env is populated by MCP server at runtime from mcp.json
    controller = new ResearchController(process.env as Record<string, string>);
  }
  return controller;
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
        .max(5)
        .optional()
        .describe('Research depth: 1=quick facts, 2-3=analysis, 4-5=deep academic research. Auto-detected if not provided.'),
      
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
        .enum(['summary', 'detailed', 'actionable_steps'])
        .optional()
        .describe('Preferred output format. "summary" for overview, "detailed" for comprehensive analysis, "actionable_steps" for implementation guide'),
      
      include_code_examples: z
        .boolean()
        .optional()
        .describe('Whether to include code examples in results. Default: true'),
      
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
      const result = await controller.execute(
        query,
        enrichedContext,
        depth_level as ComplexityLevel | undefined,
        {
          subQuestions: sub_questions,
          constraints,
          includeCodeExamples: include_code_examples,
          techStack: tech_stack,
          papersRead: papers_read,
          outputFormat: output_format,
        }
      );

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
    const arxivClient = (await arxivClientPromise).client;
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
    const arxivClient = (await arxivClientPromise).client;
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
// Read specific lines from research reports using citation format

server.registerTool(
  'read_report',
  {
    title: 'Read Research Report Lines',
    description: `Read specific lines from a research report using citation format.
    
**Input formats supported:**
- Full citation: "[R-135216:5-19]" or "R-135216:5-19" - returns lines 5-19 from report R-135216. It's recommended to only read part of the report as reading the entire report can bloat context and cause errors.
- Report ID only: "R-135216" - returns full report
- Line range with report_path: { lines: "5-19", report_path: "/path/to/report.md" }

Use this when personas cite research and you need to verify the actual content.`,
    inputSchema: {
      citation: z.string().optional().describe('Citation in format [R-NNNNNNN:N-N] or R-NNNNNNN or just R-NNNNNNN'),
      report_path: z.string().optional().describe('Direct path to report file (alternative to citation)'),
      lines: z.string().optional().describe('Line range in format "N-N" (e.g., "5-19")'),
    },
  },
  async ({ citation, report_path, lines }) => {
    try {
      let targetPath: string | undefined = report_path;
      let lineRange: { start: number; end: number } | undefined;

      // Parse citation if provided
      if (citation) {
        // Remove brackets if present: [R-135216:5-19] -> R-135216:5-19
        const cleanCitation = citation.replace(/^\[|\]$/g, '');
        
        // Parse report ID and line range
        const match = cleanCitation.match(/^(R-\d+)(?::(\d+)-(\d+))?$/);
        if (!match) {
          return {
            content: [{
              type: 'text' as const,
              text: `Invalid citation format: "${citation}". Expected format: [R-NNNNNNN:N-N] or R-NNNNNNN`
            }]
          };
        }

        const reportId = match[1];
        const startLine = match[2] ? parseInt(match[2]) : undefined;
        const endLine = match[3] ? parseInt(match[3]) : undefined;

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
        if (startLine !== undefined && endLine !== undefined) {
          lineRange = { start: startLine, end: endLine };
        }
      }

      // Parse lines parameter if provided
      if (lines && !lineRange) {
        const match = lines.match(/^(\d+)-(\d+)$/);
        if (match) {
          lineRange = { start: parseInt(match[1]), end: parseInt(match[2]) };
        }
      }

      // Read the report file
      if (!targetPath) {
        return {
          content: [{
            type: 'text' as const,
            text: 'Error: Either citation or report_path must be provided'
          }]
        };
      }

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

      let resultLines: string[];
      if (lineRange) {
        // Return specific line range (1-indexed)
        resultLines = allLines.slice(lineRange.start - 1, lineRange.end);
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
        .max(5)
        .optional()
        .describe('Research depth, range 1-5. 1 = web search, 2 = (1) + library docs, 3 = (1 + 2) + deep analysis, 4 = (1 + 2 + 3) + multi-model consensus, 5 = (1 + 2 + 3 + 4) + academic papers. Auto-detected if not provided.'),
      
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
        .enum(['summary', 'detailed', 'actionable_steps'])
        .optional()
        .describe('Preferred output format. "summary" for overview, "detailed" for comprehensive analysis, "actionable_steps" for implementation guide'),
      
      include_code_examples: z
        .boolean()
        .optional()
        .describe('Whether to include code examples in results. Default: true'),
      
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
      
      // TODO for future panel integration 😝
      // for_panel: z
      //   .boolean()
      //   .optional()
      //   .describe('Return structured JSON for direct use with agent-chat send_message. When true, returns { summary, key_findings, recommendations, report_path } that can be passed directly to send_message(research_findings: ...). This ensures research findings are formatted correctly for panel discussions.'),
    },
  },
  async (params: { query: string; project_description: string | undefined; current_state: string | undefined; problem_statement: string | undefined; constraints: string[] | undefined; domain: string | undefined; date_range: string | undefined; depth_level: number | undefined; papers_read: string[] | undefined; key_findings: string[] | undefined; rejected_approaches: string[] | undefined; output_format: 'summary' | 'detailed' | 'actionable_steps' | undefined; include_code_examples: boolean | undefined; sub_questions: string[] | undefined; tech_stack: string[] | undefined; existing_data_samples: string | undefined; target_metrics: string[] | undefined; }) => {
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

    // Start research in background (don't await)
    (async () => {
      try {
        job.status = 'running';
        job.progress = 'Executing research...';
        await saveJob(job); // Persist status change
        
        const ctrl = getController();
        await ctrl.initialize();
        
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

        const result = await ctrl.execute({
          query,
          enrichedContext,
          depthLevel: depth_level as ComplexityLevel,
          options: {
            subQuestions: sub_questions || [],
            constraints: constraints || [],
            includeCodeExamples: include_code_examples,
            techStack: tech_stack || [],
            papersRead: papers_read || [],
            outputFormat: output_format || 'summary',
          }
        });

        job.status = 'completed';
        job.completedAt = Date.now();
        job.result = result.markdown;
        job.progress = 'Complete';
        
        // Store structured result directly (no parsing needed later)
        const structuredResult = result.result;
        job.structured = {
          synthesis: structuredResult.synthesis,
          critiques: structuredResult.challenge?.critiques,
          criticalGaps: structuredResult.sufficiency?.criticalGaps,
          sources: structuredResult.execution.perplexityResult?.sources,
          papers: structuredResult.execution.arxivPapers?.papers?.map(p => ({
            id: p.id,
            title: p.title,
            summary: p.summary,
            url: p.url,
          })),
        };
        
        // Always save report file (needed for for_panel and generally useful)
        try {
          const reportDir = join(homedir(), 'research-reports');
          const filename = generateFilename(query);
          const filepath = join(reportDir, filename);
          await mkdir(reportDir, { recursive: true });
          await writeFile(filepath, result.markdown, 'utf-8');
          job.reportPath = filepath;
          console.error(`[Jobs] Report saved to: ${filepath}`);
          
          // Register in report registry for future reference
          registerReport({
            path: filepath,
            timestamp: new Date().toISOString(),
            query: query,
            summary: job.structured?.synthesis?.slice(0, 200) + '...' || 'Research completed',
            keyFindings: job.structured?.synthesis?.split('\n').filter(l => l.trim().startsWith('-')).slice(0, 3),
          });
        } catch (err) {
          console.error(`[Jobs] Failed to save report:`, err);
        }
        
        await saveJob(job); // Persist completed result
        console.error(`[Jobs] Job ${jobId} completed successfully`);
      } catch (error: any) {
        job.status = 'failed';
        job.completedAt = Date.now();
        job.error = error.message || String(error);
        job.progress = 'Failed';
        await saveJob(job); // Persist failure
        console.error(`[Jobs] Job ${jobId} failed:`, error.message);
      }
    })();

    // Return immediately with job ID and EXPLICIT wait instruction
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            job_id: jobId,
            status: 'pending',
            message: 'Research job started. IMPORTANT: Wait at LEAST 120 seconds before calling check_research_status. Research typically takes about 2-3 minutes to complete but can take longer if the research is complex.',
            estimated_duration_seconds: 120,
            next_action: 'Run sleep in the terminal for 120 seconds before calling check_research_status. Or alternatively, tell the user you must wait and exit.',
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
- completed: Research finished, result is included
- failed: Research failed, error is included

Poll this endpoint every ~30 seconds until status is "completed" or "failed".`,
    inputSchema: {
      job_id: z.string().describe('The job_id returned from start_research'),
    },
  },
  async ({ job_id }) => {
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

    const response: Record<string, unknown> = {
      job_id: job.id,
      status: job.status,
      query: job.query,
      progress: job.progress,
      created_at: new Date(job.createdAt).toISOString(),
    };

    if (job.completedAt) {
      response.completed_at = new Date(job.completedAt).toISOString();
      response.duration_seconds = Math.round((job.completedAt - job.createdAt) / 1000);
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

