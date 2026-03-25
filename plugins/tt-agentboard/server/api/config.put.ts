import { readConfig, writeConfig } from "~~/server/utils/config";

export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  const current = readConfig();

  if (body.repoPaths && Array.isArray(body.repoPaths)) {
    current.repoPaths = body.repoPaths.filter(
      (p: unknown) => typeof p === "string" && p.trim().length > 0,
    );
  }

  writeConfig(current);
  return current;
});
