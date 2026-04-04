import { analyzeSession, extractProjectName, getPrimaryModel } from "./analyzer.js";
import { parseJsonl } from "./parser.js";
import type { SessionResult } from "./types.js";

export type OutputFormat = "html" | "json" | "csv";

export interface SessionRow {
  sessionPath: string;
  project: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  date: string;
}

// Approximate pricing per million tokens (as of 2025)
const COST_PER_MILLION: Record<string, { input: number; output: number }> = {
  opus: { input: 15, output: 75 },
  sonnet: { input: 3, output: 15 },
  haiku: { input: 0.8, output: 4 },
};

function estimateCost(analysis: {
  opusTokens: number;
  sonnetTokens: number;
  haikuTokens: number;
  inputTokens: number;
  outputTokens: number;
}): number {
  const total = analysis.opusTokens + analysis.sonnetTokens + analysis.haikuTokens;
  if (total === 0) return 0;

  // Distribute input/output proportionally across models
  let cost = 0;
  for (const [model, tokens] of [
    ["opus", analysis.opusTokens],
    ["sonnet", analysis.sonnetTokens],
    ["haiku", analysis.haikuTokens],
  ] as const) {
    if (tokens === 0) continue;
    const fraction = tokens / total;
    const inputShare = analysis.inputTokens * fraction;
    const outputShare = analysis.outputTokens * fraction;
    const rates = COST_PER_MILLION[model];
    cost += (inputShare * rates.input + outputShare * rates.output) / 1_000_000;
  }

  return Math.round(cost * 10000) / 10000; // 4 decimal places
}

/**
 * Build flat session rows from session results by parsing and analyzing each session.
 */
export function buildSessionRows(sessions: SessionResult[]): SessionRow[] {
  return sessions.map((session) => {
    const entries = parseJsonl(session.path);
    const analysis = analyzeSession(entries);
    const model = getPrimaryModel(analysis);
    const project = extractProjectName(session.project);
    const cost = estimateCost(analysis);

    return {
      sessionPath: session.path,
      project,
      model,
      inputTokens: analysis.inputTokens,
      outputTokens: analysis.outputTokens,
      totalTokens: analysis.inputTokens + analysis.outputTokens,
      cost,
      date: session.date,
    };
  });
}

/**
 * Format session rows as JSON string.
 */
export function formatJson(rows: SessionRow[]): string {
  return JSON.stringify(rows, null, 2);
}

/**
 * Format session rows as CSV string.
 */
export function formatCsv(rows: SessionRow[]): string {
  const header = "session_path,project,model,input_tokens,output_tokens,total_tokens,cost,date";
  const lines = rows.map(
    (r) =>
      `"${r.sessionPath}","${r.project}",${r.model},${r.inputTokens},${r.outputTokens},${r.totalTokens},${r.cost},${r.date}`,
  );
  return [header, ...lines].join("\n");
}
