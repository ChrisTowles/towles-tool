export default defineEventHandler(async (event) => {
  const body = await readBody<{ prompt: string }>(event);

  if (!body?.prompt?.trim()) {
    throw createError({ statusCode: 400, message: "prompt is required" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw createError({
      statusCode: 500,
      message: "ANTHROPIC_API_KEY environment variable is not set",
    });
  }

  const systemPrompt = `You are a prompt improvement assistant for a developer task board.
Your job is to take a rough prompt/task description and improve it to be clearer, more specific, and more actionable for a Claude Code agent.

Rules:
- Keep the improved prompt concise but specific
- Add structure (numbered steps, bullet points) when helpful
- Preserve the original intent exactly — do not add scope
- Include specific file paths or function names if mentioned
- Make acceptance criteria explicit when possible
- Output ONLY the improved prompt text, no preamble or explanation`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: `Improve this agent prompt:\n\n${body.prompt.trim()}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw createError({
      statusCode: response.status,
      message: `Anthropic API error: ${errorText}`,
    });
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text: string }>;
  };
  const improved =
    data.content
      ?.filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("") ?? "";

  return { improved };
});
