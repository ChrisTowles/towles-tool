import type { WriteStream } from "node:fs";
import { spawn } from "node:child_process";
import pc from "picocolors";
import { x } from "tinyexec";
import { CLAUDE_DEFAULT_ARGS } from "./state.js";

// ============================================================================
// Types
// ============================================================================

interface StreamEvent {
  type: string;
  event?: {
    type: string;
    delta?: { text?: string };
  };
  // New format: assistant message
  message?: {
    content?: Array<{ type: string; text?: string }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  result?: string;
  total_cost_usd?: number;
  num_turns?: number;
  session_id?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

// Claude model context windows (tokens)
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-sonnet-4-20250514": 200000,
  "claude-opus-4-20250514": 200000,
  "claude-3-5-sonnet-20241022": 200000,
  "claude-3-opus-20240229": 200000,
  default: 200000,
};

export interface IterationResult {
  output: string;
  exitCode: number;
  contextUsedPercent?: number;
  sessionId?: string;
}

interface ParsedLine {
  text: string | null;
  tool?: { name: string; summary: string };
  usage?: StreamEvent["usage"];
  sessionId?: string;
}

// ============================================================================
// Claude CLI Check
// ============================================================================

export async function checkClaudeCli(): Promise<boolean> {
  try {
    const result = await x("which", ["claude"]);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

// ============================================================================
// Stream Parsing
// ============================================================================

// Track accumulated text from assistant messages to compute deltas
let lastAssistantText = "";

/**
 * Reset stream parsing state between iterations.
 */
export function resetStreamState(): void {
  lastAssistantText = "";
}

function summarizeTool(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Read":
      return (
        String(input.file_path || input.path || "")
          .split("/")
          .pop() || "file"
      );
    case "Write":
    case "Edit":
      return (
        String(input.file_path || input.path || "")
          .split("/")
          .pop() || "file"
      );
    case "Glob":
      return String(input.pattern || "");
    case "Grep":
      return String(input.pattern || "");
    case "Bash":
      return String(input.command || "").substring(0, 40);
    case "TodoWrite":
      return "updating todos";
    default:
      return Object.values(input)[0]?.toString().substring(0, 30) || "";
  }
}

function parseStreamLine(line: string): ParsedLine {
  if (!line.trim()) return { text: null };
  try {
    const data = JSON.parse(line) as StreamEvent & {
      tool_use?: { name: string; input: Record<string, unknown> };
      content_block?: { type: string; name?: string; input?: Record<string, unknown> };
    };

    // Handle tool_use events
    if (data.type === "tool_use" && data.tool_use) {
      const name = data.tool_use.name;
      const summary = summarizeTool(name, data.tool_use.input || {});
      return { text: null, tool: { name, summary } };
    }

    // Handle content_block with tool_use (streaming format)
    if (data.type === "content_block" && data.content_block?.type === "tool_use") {
      const name = data.content_block.name || "Tool";
      const summary = summarizeTool(name, data.content_block.input || {});
      return { text: null, tool: { name, summary } };
    }

    // Extract text from streaming deltas (legacy format)
    if (data.type === "stream_event" && data.event?.type === "content_block_delta") {
      return { text: data.event.delta?.text || null };
    }
    // Add newline after content block ends (legacy format)
    if (data.type === "stream_event" && data.event?.type === "content_block_stop") {
      return { text: "\n" };
    }
    // NEW FORMAT: Handle assistant messages with content array
    if (data.type === "assistant" && data.message) {
      // Check for tool_use in content blocks
      const toolBlocks = data.message.content?.filter((c) => c.type === "tool_use") || [];
      if (toolBlocks.length > 0) {
        const tb = toolBlocks[toolBlocks.length - 1] as {
          name?: string;
          input?: Record<string, unknown>;
        };
        const name = tb.name || "Tool";
        const summary = summarizeTool(name, tb.input || {});
        return {
          text: null,
          tool: { name, summary },
          usage: data.message.usage || data.usage,
          sessionId: data.session_id,
        };
      }

      // Extract full text from content blocks
      const fullText =
        data.message.content
          ?.filter((c) => c.type === "text" && c.text)
          .map((c) => c.text)
          .join("") || "";

      // Compute delta (only new portion) to avoid duplicate output
      let delta: string | null = null;
      if (fullText.startsWith(lastAssistantText)) {
        delta = fullText.slice(lastAssistantText.length) || null;
      } else {
        // Text doesn't match prefix - new context
        delta = fullText || null;
      }
      lastAssistantText = fullText;

      return { text: delta, usage: data.message.usage || data.usage, sessionId: data.session_id };
    }
    // Capture final result with usage and session_id
    if (data.type === "result") {
      const resultText = data.result
        ? `\n[Result: ${data.result.substring(0, 100)}${data.result.length > 100 ? "..." : ""}]\n`
        : null;
      return { text: resultText, usage: data.usage, sessionId: data.session_id };
    }
  } catch {
    // Not JSON, return raw
    return { text: line };
  }
  return { text: null };
}

// ============================================================================
// Run Iteration
// ============================================================================

export async function runIteration(
  prompt: string,
  claudeArgs: string[],
  logStream?: WriteStream,
): Promise<IterationResult> {
  // Reset accumulated text state from previous iteration
  resetStreamState();

  // Pass task context as system prompt via --append-system-prompt
  // 'continue' is the user prompt - required by claude CLI when using --print
  const allArgs = [
    ...CLAUDE_DEFAULT_ARGS,
    ...claudeArgs,
    "--append-system-prompt",
    prompt,
    "continue",
  ];

  let output = "";
  let lineBuffer = "";
  let finalUsage: StreamEvent["usage"] | undefined;
  let sessionId: string | undefined;
  let lastCharWasNewline = true;

  const processLine = (line: string) => {
    const { text: parsed, tool, usage, sessionId: sid } = parseStreamLine(line);
    if (usage) finalUsage = usage;
    if (sid) sessionId = sid;
    if (tool) {
      const prefix = lastCharWasNewline ? "" : "\n";
      const toolLine = `${prefix}${pc.yellow("⚡")} ${pc.cyan(tool.name)}: ${tool.summary}\n`;
      process.stdout.write(toolLine);
      logStream?.write(`${prefix}⚡ ${tool.name}: ${tool.summary}\n`);
      lastCharWasNewline = true;
    }
    if (parsed) {
      process.stdout.write(parsed);
      logStream?.write(parsed);
      output += parsed;
      lastCharWasNewline = parsed.endsWith("\n");
    }
  };

  return new Promise((resolve) => {
    const proc = spawn("claude", allArgs, {
      stdio: ["inherit", "pipe", "pipe"],
    });

    proc.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      lineBuffer += text;

      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() || "";

      for (const line of lines) {
        processLine(line);
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      process.stderr.write(text);
      logStream?.write(text);
      output += text;
    });

    proc.on("close", (code: number | null) => {
      if (lineBuffer) {
        processLine(lineBuffer);
      }

      if (output && !output.endsWith("\n")) {
        process.stdout.write("\n");
        logStream?.write("\n");
        output += "\n";
      }

      // Calculate context usage percent
      let contextUsedPercent: number | undefined;
      if (finalUsage) {
        const totalTokens =
          (finalUsage.input_tokens || 0) +
          (finalUsage.output_tokens || 0) +
          (finalUsage.cache_read_input_tokens || 0) +
          (finalUsage.cache_creation_input_tokens || 0);
        const maxContext = MODEL_CONTEXT_WINDOWS.default;
        contextUsedPercent = Math.round((totalTokens / maxContext) * 100);
      }

      resolve({ output, exitCode: code ?? 0, contextUsedPercent, sessionId });
    });

    proc.on("error", (err: Error) => {
      console.error(pc.red(`Error running claude: ${err}`));
      logStream?.write(`Error running claude: ${err}\n`);
      resolve({ output, exitCode: 1 });
    });
  });
}
