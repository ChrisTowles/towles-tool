import { db } from "~~/server/shared/db";
import { repositories, workspaceSlots } from "~~/server/shared/db/schema";
import { eq } from "drizzle-orm";
import { gitQuery } from "~~/server/domains/infra/git";

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

  const [branch, aheadStr, behindStr, porcelain, lastCommitDate] = await Promise.all([
    gitQuery(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    gitQuery(cwd, ["rev-list", `origin/${defaultBranch}..HEAD`, "--count"]),
    gitQuery(cwd, ["rev-list", `HEAD..origin/${defaultBranch}`, "--count"]),
    gitQuery(cwd, ["status", "--porcelain"]),
    gitQuery(cwd, ["log", "-1", "--format=%cI"]),
  ]);

  const ahead = aheadStr !== null ? Number(aheadStr) : null;
  const behind = behindStr !== null ? Number(behindStr) : null;
  const dirty = porcelain !== null ? porcelain.length > 0 : null;

  // Stale: branch >7 days old OR >20 commits behind main
  let isStale = false;
  if (lastCommitDate) {
    const daysSinceCommit = (Date.now() - new Date(lastCommitDate).getTime()) / 86_400_000;
    isStale = daysSinceCommit > 7;
  }
  if (behind !== null && behind > 20) {
    isStale = true;
  }

  return { branch, ahead, behind, dirty, lastCommitDate, isStale };
});
