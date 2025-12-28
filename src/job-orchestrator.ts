import { ResearchController, OnProgressCallback } from './controller.js';
import { ComplexityLevel } from './types/index.js';
import { ResearchJob, saveJob, JOBS_DIR, ProgressInfo } from './jobs.js';
import { buildEnrichedContext, generateFilename, generateReportId } from './panel-output.js';
import { registerReport } from './storage/report-registry.js';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

export interface StartResearchParams {
  query: string;
  project_description?: string;
  current_state?: string;
  problem_statement?: string;
  constraints?: string[];
  domain?: string;
  date_range?: string;
  depth_level?: number;
  papers_read?: string[];
  key_findings?: string[];
  rejected_approaches?: string[];
  output_format?: 'summary' | 'detailed' | 'actionable_steps' | 'direct';
  include_code_examples?: boolean;
  sub_questions?: string[];
  tech_stack?: string[];
  existing_data_samples?: string;
  target_metrics?: string[];
}

export interface JobStartResult {
  jobId: string;
  determinedDepth: number;
  estimatedSeconds: number;
}

/**
 * Calculate estimated wait time based on depth level
 * Depth 1: 20s (quick lookup), 2: 40s, 3: 80s, 4: 180s (full research)
 */
function calculateWaitTime(depth: number): number {
  return [20, 40, 80, 180][Math.min(depth, 4) - 1];
}

/**
 * Start a research job with accurate wait time estimation.
 * 
 * Flow:
 * 1. Build enriched context from params
 * 2. Call controller.plan() to determine depth (awaits planning)
 * 3. Store depth in job
 * 4. Fire off execution in background
 * 5. Return jobId, determined depth, and accurate wait time
 */
export async function startResearchJob(
  job: ResearchJob,
  params: StartResearchParams,
  controller: ResearchController
): Promise<JobStartResult> {
  const { query, depth_level } = params;

  // Initialize controller
  await controller.initialize();

  // Build enriched context for planning
  const enrichedContext = buildEnrichedContext({
    project_description: params.project_description,
    current_state: params.current_state,
    problem_statement: params.problem_statement,
    constraints: params.constraints,
    domain: params.domain,
    date_range: params.date_range,
    papers_read: params.papers_read,
    key_findings: params.key_findings,
    rejected_approaches: params.rejected_approaches,
    output_format: params.output_format,
    include_code_examples: params.include_code_examples,
    sub_questions: params.sub_questions,
    tech_stack: params.tech_stack,
    existing_data_samples: params.existing_data_samples,
    target_metrics: params.target_metrics,
  });

  // Determine depth via planning (this is the key change - we await this)
  const actionPlan = await controller.plan(query, enrichedContext, depth_level as ComplexityLevel, {
    subQuestions: params.sub_questions || [],
    constraints: params.constraints || [],
    includeCodeExamples: params.include_code_examples,  // undefined = let planner decide
    techStack: params.tech_stack || [],
    papersRead: params.papers_read || [],
    outputFormat: params.output_format || 'summary',
  });

  const determinedDepth = depth_level || actionPlan.complexity;
  console.error(`[Jobs] Determined depth ${determinedDepth} for job ${job.id}`);

  // Fire off execution in background (don't await)
  executeResearchInBackground(job, params, controller, enrichedContext, determinedDepth);

  return {
    jobId: job.id,
    determinedDepth,
    estimatedSeconds: calculateWaitTime(determinedDepth),
  };
}

/**
 * Execute research in background after planning is complete
 */
async function executeResearchInBackground(
  job: ResearchJob,
  params: StartResearchParams,
  controller: ResearchController,
  enrichedContext: string,
  determinedDepth: number
): Promise<void> {
  try {
    job.status = 'running';
    job.progress = { currentStep: 'Initializing', stepNumber: 1, totalSteps: 8, estimatedSecondsRemaining: 90 };
    await saveJob(job);

    // Create progress callback to update job in real-time
    const onProgress: OnProgressCallback = (progress: ProgressInfo) => {
      job.progress = progress;
      // Fire-and-forget save to avoid blocking
      saveJob(job).catch(err => console.error(`[Jobs] Failed to save progress:`, err));
    };

    const result = await controller.execute({
      query: params.query,
      enrichedContext,
      depthLevel: determinedDepth as ComplexityLevel,
      options: {
        subQuestions: params.sub_questions || [],
        constraints: params.constraints || [],
        includeCodeExamples: params.include_code_examples,  // undefined = let planner decide
        techStack: params.tech_stack || [],
        papersRead: params.papers_read || [],
        outputFormat: params.output_format || 'summary',
      },
      onProgress,
    });

    job.status = 'completed';
    job.completedAt = Date.now();
    job.result = result.markdown;
    job.progress = 'Complete';

    // Store structured result
    const structuredResult = result.result;
    const synthesisText = structuredResult.synthesis.overview + 
      (structuredResult.synthesis.subQuestions 
        ? '\n\n' + Object.values(structuredResult.synthesis.subQuestions)
            .map(sq => `## ${sq.question}\n${sq.answer}`).join('\n\n')
        : '') +
      (structuredResult.synthesis.additionalInsights 
        ? '\n\n## Additional Insights\n' + structuredResult.synthesis.additionalInsights
        : '');

    job.structured = {
      synthesis: synthesisText,
      critiques: structuredResult.challenge?.critiques,
      criticalGaps: structuredResult.sufficiency?.criticalGaps,
      sources: structuredResult.execution.perplexityResult?.sources,
      papers: structuredResult.execution.arxivPapers?.papers?.map(p => ({
        id: p.id,
        title: p.title,
        summary: p.summary,
        url: p.url,
      })),
      sections: result.sections,
      executiveSummary: result.executiveSummary,
    };

    // Save report file
    try {
      const reportDir = join(homedir(), 'research-reports');
      const filename = generateFilename(params.query);
      const filepath = join(reportDir, filename);
      await mkdir(reportDir, { recursive: true });
      await writeFile(filepath, result.markdown, 'utf-8');
      job.reportPath = filepath;
      console.error(`[Jobs] Report saved to: ${filepath}`);

      // Register in report registry
      const jobFilePath = join(JOBS_DIR, `${job.id}.json`);
      const reportId = generateReportId(filepath);
      registerReport({
        path: jobFilePath,
        markdownPath: filepath,
        reportId: reportId,
        timestamp: new Date().toISOString(),
        query: params.query,
        summary: job.structured?.synthesis?.slice(0, 200) + '...' || 'Research completed',
        keyFindings: job.structured?.synthesis?.split('\n').filter(l => l.trim().startsWith('-')).slice(0, 3),
      });
    } catch (err) {
      console.error(`[Jobs] Failed to save report:`, err);
    }

    await saveJob(job);
    console.error(`[Jobs] Job ${job.id} completed successfully`);
  } catch (error: any) {
    job.status = 'failed';
    job.completedAt = Date.now();
    job.error = error.message || String(error);
    job.progress = 'Failed';
    await saveJob(job);
    console.error(`[Jobs] Job ${job.id} failed:`, error.message);
  }
}

