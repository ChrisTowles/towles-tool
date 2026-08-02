#!/usr/bin/env node
// Picks the Vite dev-server port before launching `tauri dev`, so several
// worktree tasks can run at once. The port is always an explicit per-checkout
// claim, never scanned: TT_DEV_PORT from shell env, `.env.local`, or the `.env`
// rendered by `tt task env`. Whatever holds it is killed first — almost always
// this task's own orphan — and if that fails we abort rather than move ports.
import { fileURLToPath } from "node:url";
import path from "node:path";
import { requireDevPort, spawnTauriDev, isPortFree, killPort } from "./task-port.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const port = requireDevPort(repoRoot, { tag: "dev-port", render: true });
console.log(`[dev-port] using port ${port} (set TT_DEV_PORT in .env.local to pin a different one)`);

await killPort(port);
if (!(await isPortFree(port))) {
  console.error(`[dev-port] port ${port} is still in use — couldn't free it, aborting`);
  process.exit(1);
}

spawnTauriDev(
  ["dev", "--config", JSON.stringify({ build: { devUrl: `http://localhost:${port}` } })],
  { ...process.env, TT_DEV_PORT: String(port) },
);
