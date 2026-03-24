import { defineConfig } from "drizzle-kit";
import { resolve } from "node:path";
import { homedir } from "node:os";

const defaultDataDir = resolve(
  process.env.XDG_CONFIG_HOME ?? resolve(homedir(), ".config"),
  "towles-tool",
  "agentboard",
);
const dbDir = process.env.AGENTBOARD_DATA_DIR ?? defaultDataDir;

export default defineConfig({
  schema: "./server/db/schema.ts",
  out: "./server/db/migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: resolve(dbDir, "agentboard.db"),
  },
});
