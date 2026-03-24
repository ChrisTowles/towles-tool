import { db } from "~~/server/db";
import { repositories } from "~~/server/db/schema";

export default defineEventHandler(async () => {
  return db.select().from(repositories);
});
