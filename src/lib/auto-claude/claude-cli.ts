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

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= PROCESS_RETRIES; attempt++) {
    try {
      const result = await runClaudeStreaming(args);
      consola.success(`Done — ${result.num_turns} turns`);
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

function toolDetail(block: Record<string, unknown>): string {
  const input =
    typeof block.input === "object" && block.input !== null
      ? (block.input as Record<string, unknown>)
      : null;
  if (!input) return "";

  const filePath = input.file_path ?? input.path;
  if (typeof filePath === "string") return pc.dim(` ${filePath}`);
  if (typeof input.pattern === "string") return pc.dim(` ${input.pattern}`);
  if (typeof input.command === "string") {
    const cmd = input.command;
    return pc.dim(` ${cmd.length > 60 ? cmd.slice(0, 60) + "\u2026" : cmd}`);
  }
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
        consola.info(`  ${pc.dim("\u21B3")} ${pc.italic("thinking\u2026")}`);
      }
    }
  }

  // Turn count tracking
  if (typeof event.num_turns === "number" && !("result" in event)) {
    onTurn(event.num_turns as number);
  }
}
