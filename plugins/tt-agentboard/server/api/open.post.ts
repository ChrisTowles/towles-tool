import { z } from "zod";
import { openUrl, openInVscode, openFile } from "~~/server/domains/infra/opener";
import { logger } from "~~/server/utils/logger";

const OpenRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("url"), target: z.string().url() }),
  z.object({ type: z.literal("vscode"), target: z.string().min(1) }),
  z.object({ type: z.literal("file"), target: z.string().min(1) }),
]);

/**
 * POST /api/open
 * Opens a URL, VS Code path, or file using the host machine's applications.
 * This works because the server runs locally on the user's machine.
 */
export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  const req = OpenRequestSchema.parse(body);

  try {
    switch (req.type) {
      case "url":
        openUrl(req.target);
        break;
      case "vscode":
        openInVscode(req.target);
        break;
      case "file":
        openFile(req.target);
        break;
    }
    return { ok: true, type: req.type, target: req.target };
  } catch (err) {
    logger.error(`Failed to open ${req.type}: ${req.target}`, err);
    throw createError({ statusCode: 500, statusMessage: `Failed to open ${req.type}` });
  }
});
