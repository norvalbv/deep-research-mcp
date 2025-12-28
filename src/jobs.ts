import { writeFile, readFile, mkdir, unlink } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { Section, ExecutiveSummary } from './types/index.js';

// Jobs directory for file-based persistence
export const JOBS_DIR = join(homedir(), '.research-jobs');

// Structured progress info for agents to make informed polling decisions
export interface ProgressInfo {
  currentStep: string;
  stepNumber: number;
  totalSteps: number;
  estimatedSecondsRemaining: number;
  checkCount?: number;       // How many times check_status called
  maxChecks?: number;        // Limit before suggesting user exit
  note?: string;             // e.g., "Poor results, re-synthesizing..."
}

// Structured research result (from controller) - stored for direct access
export interface StructuredResearchResult {
  synthesis: string;
  critiques?: Array<{ section: string; issue: string }>;
  criticalGaps?: string[];
  sources?: string[];
  papers?: Array<{ id: string; title: string; summary: string; url: string }>;
  
  // Sectioned content for on-demand reading
  sections?: Record<string, Section>;
  
  // Executive summary for quick overview
  executiveSummary?: ExecutiveSummary;
}

export interface ResearchJob {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  query: string;
  createdAt: number;
  completedAt?: number;
  result?: string; // Markdown report
  structured?: StructuredResearchResult; // Direct structured data (no parsing needed)
  error?: string;
  progress?: string | ProgressInfo; // Structured progress for informed polling
  forPanel?: boolean; // Return structured JSON for agent-chat integration
  reportPath?: string; // Path to saved report file
}

// In-memory job storage
export const jobs = new Map<string, ResearchJob>();

/**
 * Generate unique job ID
 */
export function generateJobId(): string {
  return `research-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Save job to file system
 */
export async function saveJob(job: ResearchJob): Promise<void> {
  try {
    await mkdir(JOBS_DIR, { recursive: true });
    await writeFile(join(JOBS_DIR, `${job.id}.json`), JSON.stringify(job, null, 2), 'utf-8');
  } catch (error) {
    console.error(`[Jobs] Failed to save job ${job.id}:`, error);
  }
}

/**
 * Load job from file system
 */
export async function loadJob(jobId: string): Promise<ResearchJob | null> {
  try {
    const data = await readFile(join(JOBS_DIR, `${jobId}.json`), 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * Delete job file
 */
export async function deleteJobFile(jobId: string): Promise<void> {
  try {
    await unlink(join(JOBS_DIR, `${jobId}.json`));
  } catch {
    // Ignore if file doesn't exist
  }
}
