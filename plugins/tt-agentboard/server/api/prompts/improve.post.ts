import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const systemPrompt = `You are a prompt improvement assistant for a developer task board.
Your job is to take a rough prompt/task description and improve it to be clearer, more specific, and more actionable for a Claude Code agent.

Rules:
- Keep the improved prompt concise but specific
- Add structure (numbered steps, bullet points) when helpful
- Preserve the original intent exactly — do not add scope
- Include specific file paths or function names if mentioned
- Make acceptance criteria explicit when possible
- Output ONLY the improved prompt text, no preamble or explanation`;

export default defineEventHandler(async (event) => {
  const body = await readBody<{ prompt: string }>(event);

  if (!body?.prompt?.trim()) {
    throw createError({ statusCode: 400, message: "prompt is required" });
  }

  const userPrompt = `Improve this agent prompt:\n\n${body.prompt.trim()}`;

  try {
    const { stdout } = await execFileAsync(
      "claude",
      ["-p", userPrompt, "--model", "haiku", "--system-prompt", systemPrompt],
      {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env },
      },
    );

    const improved = stdout.trim();
    if (!improved) {
      throw createError({ statusCode: 502, message: "Claude CLI returned empty output" });
    }

    return { improved };
  } catch (e: unknown) {
    const err = e as { code?: string; stderr?: string; message?: string };
    if (err.code === "ENOENT") {
      throw createError({
        statusCode: 500,
        message: "claude CLI not found — ensure Claude Code is installed and on PATH",
      });
    }
    throw createError({
      statusCode: 502,
      message: `Claude CLI error: ${err.stderr || err.message || "unknown error"}`,
    });
  }
});
