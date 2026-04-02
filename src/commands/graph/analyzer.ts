import type { JournalEntry, ToolData } from "./types.js";
import { extractToolData } from "./tools.js";

/**
 * Analyze session entries to get token breakdown by model.
 */
export function analyzeSession(entries: JournalEntry[]): {
  inputTokens: number;
  outputTokens: number;
  opusTokens: number;
  sonnetTokens: number;
  haikuTokens: number;
  cacheHitRate: number;
  repeatedReads: number;
  modelEfficiency: number;
} {
  let inputTokens = 0;
  let outputTokens = 0;
  let opusTokens = 0;
  let sonnetTokens = 0;
  let haikuTokens = 0;
  let cacheRead = 0;
  let totalInput = 0;
  const fileReadCounts = new Map<string, number>();

  for (const entry of entries) {
    // Count file reads for repeatedReads metric
    if (entry.message?.content && Array.isArray(entry.message.content)) {
      for (const block of entry.message.content) {
        if (block.type === "tool_use" && block.name === "Read" && block.input) {
          const filePath = (block.input as { file_path?: string }).file_path;
          if (filePath) {
            fileReadCounts.set(filePath, (fileReadCounts.get(filePath) || 0) + 1);
          }
        }
      }
    }

    if (!entry.message?.usage) continue;
    const usage = entry.message.usage;
    const model = entry.message.model || "";
    const tokens = (usage.input_tokens || 0) + (usage.output_tokens || 0);

    inputTokens += usage.input_tokens || 0;
    outputTokens += usage.output_tokens || 0;
    cacheRead += usage.cache_read_input_tokens || 0;
    totalInput += usage.input_tokens || 0;

    if (model.includes("opus")) opusTokens += tokens;
    else if (model.includes("sonnet")) sonnetTokens += tokens;
    else if (model.includes("haiku")) haikuTokens += tokens;
  }

  // Count files read more than once
  let repeatedReads = 0;
  for (const count of fileReadCounts.values()) {
    if (count > 1) repeatedReads += count - 1;
  }

  const totalTokens = opusTokens + sonnetTokens + haikuTokens;

  return {
    inputTokens,
    outputTokens,
    opusTokens,
    sonnetTokens,
    haikuTokens,
    cacheHitRate: totalInput > 0 ? cacheRead / totalInput : 0,
    repeatedReads,
    modelEfficiency: totalTokens > 0 ? opusTokens / totalTokens : 0,
  };
}

/**
 * Aggregate tool usage across all entries in a session.
 * Returns combined tool data for session-level tooltips (aggregated by name).
 */
export function aggregateSessionTools(entries: JournalEntry[]): ToolData[] {
  const toolAgg = new Map<string, { count: number; inputTokens: number; outputTokens: number }>();

  for (const entry of entries) {
    if (!entry.message?.content || typeof entry.message.content === "string") continue;
    if (!entry.message.usage) continue;

    const inputTokens = entry.message.usage.input_tokens || 0;
    const outputTokens = entry.message.usage.output_tokens || 0;
    const turnTools = extractToolData(entry.message.content, inputTokens, outputTokens);

    for (const tool of turnTools) {
      const existing = toolAgg.get(tool.name);
      if (existing) {
        existing.count += 1;
        existing.inputTokens += tool.inputTokens;
        existing.outputTokens += tool.outputTokens;
      } else {
        toolAgg.set(tool.name, {
          count: 1,
          inputTokens: tool.inputTokens,
          outputTokens: tool.outputTokens,
        });
      }
    }
  }

  // Convert to array and sort by token usage
  const tools: ToolData[] = [...toolAgg.entries()].map(([name, data]) => ({
    name,
    detail: `${data.count}x`,
    inputTokens: data.inputTokens,
    outputTokens: data.outputTokens,
  }));
  tools.sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));

  return tools;
}

/**
 * Get the primary model name from analysis results.
 */
export function getPrimaryModel(analysis: {
  opusTokens: number;
  sonnetTokens: number;
  haikuTokens: number;
}): string {
  const { opusTokens, sonnetTokens, haikuTokens } = analysis;
  if (opusTokens >= sonnetTokens && opusTokens >= haikuTokens) return "Opus";
  if (sonnetTokens >= haikuTokens) return "Sonnet";
  return "Haiku";
}

/**
 * Get a short model name from the full model string.
 */
export function getModelName(model?: string): string {
  if (!model) return "unknown";
  if (model.includes("opus")) return "Opus";
  if (model.includes("sonnet")) return "Sonnet";
  if (model.includes("haiku")) return "Haiku";
  return model.split("-")[0] || "unknown";
}

/**
 * Extract project name from encoded directory name.
 */
export function extractProjectName(encodedProject: string): string {
  // Directory names encode paths: -home-ctowles-code-p-towles-tool
  const parts = encodedProject.split("-").filter(Boolean);
  const pathMarkers = new Set(["code", "projects", "src", "p", "repos", "git", "workspace"]);

  // Find LAST index of a path marker
  let lastMarkerIdx = -1;
  for (let i = 0; i < parts.length; i++) {
    if (pathMarkers.has(parts[i].toLowerCase())) {
      lastMarkerIdx = i;
    }
  }

  // Take everything after the last marker
  const projectParts = lastMarkerIdx >= 0 ? parts.slice(lastMarkerIdx + 1) : parts.slice(-2);

  if (projectParts.length === 0) {
    return parts[parts.length - 1] || encodedProject.slice(0, 20);
  }
  return projectParts.join("-");
}
