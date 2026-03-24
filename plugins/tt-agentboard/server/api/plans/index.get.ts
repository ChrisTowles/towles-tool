import { db } from "~~/server/db";
import { plans } from "~~/server/db/schema";

export default defineEventHandler(async () => {
  return db.select().from(plans).orderBy(plans.createdAt);
});
