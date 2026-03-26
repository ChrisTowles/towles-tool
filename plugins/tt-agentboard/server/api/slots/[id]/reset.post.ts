import { db } from "~~/server/db";
import { workspaceSlots } from "~~/server/db/schema";
import { eq } from "drizzle-orm";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function gitRun(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, "id"));

  const rows = await db.select().from(workspaceSlots).where(eq(workspaceSlots.id, id));
  if (rows.length === 0) {
    throw createError({ statusCode: 404, statusMessage: "Slot not found" });
  }

  const slot = rows[0];
  if (slot.status === "claimed") {
    throw createError({ statusCode: 409, statusMessage: "Cannot reset a claimed slot" });
  }

  const cwd = slot.path;

  try {
    await gitRun(cwd, ["stash", "--include-untracked"]);
    await gitRun(cwd, ["fetch", "origin"]);
    await gitRun(cwd, ["checkout", "main"]);
    await gitRun(cwd, ["reset", "--hard", "origin/main"]);
  } catch (err) {
    throw createError({
      statusCode: 500,
      statusMessage: `Git reset failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return { success: true };
});
