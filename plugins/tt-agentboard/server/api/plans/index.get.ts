import { db } from "~~/server/shared/db";
import { plans } from "~~/server/shared/db/schema";

export default defineEventHandler(async () => {
  return db.select().from(plans).orderBy(plans.createdAt);
});
