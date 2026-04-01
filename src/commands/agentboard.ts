import { defineCommand } from "citty";
import { execSync, spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import consola from "consola";
import { colors } from "consola/utils";
import { debugArg } from "./shared.js";

const SERVER_HOST = "127.0.0.1";
const SERVER_PORT = 4201;

const PLUGIN_DIR = resolve(import.meta.dirname, "../../plugins/tt-agentboard");

// Keybinding defaults
const DEFAULT_KEY = "a";
const TMUX_BINDINGS = { toggle: "t", focus: "s" } as const;
const RUN_SHELL_LINE = "run-shell 'tt agentboard init'";
const MARKER = "# agentboard";

function findTmuxConf(): string | null {
  const candidates = [resolve(process.env.HOME ?? "~", ".config/tmux/tmux.conf")];
  for (const path of candidates) {
    try {
      const real = existsSync(path) ? path : null;
      if (real) return real;
    } catch {
      continue;
    }
  }
  return null;
}

function ensureDeps(): void {
  try {
    execSync("bun --version", { stdio: "pipe" });
  } catch {
    consola.error("bun is required but not found. Install: https://bun.sh");
    process.exit(1);
  }

  const runtimeNodeModules = resolve(PLUGIN_DIR, "packages/runtime/node_modules");
  if (!existsSync(runtimeNodeModules)) {
    consola.info("Installing agentboard dependencies...");
    execSync("bun install", { cwd: PLUGIN_DIR, stdio: "inherit" });
  }
}

function reloadTmux(): void {
  try {
    execSync(
      "tmux source-file ~/.config/tmux/tmux.conf 2>/dev/null || tmux source-file ~/.tmux.conf 2>/dev/null",
      {
        stdio: "pipe",
      },
    );
    consola.success("tmux config reloaded");
  } catch {
    consola.info("Reload tmux manually: tmux source-file ~/.config/tmux/tmux.conf");
  }
}

function showKeys(): void {
  let prefix = "C-a";
  let key = DEFAULT_KEY;
  try {
    prefix = execSync("tmux show-option -gv prefix", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    const abKey = execSync(
      `tmux show-option -gv @agentboard-key 2>/dev/null || echo ${DEFAULT_KEY}`,
      {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    ).trim();
    if (abKey) key = abKey;
  } catch {
    // use defaults
  }

  const { toggle, focus } = TMUX_BINDINGS;
  consola.box(
    [
      `${colors.bold("AgentBoard Keybindings")}\n`,
      `${colors.cyan(`tmux (prefix = ${prefix}, C = Ctrl):`)}`,
      `  ${prefix} ${key} ${toggle}     toggle sidebar`,
      `  ${prefix} ${key} ${focus}     focus sidebar`,
      `  ${prefix} ${key} 1-9   jump to session\n`,
      `${colors.cyan("In sidebar:")}`,
      `  Tab         cycle sessions`,
      `  j / ↓       move down`,
      `  k / ↑       move up`,
      `  Enter / l   switch to selected session`,
      `  1-9         jump to session`,
      `  d           hide session`,
      `  x           kill session`,
      `  r           refresh`,
      `  ?           help`,
      `  q           quit`,
    ].join("\n"),
  );
}

function setup(): void {
  ensureDeps();

  const confPath = findTmuxConf();
  if (!confPath) {
    consola.warn("No tmux.conf found. Add this line manually:");
    consola.info(colors.cyan(`  ${RUN_SHELL_LINE}`));
    return;
  }

  let editPath = confPath;
  try {
    editPath = realpathSync(confPath);
  } catch {
    // keep confPath
  }

  const content = readFileSync(editPath, "utf8");
  if (content.includes(MARKER)) {
    consola.success("Already installed in tmux.conf");
    reloadTmux();
    return;
  }

  const tpmLine = "run '~/.config/tmux/plugins/tpm/tpm'";
  const altTpmLine = "run-shell '~/.tmux/plugins/tpm/tpm'";
  const insertLines = `\n${MARKER}\n${RUN_SHELL_LINE}\n`;

  let newContent: string;
  if (content.includes(tpmLine)) {
    newContent = content.replace(tpmLine, `${insertLines}\n${tpmLine}`);
  } else if (content.includes(altTpmLine)) {
    newContent = content.replace(altTpmLine, `${insertLines}\n${altTpmLine}`);
  } else {
    newContent = content + insertLines;
  }

  writeFileSync(editPath, newContent);
  consola.success(`Added agentboard to ${editPath}`);

  reloadTmux();
  showKeys();
}

function uninstall(): void {
  const confPath = findTmuxConf();
  if (!confPath) {
    consola.info("No tmux.conf found.");
    return;
  }

  let editPath = confPath;
  try {
    editPath = realpathSync(confPath);
  } catch {
    // keep confPath
  }

  const content = readFileSync(editPath, "utf8");
  if (!content.includes("agentboard")) {
    consola.info("agentboard not found in tmux.conf");
    return;
  }

  const newContent = content
    .split("\n")
    .filter((line) => !line.includes("agentboard"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");

  writeFileSync(editPath, newContent);
  consola.success("Removed agentboard from tmux.conf");
  reloadTmux();
}

function startServer(): void {
  ensureDeps();

  const serverEntry = resolve(PLUGIN_DIR, "apps/server/src/main.ts");
  consola.info("Starting agentboard server (foreground, Ctrl+C to stop)...");

  execSync(`bun run ${serverEntry}`, {
    stdio: "inherit",
    cwd: PLUGIN_DIR,
    env: {
      ...process.env,
      AGENTBOARD_DIR: PLUGIN_DIR,
    },
  });
}

async function serverAlive(): Promise<boolean> {
  try {
    const res = await fetch(`http://${SERVER_HOST}:${SERVER_PORT}/`, {
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureServerUp(): Promise<boolean> {
  if (await serverAlive()) return true;

  const serverEntry = resolve(PLUGIN_DIR, "apps/server/src/main.ts");
  consola.info("Starting agentboard server...");
  const child = spawn("bun", ["run", serverEntry], {
    stdio: "ignore",
    cwd: PLUGIN_DIR,
    detached: true,
    env: { ...process.env, AGENTBOARD_DIR: PLUGIN_DIR },
  });
  child.unref();

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await serverAlive()) return true;
  }
  return false;
}

function tmuxDisplay(fmt: string): string {
  try {
    const r = spawnSync("tmux", ["display-message", "-p", fmt], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return (r.stdout ?? "").trim();
  } catch {
    return "";
  }
}

function tmuxContext(): string {
  return tmuxDisplay("#{client_tty}|#{session_name}|#{window_id}");
}

function resetTmuxKeys(): void {
  spawnSync("tmux", ["switch-client", "-T", "root"], { stdio: "pipe" });
}

function findSidebarPane(windowId: string): string | null {
  try {
    const r = spawnSync("tmux", ["list-panes", "-t", windowId, "-F", "#{pane_id} #{pane_title}"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    for (const line of (r.stdout ?? "").trim().split("\n")) {
      const [paneId, title] = line.split(" ", 2);
      if (title === "agentboard-sidebar" && paneId) return paneId;
    }
  } catch {}
  return null;
}

function tmux(...args: string[]): void {
  spawnSync("tmux", args, { stdio: "pipe" });
}

function init(): void {
  const port = process.env.TT_AGENTBOARD_PORT ?? "4201";
  const host = process.env.TT_AGENTBOARD_HOST ?? "127.0.0.1";

  // Read tmux options with defaults
  const keyResult = spawnSync("tmux", ["show-option", "-gqv", "@agentboard-key"], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const key = (keyResult.stdout ?? "").trim() || DEFAULT_KEY;

  // Export to tmux environment
  tmux("set-environment", "-g", "TT_AGENTBOARD_PORT", port);
  tmux("set-environment", "-g", "TT_AGENTBOARD_HOST", host);

  // Bind keybindings via command table "agentboard"
  tmux("bind-key", "-T", "prefix", key, "switch-client", "-T", "agentboard");
  tmux(
    "bind-key",
    "-T",
    "agentboard",
    TMUX_BINDINGS.toggle,
    "run-shell",
    "tt agentboard run --toggle",
  );
  tmux(
    "bind-key",
    "-T",
    "agentboard",
    TMUX_BINDINGS.focus,
    "run-shell",
    "tt agentboard run --focus",
  );

  // Number keys 1-9 switch to session by index
  for (let i = 1; i <= 9; i++) {
    tmux(
      "bind-key",
      "-T",
      "agentboard",
      String(i),
      "run-shell",
      `curl -s -X POST 'http://${host}:${port}/switch-index?index=${i}' -d "$(tmux display-message -p '#{q:client_tty}|#{q:session_name}|#{q:window_id}')" >/dev/null 2>&1 || true`,
    );
  }

  // Hooks (fallback for when server isn't running yet)
  const hookPost = (path: string, body?: string) => {
    const bodyArg = body ? ` -d \\"${body}\\"` : "";
    return `run-shell -b "curl -s -X POST http://${host}:${port}${path}${bodyArg} >/dev/null 2>&1 || true"`;
  };
  const focusBody = "#{q:client_tty}|#{q:session_name}|#{q:window_id}";
  const resizeBody =
    "#{q:pane_id}|#{q:session_name}|#{q:window_id}|#{q:pane_width}|#{q:window_width}";

  tmux("set-hook", "-g", "client-session-changed", hookPost("/focus", focusBody));
  tmux("set-hook", "-g", "after-select-window", hookPost("/ensure-sidebar", focusBody));
  tmux("set-hook", "-g", "after-resize-pane", hookPost("/resize-sidebars", resizeBody));
}

async function runToggle(): Promise<void> {
  if (!(await ensureServerUp())) process.exit(0);
  const ctx = tmuxContext();
  await fetch(`http://${SERVER_HOST}:${SERVER_PORT}/toggle`, { method: "POST", body: ctx }).catch(
    () => {},
  );
  resetTmuxKeys();
}

async function runFocus(): Promise<void> {
  const windowId = tmuxDisplay("#{window_id}");
  if (!windowId) process.exit(0);

  // If sidebar already exists, just focus it
  const existing = findSidebarPane(windowId);
  if (existing) {
    spawnSync("tmux", ["select-pane", "-t", existing], { stdio: "pipe" });
    resetTmuxKeys();
    return;
  }

  // Otherwise, ensure server + toggle sidebar on
  if (!(await ensureServerUp())) process.exit(0);
  const ctx = tmuxContext();
  await fetch(`http://${SERVER_HOST}:${SERVER_PORT}/toggle`, { method: "POST", body: ctx }).catch(
    () => {},
  );

  // Wait for sidebar pane to appear
  for (let i = 0; i < 20; i++) {
    const paneId = findSidebarPane(windowId);
    if (paneId) {
      spawnSync("tmux", ["select-pane", "-t", paneId], { stdio: "pipe" });
      resetTmuxKeys();
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  resetTmuxKeys();
}

async function restart(): Promise<void> {
  ensureDeps();

  // 1. Kill stash sessions left over from hidden sidebars
  try {
    const result = spawnSync("tmux", ["list-sessions", "-F", "#{session_name}"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const sessions = (result.stdout ?? "").trim().split("\n").filter(Boolean);
    for (const name of sessions) {
      if (name.startsWith("_ab_stash")) {
        spawnSync("tmux", ["kill-session", "-t", name], { stdio: "pipe" });
        consola.info(`Killed stash session: ${name}`);
      }
    }
  } catch {
    // no tmux or no sessions
  }

  // 2. Ensure server is running
  if (!(await ensureServerUp())) {
    consola.error("Failed to start agentboard server");
    process.exit(1);
  }
  consola.success("Server is running");

  // 3. Toggle sidebar on (the server spawns sidebars in all active windows)
  try {
    const res = await fetch(`http://${SERVER_HOST}:${SERVER_PORT}/toggle`, {
      method: "POST",
      body: "",
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      consola.success("Sidebar toggled on for all sessions");
    } else {
      consola.warn(`Toggle returned: ${res.status}`);
    }
  } catch (err) {
    consola.error("Failed to toggle sidebar:", err);
  }
}

function startTui(): void {
  ensureDeps();

  const tuiEntry = resolve(PLUGIN_DIR, "apps/tui/src/index.tsx");

  execSync(`bun run ${tuiEntry}`, {
    stdio: "inherit",
    cwd: resolve(PLUGIN_DIR, "apps/tui"),
    env: {
      ...process.env,
      AGENTBOARD_DIR: PLUGIN_DIR,
    },
  });
}

export default defineCommand({
  meta: { name: "agentboard", description: "AgentBoard — tmux TUI sidebar" },
  args: {
    debug: debugArg,
    subcommand: {
      type: "positional",
      required: false,
      description: "Subcommand: setup, uninstall, server, tui, start, restart, run, keys",
    },
    toggle: { type: "boolean", description: "Toggle sidebar (used with 'run')" },
    focus: { type: "boolean", description: "Focus sidebar (used with 'run')" },
  },
  async run({ args }) {
    switch (args.subcommand) {
      case "setup":
        setup();
        break;
      case "uninstall":
        uninstall();
        break;
      case "server":
        startServer();
        break;
      case "tui":
        startTui();
        break;
      case "start":
        startTui();
        break;
      case "restart":
        await restart();
        break;
      case "init":
        init();
        break;
      case "run":
        if (args.toggle) await runToggle();
        else if (args.focus) await runFocus();
        else consola.error("Usage: tt agentboard run --toggle | --focus");
        break;
      case "keys":
        showKeys();
        break;
      default:
        showKeys();
        break;
    }
  },
});
