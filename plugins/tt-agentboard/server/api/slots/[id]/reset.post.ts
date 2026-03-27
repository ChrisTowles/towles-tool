import { db } from "~~/server/shared/db";
import { repositories, workspaceSlots } from "~~/server/shared/db/schema";
import { eq } from "drizzle-orm";
import { gitRun } from "~~/server/domains/infra/git";

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, "id"));
  const query = getQuery(event);
  const force = query.force === "true";

  const [slot] = await db.select().from(workspaceSlots).where(eq(workspaceSlots.id, id));
  if (!slot) {
    throw createError({ statusCode: 404, statusMessage: "Slot not found" });
  }
  if (slot.status === "claimed") {
    throw createError({ statusCode: 409, statusMessage: "Cannot reset a claimed slot" });
  }

  const cwd = slot.path;

  const porcelain = await gitRun(cwd, ["status", "--porcelain"]);
  if (porcelain.length > 0 && !force) {
    throw createError({
      statusCode: 409,
      statusMessage: "Slot has uncommitted changes. Use ?force=true to override.",
    });
  }

  let defaultBranch = "main";
  if (slot.repoId) {
    const [repo] = await db.select().from(repositories).where(eq(repositories.id, slot.repoId));
    if (repo?.defaultBranch) {
      defaultBranch = repo.defaultBranch;
    }
  }

  try {
    await gitRun(cwd, ["stash", "--include-untracked"]);
    await gitRun(cwd, ["fetch", "origin"]);
    await gitRun(cwd, ["checkout", defaultBranch]);
    await gitRun(cwd, ["reset", "--hard", `origin/${defaultBranch}`]);
  } catch (err) {
    throw createError({
      statusCode: 500,
      statusMessage: `Git reset failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return { success: true };
});
