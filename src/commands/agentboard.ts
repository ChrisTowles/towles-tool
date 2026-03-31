import { defineCommand } from "citty";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import consola from "consola";
import { colors } from "consola/utils";
import { debugArg } from "./shared.js";

const PLUGIN_DIR = resolve(import.meta.dirname, "../../plugins/tt-agentboard");

// Keybinding defaults
const DEFAULT_KEY = "a";
const TMUX_BINDINGS = { toggle: "t", focus: "s" } as const;
const RUN_SHELL_LINE = `run-shell '${PLUGIN_DIR}/agentboard.tmux'`;
const MARKER = "# agentboard";

function findTmuxConf(): string | null {
  const candidates = [
    resolve(process.env.HOME ?? "~", ".tmux.conf"),
    resolve(process.env.HOME ?? "~", ".config/tmux/tmux.conf"),
  ];
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
      `  t           theme picker`,
      `  r           refresh`,
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
  if (content.includes("agentboard.tmux")) {
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
      description: "Subcommand: setup, uninstall, server, tui, start, keys",
    },
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
      case "keys":
        showKeys();
        break;
      default:
        showKeys();
        break;
    }
  },
});
