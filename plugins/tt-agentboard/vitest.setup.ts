import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Set AGENTBOARD_DATA_DIR to a temp directory before any imports.
// This allows the real DB module to load with a disposable SQLite database
// instead of touching the user's real data directory.
process.env.AGENTBOARD_DATA_DIR = mkdtempSync(join(tmpdir(), "agentboard-test-"));

// Stub Nitro globals that exist at runtime but not in the test environment.
// defineNitroPlugin is called at module scope in server/plugins/*.ts files.
globalThis.defineNitroPlugin = globalThis.defineNitroPlugin ?? ((fn: unknown) => fn);
