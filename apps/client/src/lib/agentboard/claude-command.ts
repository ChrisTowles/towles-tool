import { shellQuote } from "./pty";

export type ClaudeModel = "sonnet" | "opus" | "fable";

export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type ClaudeLaunchOptions = {
  model?: ClaudeModel;
  effort?: ClaudeEffort;
};

/** The prompt goes in as an argument so Claude starts on it immediately. */
export function claudeCommand(prompt: string, options?: ClaudeLaunchOptions): string {
  const trimmed = prompt.trim();
  const parts = [
    "claude",
    options?.model ? `--model ${shellQuote(options.model)}` : null,
    options?.effort ? `--effort ${shellQuote(options.effort)}` : null,
    trimmed ? shellQuote(trimmed) : null,
  ].filter((p): p is string => p != null);
  return `${parts.join(" ")}\r`;
}

/** Fold images pasted into the new-task form into that task's opening prompt. */
export function promptWithImages(goal: string, imagePaths: string[]): string {
  const trimmed = goal.trim();
  if (imagePaths.length === 0) return trimmed;
  const one = imagePaths.length === 1;
  const attachment = `Attached ${one ? "image" : "images"} — read ${
    one ? "it" : "them"
  } first, before anything else: ${imagePaths.join(" ")}`;
  return trimmed ? `${trimmed} — ${attachment}` : attachment;
}

/** Resume a past session in place, typed into the folder's PTY. */
export function claudeResumeCommand(sessionId: string): string {
  return `claude --resume ${shellQuote(sessionId)}\r`;
}
