import * as fs from "node:fs";
import * as path from "node:path";
import { extractProjectName } from "./analyzer.js";
import { calculateCutoffMs, quickTokenCount } from "./parser.js";
import type { BarChartData, BarChartDay, ProjectBar, SessionResult } from "./types.js";

/**
 * Find recent sessions from the projects directory.
 */
export function findRecentSessions(
  projectsDir: string,
  limit: number,
  days: number,
): SessionResult[] {
  const sessions: SessionResult[] = [];

  const cutoffMs = calculateCutoffMs(days);

  const projectDirs = fs.readdirSync(projectsDir);
  for (const project of projectDirs) {
    const projectPath = path.join(projectsDir, project);
    if (!fs.statSync(projectPath).isDirectory()) continue;

    const files = fs.readdirSync(projectPath).filter((f) => f.endsWith(".jsonl"));
    for (const file of files) {
      const filePath = path.join(projectPath, file);
      const stat = fs.statSync(filePath);

      // Filter by days if cutoff is set
      if (cutoffMs > 0 && stat.mtimeMs < cutoffMs) continue;

      const sessionId = file.replace(".jsonl", "");

      // Quick token count from file
      const tokens = quickTokenCount(filePath);

      sessions.push({
        sessionId,
        path: filePath,
        date: stat.mtime.toLocaleDateString("en-CA"), // YYYY-MM-DD in local timezone
        tokens,
        project,
        mtime: stat.mtimeMs,
      });
    }
  }

  // Sort by modification time, most recent first
  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions.slice(0, limit);
}

/**
 * Find the file path for a specific session ID.
 */
export function findSessionPath(projectsDir: string, sessionId: string): string | undefined {
  const projectDirs = fs.readdirSync(projectsDir);
  for (const project of projectDirs) {
    const projectPath = path.join(projectsDir, project);
    if (!fs.statSync(projectPath).isDirectory()) continue;

    const jsonlPath = path.join(projectPath, `${sessionId}.jsonl`);
    if (fs.existsSync(jsonlPath)) {
      return jsonlPath;
    }
  }
  return undefined;
}

/**
 * Build bar chart data structure from session results.
 * Groups sessions by date and project folder, aggregating tokens per project per day.
 */
export function buildBarChartData(sessions: SessionResult[]): BarChartData {
  if (sessions.length === 0) {
    return { days: [] };
  }

  // Group sessions by date, then by project
  const byDateProject = new Map<string, Map<string, number>>();

  for (const session of sessions) {
    const project = extractProjectName(session.project);

    if (!byDateProject.has(session.date)) {
      byDateProject.set(session.date, new Map());
    }
    const projectMap = byDateProject.get(session.date)!;
    projectMap.set(project, (projectMap.get(project) || 0) + session.tokens);
  }

  // Build days array sorted chronologically (oldest first for x-axis)
  const sortedDates = [...byDateProject.keys()].sort();
  const days: BarChartDay[] = sortedDates.map((date) => {
    const projectMap = byDateProject.get(date)!;
    // Sort projects by total tokens descending
    const projects: ProjectBar[] = [...projectMap.entries()]
      .map(([project, totalTokens]) => ({ project, totalTokens }))
      .sort((a, b) => b.totalTokens - a.totalTokens);
    return { date, projects };
  });

  return { days };
}
