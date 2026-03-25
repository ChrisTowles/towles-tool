import { readConfig } from "~~/server/utils/config";

export default defineEventHandler(() => {
  return readConfig();
});
