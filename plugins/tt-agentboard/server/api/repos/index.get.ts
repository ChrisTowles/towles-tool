import { db } from "~~/server/db";
import { repositories, workspaceSlots } from "~~/server/db/schema";

export default defineEventHandler(async () => {
  const repos = await db.select().from(repositories);
  const slots = await db
    .select({ repoId: workspaceSlots.repoId, path: workspaceSlots.path })
    .from(workspaceSlots);

  const slotsByRepo = new Map<number, string[]>();
  for (const slot of slots) {
    const paths = slotsByRepo.get(slot.repoId) ?? [];
    paths.push(slot.path);
    slotsByRepo.set(slot.repoId, paths);
  }

  return repos.map((repo) => ({
    ...repo,
    slotPaths: slotsByRepo.get(repo.id) ?? [],
  }));
});
