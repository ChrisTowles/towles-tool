export interface AgentToolEvent {
  kind: "tool_use";
  name: string;
  detail: string;
  input: Record<string, unknown>;
}

export interface AgentThinkingEvent {
  kind: "thinking";
  summary: string;
}

export interface AgentTextEvent {
  kind: "text";
  content: string;
}

export interface AgentResultEvent {
  kind: "result";
  costUsd: number;
  durationMs: number;
  numTurns: number;
  isError: boolean;
}

export type AgentActivityEvent =
  | AgentToolEvent
  | AgentThinkingEvent
  | AgentTextEvent
  | AgentResultEvent;

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "\u2026" : s;
}

function toolDetail(block: Record<string, unknown>): string {
  const input =
    typeof block.input === "object" && block.input !== null
      ? (block.input as Record<string, unknown>)
      : null;
  if (!input) return "";

  const filePath = input.file_path ?? input.path;
  if (typeof filePath === "string") {
    let detail = filePath;
    if (typeof input.old_string === "string" && typeof input.new_string === "string") {
      const old = truncate(input.old_string.split("\n")[0].trim(), 40);
      const replacement = truncate(input.new_string.split("\n")[0].trim(), 40);
      detail += ` "${old}" -> "${replacement}"`;
    }
    return detail;
  }
  if (typeof input.pattern === "string") return input.pattern;
  if (typeof input.command === "string") return truncate(input.command, 60);
  if (typeof input.subject === "string") return truncate(input.subject, 60);
  return "";
}

/** Parse a single NDJSON line from Claude Code's stream-json output */
export function parseStreamLine(line: string): AgentActivityEvent | null {
  if (!line.trim()) return null;

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }

  // Result event — top-level with result/is_error/num_turns
  if ("result" in event && "is_error" in event && "num_turns" in event) {
    return {
      kind: "result",
      costUsd: Number(event.cost_usd ?? event.total_cost_usd ?? 0),
      durationMs: Number(event.duration_ms ?? 0),
      numTurns: Number(event.num_turns),
      isError: Boolean(event.is_error),
    };
  }

  // Stream events — tool_use, thinking, text inside content_block_start
  if (event.type === "stream_event" && typeof event.event === "object" && event.event !== null) {
    const inner = event.event as Record<string, unknown>;

    if (
      inner.type === "content_block_start" &&
      typeof inner.content_block === "object" &&
      inner.content_block !== null
    ) {
      const block = inner.content_block as Record<string, unknown>;

      if (block.type === "tool_use" && typeof block.name === "string") {
        return {
          kind: "tool_use",
          name: block.name,
          detail: toolDetail(block),
          input:
            typeof block.input === "object" && block.input !== null
              ? (block.input as Record<string, unknown>)
              : {},
        };
      }

      if (block.type === "thinking") {
        const text = typeof block.thinking === "string" ? block.thinking : "";
        return {
          kind: "thinking",
          summary: truncate(text.split("\n")[0].trim(), 120),
        };
      }

      if (block.type === "text" && typeof block.text === "string") {
        return {
          kind: "text",
          content: block.text,
        };
      }
    }
  }

  // Assistant message events — content array with tool_use/thinking/text
  if (event.type === "assistant" && typeof event.message === "object" && event.message !== null) {
    const message = event.message as Record<string, unknown>;
    if (Array.isArray(message.content) && message.content.length > 0) {
      const block = message.content[0] as Record<string, unknown>;

      if (block.type === "tool_use" && typeof block.name === "string") {
        return {
          kind: "tool_use",
          name: block.name,
          detail: toolDetail(block),
          input:
            typeof block.input === "object" && block.input !== null
              ? (block.input as Record<string, unknown>)
              : {},
        };
      }

      if (block.type === "thinking") {
        const text = typeof block.thinking === "string" ? block.thinking : "";
        return {
          kind: "thinking",
          summary: truncate(text.split("\n")[0].trim(), 120),
        };
      }

      if (block.type === "text" && typeof block.text === "string") {
        return {
          kind: "text",
          content: block.text,
        };
      }
    }
  }

  return null;
}
