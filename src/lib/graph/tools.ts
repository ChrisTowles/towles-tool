import type { ContentBlock, ToolData } from "./types.js";

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
