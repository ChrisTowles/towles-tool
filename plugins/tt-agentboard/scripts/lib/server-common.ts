import { SERVER_PORT, SERVER_HOST, SERVER_ERR_LOG } from "@tt-agentboard/runtime";

const PORT = Number(process.env.TT_AGENTBOARD_PORT) || SERVER_PORT;
const HOST = process.env.TT_AGENTBOARD_HOST || SERVER_HOST;

export function resolvePluginDir(): string {
  if (process.env.TT_AGENTBOARD_DIR) return process.env.TT_AGENTBOARD_DIR;

  // Try reading from tmux environment
  try {
    const r = Bun.spawnSync(["tmux", "show-environment", "-g", "TT_AGENTBOARD_DIR"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const line = r.stdout.toString().trim();
    const eq = line.indexOf("=");
    if (eq > 0) return line.slice(eq + 1);
  } catch {}

  // Fallback: walk up from scripts/lib/
  return new URL("../../", import.meta.url).pathname;
}

export async function serverAlive(): Promise<boolean> {
  try {
    const res = await fetch(`http://${HOST}:${PORT}/`, { signal: AbortSignal.timeout(200) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function ensureServer(): Promise<boolean> {
  if (await serverAlive()) return true;

  const pluginDir = resolvePluginDir();
  const serverEntry = `${pluginDir}/apps/server/src/main.ts`;

  const proc = Bun.spawn([process.execPath, "run", serverEntry], {
    stdio: ["ignore", "ignore", Bun.file(SERVER_ERR_LOG)],
    cwd: pluginDir,
    env: { ...process.env, TT_AGENTBOARD_DIR: pluginDir },
  });
  proc.unref();

  for (let i = 0; i < 30; i++) {
    await Bun.sleep(100);
    if (await serverAlive()) return true;
  }

  return false;
}

export function serverUrl(path: string): string {
  return `http://${HOST}:${PORT}${path}`;
}

export function tmuxDisplay(fmt: string): string {
  try {
    const r = Bun.spawnSync(["tmux", "display-message", "-p", fmt], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return r.stdout.toString().trim();
  } catch {
    return "";
  }
}

export function tmuxContext(): string {
  return tmuxDisplay("#{client_tty}|#{session_name}|#{window_id}");
}
