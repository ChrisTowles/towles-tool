import { db } from "~~/server/db";
import { repositories, workspaceSlots } from "~~/server/db/schema";
import { eq } from "drizzle-orm";
import { gitQuery } from "~~/server/utils/git";

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, "id"));
  const rows = await db.select().from(workspaceSlots).where(eq(workspaceSlots.id, id));
  if (rows.length === 0) {
    throw createError({ statusCode: 404, statusMessage: "Slot not found" });
  }

  const slot = rows[0];
  const cwd = slot.path;

  const repos = await db.select().from(repositories).where(eq(repositories.id, slot.repoId));
  const defaultBranch = repos[0]?.defaultBranch ?? "main";

  const [branch, aheadStr, behindStr, porcelain] = await Promise.all([
    gitQuery(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    gitQuery(cwd, ["rev-list", `origin/${defaultBranch}..HEAD`, "--count"]),
    gitQuery(cwd, ["rev-list", `HEAD..origin/${defaultBranch}`, "--count"]),
    gitQuery(cwd, ["status", "--porcelain"]),
  ]);

  return {
    branch,
    ahead: aheadStr !== null ? Number(aheadStr) : null,
    behind: behindStr !== null ? Number(behindStr) : null,
    dirty: porcelain !== null ? porcelain.length > 0 : null,
  };
});
