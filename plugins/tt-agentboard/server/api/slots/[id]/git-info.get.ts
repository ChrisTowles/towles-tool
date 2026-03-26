import { db } from "~~/server/db";
import { workspaceSlots } from "~~/server/db/schema";
import { eq } from "drizzle-orm";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function gitCommand(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, "id"));
  const rows = await db.select().from(workspaceSlots).where(eq(workspaceSlots.id, id));
  if (rows.length === 0) {
    throw createError({ statusCode: 404, statusMessage: "Slot not found" });
  }

  const slot = rows[0];
  const cwd = slot.path;

  const [branch, aheadStr, behindStr, porcelain] = await Promise.all([
    gitCommand(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    gitCommand(cwd, ["rev-list", "origin/main..HEAD", "--count"]),
    gitCommand(cwd, ["rev-list", "HEAD..origin/main", "--count"]),
    gitCommand(cwd, ["status", "--porcelain"]),
  ]);

  return {
    branch,
    ahead: aheadStr !== null ? Number(aheadStr) : null,
    behind: behindStr !== null ? Number(behindStr) : null,
    dirty: porcelain !== null ? porcelain.length > 0 : null,
  };
});
