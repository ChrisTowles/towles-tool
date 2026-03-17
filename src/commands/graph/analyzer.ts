import type { ContentBlock, JournalEntry, ToolData } from "./types.js";

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
 * Extract a meaningful label from session entries.
 */
export function extractSessionLabel(entries: JournalEntry[], sessionId: string): string {
  let firstUserText: string | undefined;
  let firstAssistantText: string | undefined;
  let gitBranch: string | undefined;
  let slug: string | undefined;

  for (const entry of entries) {
    // Extract metadata from any entry
    if (!gitBranch && (entry as any).gitBranch) {
      gitBranch = (entry as any).gitBranch;
    }
    if (!slug && (entry as any).slug) {
      slug = (entry as any).slug;
    }

    if (!entry.message) continue;

    // Look for first user message with actual text (not UUID reference)
    if (!firstUserText && entry.type === "user" && entry.message.role === "user") {
      const content = entry.message.content;
      if (typeof content === "string") {
        // Check if it's a UUID (skip those) or actual text
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          content,
        );
        if (!isUuid && content.length > 0) {
          firstUserText = content;
        }
      } else if (Array.isArray(content)) {
        // Look for text blocks in array content
        for (const block of content) {
          if (block.type === "text" && block.text && block.text.length > 0) {
            firstUserText = block.text;
            break;
          }
        }
      }
    }

    // Look for first assistant text response
    if (!firstAssistantText && entry.type === "assistant" && entry.message.role === "assistant") {
      const content = entry.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && block.text && block.text.length > 0) {
            firstAssistantText = block.text;
            break;
          }
        }
      }
    }

    // Stop early if we have user text
    if (firstUserText) break;
  }

  // Priority: user text > assistant text > git branch > slug > short ID
  let label = firstUserText || firstAssistantText || gitBranch || slug || sessionId.slice(0, 8);

  // Clean up the label
  label = label
    .replace(/^\/\S+\s*/, "") // Remove /command prefixes
    .replace(/<[^>]+>[^<]*<\/[^>]+>/g, "") // Remove XML-style tags with content
    .replace(/<[^>]+>/g, "") // Remove remaining XML tags
    .replace(/^\s*Caveat:.*$/m, "") // Remove caveat lines
    .replace(/\n.*/g, "") // Take only first line
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F]+/g, " ") // Replace control characters with space
    .trim();

  // If still empty or too short, use fallback
  if (label.length < 3) {
    label = slug || sessionId.slice(0, 8);
  }

  // Truncate very long labels (will be smart-truncated in UI based on box size)
  if (label.length > 80) {
    label = label.slice(0, 77) + "...";
  }

  return label;
}

/**
 * Sanitize string by replacing control characters (newlines, tabs, etc.) with spaces.
 */
export function sanitizeString(str: string): string {
  // Replace all control characters (ASCII 0-31) with space, collapse multiple spaces
  // eslint-disable-next-line no-control-regex
  return str.replace(/[\x00-\x1F]+/g, " ").trim();
}

/**
 * Truncate a string and extract just the filename for paths.
 */
export function truncateDetail(str: string | undefined, maxLen = 30): string | undefined {
  if (!str) return undefined;
  // Sanitize control characters first
  const sanitized = sanitizeString(str);
  // For file paths, show just the filename
  if (sanitized.includes("/")) {
    const parts = sanitized.split("/");
    const filename = parts[parts.length - 1];
    return filename.length > maxLen ? filename.slice(0, maxLen - 3) + "..." : filename;
  }
  return sanitized.length > maxLen ? sanitized.slice(0, maxLen - 3) + "..." : sanitized;
}

/**
 * Extract a meaningful detail string from tool input.
 */
export function extractToolDetail(
  toolName: string,
  input?: Record<string, unknown>,
): string | undefined {
  if (!input) return undefined;

  switch (toolName) {
    case "Read":
      return truncateDetail(input.file_path as string);
    case "Write":
    case "Edit":
      return truncateDetail(input.file_path as string);
    case "Bash":
      return truncateDetail(input.command as string, 50);
    case "Glob":
      return truncateDetail(input.pattern as string, 50);
    case "Grep":
      return truncateDetail(input.pattern as string, 50);
    case "Task":
      return truncateDetail(input.description as string, 50);
    case "WebFetch":
      return truncateDetail(input.url as string, 40);
    default:
      return undefined;
  }
}

/**
 * Extract individual tool calls from message content blocks.
 * Returns each tool call with its detail (file path, command, etc.).
 */
export function extractToolData(
  content: ContentBlock[] | string | undefined,
  turnInputTokens: number,
  turnOutputTokens: number,
): ToolData[] {
  if (!content || typeof content === "string") return [];

  // Collect individual tool_use blocks
  const toolBlocks: Array<{ name: string; detail?: string }> = [];
  for (const block of content) {
    if (block.type === "tool_use" && block.name) {
      const detail = extractToolDetail(block.name, block.input);
      toolBlocks.push({ name: block.name, detail });
    }
  }

  if (toolBlocks.length === 0) return [];

  // Distribute tokens proportionally across individual calls
  const tokensPerCall = {
    input: Math.round(turnInputTokens / toolBlocks.length),
    output: Math.round(turnOutputTokens / toolBlocks.length),
  };

  return toolBlocks.map((tool) => ({
    name: tool.name,
    detail: tool.detail,
    inputTokens: tokensPerCall.input,
    outputTokens: tokensPerCall.output,
  }));
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
