import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import * as schema from "./schema";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";

const defaultDataDir = resolve(
  process.env.XDG_CONFIG_HOME ?? resolve(homedir(), ".config"),
  "towles-tool",
  "agentboard",
);
const dbDir = process.env.AGENTBOARD_DATA_DIR ?? defaultDataDir;
mkdirSync(dbDir, { recursive: true });

const sqlite = new Database(resolve(dbDir, "agentboard.db"));
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });
