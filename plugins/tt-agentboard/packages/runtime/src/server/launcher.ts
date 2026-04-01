import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "node:net";
import { SERVER_PORT, SERVER_HOST, PID_FILE } from "../shared";
import { SERVER_ERR_LOG } from "../debug";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isPortOpen(host: string, port: number, timeoutMs = 200): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.on("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function resolveAgentboardDir(): string {
  if (process.env.TT_AGENTBOARD_DIR) return process.env.TT_AGENTBOARD_DIR;
  // Walk up from packages/runtime/src/server/ to the plugin root
  return new URL("../../../..", import.meta.url).pathname;
}

function resolveServerEntryPath(pluginDir: string): string {
  return join(pluginDir, "apps", "server", "src", "main.ts");
}

export async function ensureServer(): Promise<void> {
  if (existsSync(PID_FILE)) {
    const pid = Number.parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    if (!Number.isNaN(pid) && isProcessAlive(pid) && (await isPortOpen(SERVER_HOST, SERVER_PORT))) {
      return;
    }
  }

  const pluginDir = resolveAgentboardDir();
  const serverPath = resolveServerEntryPath(pluginDir);

  const proc = Bun.spawn([process.execPath, "run", serverPath], {
    stdio: ["ignore", "ignore", Bun.file(SERVER_ERR_LOG)],
    cwd: pluginDir,
    env: { ...process.env, TT_AGENTBOARD_DIR: pluginDir },
  });
  proc.unref();

  for (let i = 0; i < 60; i++) {
    await Bun.sleep(50);
    if (await isPortOpen(SERVER_HOST, SERVER_PORT, 100)) return;
  }

  const errLog = existsSync(SERVER_ERR_LOG) ? readFileSync(SERVER_ERR_LOG, "utf-8").trim() : "";
  const detail = errLog || `No error output. Check ${SERVER_ERR_LOG}`;
  throw new Error(`AgentBoard server failed to start:\n${detail}`);
}
