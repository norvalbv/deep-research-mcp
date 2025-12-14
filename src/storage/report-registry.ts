import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const REGISTRY_DIR = join(homedir(), '.research-mcp');
const REGISTRY_FILE = join(REGISTRY_DIR, 'report-registry.json');

export interface ReportMetadata {
  path: string;        // Job JSON path for structured access
  markdownPath?: string; // Optional markdown path for human reading
  reportId: string;    // Report ID (e.g., "R-015823")
  timestamp: string;
  query: string;
  summary: string; // 1-2 sentences
  keyFindings?: string[];
  keyGaps?: string[];
}

interface Registry {
  reports: ReportMetadata[];
  lastUpdated: string;
}

/**
 * Ensure registry directory exists
 */
function ensureDir(): void {
  if (!existsSync(REGISTRY_DIR)) {
    mkdirSync(REGISTRY_DIR, { recursive: true });
  }
}

/**
 * Load registry from disk
 */
export function loadRegistry(): Registry {
  ensureDir();
  
  if (!existsSync(REGISTRY_FILE)) {
    return { reports: [], lastUpdated: new Date().toISOString() };
  }
  
  try {
    return JSON.parse(readFileSync(REGISTRY_FILE, 'utf-8'));
  } catch {
    return { reports: [], lastUpdated: new Date().toISOString() };
  }
}

/**
 * Save registry to disk
 */
function saveRegistry(registry: Registry): void {
  ensureDir();
  registry.lastUpdated = new Date().toISOString();
  writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2));
}

/**
 * Register a new report
 */
export function registerReport(metadata: ReportMetadata): void {
  const registry = loadRegistry();
  
  // Avoid duplicates based on path
  const existing = registry.reports.findIndex(r => r.path === metadata.path);
  if (existing >= 0) {
    registry.reports[existing] = metadata;
  } else {
    registry.reports.unshift(metadata); // Most recent first
  }
  
  // Keep last 100 reports
  if (registry.reports.length > 100) {
    registry.reports = registry.reports.slice(0, 100);
  }
  
  saveRegistry(registry);
}

/**
 * Get all reports (most recent first)
 */
export function getAllReports(limit: number = 20): ReportMetadata[] {
  const registry = loadRegistry();
  return registry.reports.slice(0, limit);
}

/**
 * Search reports by query or summary
 */
export function searchReports(searchTerm: string): ReportMetadata[] {
  const registry = loadRegistry();
  const term = searchTerm.toLowerCase();
  
  return registry.reports.filter(r => 
    r.query.toLowerCase().includes(term) ||
    r.summary.toLowerCase().includes(term)
  );
}

/**
 * Get report by path
 */
export function getReportByPath(path: string): ReportMetadata | undefined {
  const registry = loadRegistry();
  return registry.reports.find(r => r.path === path);
}

/**
 * Get report by ID
 * Report ID format: R-HHMMSS (e.g., R-135216) or R-015823
 */
export function getReportById(reportId: string): ReportMetadata | undefined {
  const registry = loadRegistry();
  // First try direct match by reportId field
  let report = registry.reports.find(r => (r as any).reportId === reportId);
  if (report) return report;
  
  // Fallback: search by timestamp in path (legacy)
  const timestamp = reportId.replace(/^R-/, '');
  return registry.reports.find(r => r.path.includes(timestamp));
}

/**
 * Format registry summary for agent context (compact)
 */
export function formatRegistryForContext(limit: number = 10): string {
  const reports = getAllReports(limit);
  
  if (reports.length === 0) {
    return "No previous research reports available.";
  }
  
  const lines = ["AVAILABLE RESEARCH REPORTS (most recent first):"];
  reports.forEach((r, i) => {
    lines.push(`${i + 1}. [${r.timestamp.slice(0, 10)}] ${r.query}`);
    lines.push(`   Summary: ${r.summary}`);
    lines.push(`   Path: ${r.path}`);
  });
  
  return lines.join("\n");
}




