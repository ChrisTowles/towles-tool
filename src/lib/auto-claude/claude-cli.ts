import { createInterface } from "node:readline";

import consola from "consola";
import pc from "picocolors";

import { getConfig } from "./config.js";
import { sleep } from "./shell.js";
import { spawnClaude } from "./spawn-claude.js";

// ── Claude CLI ──

export interface ClaudeResult {
  result: string;
  is_error: boolean;
  total_cost_usd: number;
  num_turns: number;
}

const PROCESS_RETRIES = 3;
const PROCESS_RETRY_DELAY_MS = 5_000;

export async function runClaude(opts: {
  promptFile: string;
  maxTurns?: number;
}): Promise<ClaudeResult> {
  const cfg = getConfig();
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--dangerously-skip-permissions",
    "--model",
    cfg.model,
    ...(opts.maxTurns ? ["--max-turns", String(opts.maxTurns)] : []),
    `@${opts.promptFile}`,
  ];

  consola.info(
    `${pc.dim("▶")} Calling Claude${opts.maxTurns ? ` (max ${opts.maxTurns} turns)` : ""}…`,
  );

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= PROCESS_RETRIES; attempt++) {
    try {
      const result = await runClaudeStreaming(args);
      consola.success(`Done — ${result.num_turns} turns, $${result.total_cost_usd.toFixed(4)}`);
      if (result.result) {
        consola.log(result.result);
      }
      return result;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < PROCESS_RETRIES) {
        consola.warn(
          `Claude process failed (attempt ${attempt}/${PROCESS_RETRIES}), retrying in ${PROCESS_RETRY_DELAY_MS / 1000}s…`,
        );
        await sleep(PROCESS_RETRY_DELAY_MS);
      }
    }
  }
  throw lastError ?? new Error("runClaude failed after all retries");
}

function runClaudeStreaming(args: string[]): Promise<ClaudeResult> {
  return new Promise((resolve, reject) => {
    const proc = spawnClaude(args);
    let capturedResult: ClaudeResult | null = null;
    let turnCount = 0;

    if (!proc.stdout) {
      reject(new Error("Claude process has no stdout"));
      return;
    }

    const rl = createInterface({ input: proc.stdout });

    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        handleStreamEvent(event, (turns) => {
          turnCount = turns;
        });

        if ("result" in event && "is_error" in event && "num_turns" in event) {
          capturedResult = {
            result: String(event.result ?? ""),
            is_error: Boolean(event.is_error),
            total_cost_usd: Number(event.total_cost_usd ?? 0),
            num_turns: Number(event.num_turns),
          };
        }
      } catch {
        // Skip non-JSON lines
      }
    });

    proc.on("error", (err) => {
      rl.close();
      reject(err);
    });

    proc.on("close", (code) => {
      rl.close();
      if (capturedResult) {
        resolve(capturedResult);
      } else if (code !== 0) {
        reject(new Error(`Claude process exited with code ${code}`));
      } else {
        resolve({ result: "", is_error: false, total_cost_usd: 0, num_turns: turnCount });
      }
    });
  });
}

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
    let detail = pc.dim(` ${filePath}`);
    // Show edit context for Edit tool
    if (typeof input.old_string === "string" && typeof input.new_string === "string") {
      const old = truncate(input.old_string.split("\n")[0].trim(), 40);
      const replacement = truncate(input.new_string.split("\n")[0].trim(), 40);
      detail += pc.dim(` "${old}" → "${replacement}"`);
    }
    return detail;
  }
  if (typeof input.pattern === "string") return pc.dim(` ${input.pattern}`);
  if (typeof input.command === "string") {
    return pc.dim(` ${truncate(input.command, 60)}`);
  }
  // TodoWrite/TaskCreate — show subject
  if (typeof input.subject === "string") return pc.dim(` ${truncate(input.subject, 60)}`);
  return "";
}

function logToolUse(block: Record<string, unknown>): void {
  const name = block.name;
  if (typeof name === "string") {
    consola.info(`  ${pc.dim("\u21B3")} ${name}${toolDetail(block)}`);
  }
}

function handleStreamEvent(event: Record<string, unknown>, onTurn: (count: number) => void): void {
  // Only handle stream_event — assistant turn events duplicate the same tools
  if (event.type === "stream_event" && typeof event.event === "object" && event.event !== null) {
    const inner = event.event as Record<string, unknown>;

    if (
      inner.type === "content_block_start" &&
      typeof inner.content_block === "object" &&
      inner.content_block !== null
    ) {
      const block = inner.content_block as Record<string, unknown>;
      if (block.type === "tool_use") {
        logToolUse(block);
      } else if (block.type === "thinking") {
        const thinkingText =
          typeof block.thinking === "string" && block.thinking.length > 0
            ? pc.dim(` ${truncate(block.thinking.split("\n")[0].trim(), 60)}`)
            : "";
        consola.info(`  ${pc.dim("\u21B3")} ${pc.italic("thinking")}${thinkingText}`);
      }
    }
  }

  // Turn count tracking
  if (typeof event.num_turns === "number" && !("result" in event)) {
    onTurn(event.num_turns as number);
  }
}
