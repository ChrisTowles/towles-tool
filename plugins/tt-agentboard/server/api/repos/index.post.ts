import { db } from "~~/server/shared/db";
import { repositories } from "~~/server/shared/db/schema";

export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  const result = await db
    .insert(repositories)
    .values({
      name: body.name,
      org: body.org,
      defaultBranch: body.defaultBranch || "main",
      githubUrl: body.githubUrl,
    })
    .returning();
  return result[0];
});
