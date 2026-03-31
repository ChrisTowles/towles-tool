import { Args } from "@oclif/core";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import consola from "consola";
import { colors } from "consola/utils";
import { BaseCommand } from "./base.js";

const PLUGIN_DIR = resolve(import.meta.dirname, "../../plugins/tt-agentboard2");

// Keybinding defaults
const DEFAULT_KEY = "a";
const TMUX_BINDINGS = { toggle: "t", focus: "s" } as const;
const RUN_SHELL_LINE = `run-shell '${PLUGIN_DIR}/agentboard2.tmux'`;
const MARKER = "# agentboard2";

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

export default class Agentboard2 extends BaseCommand {
  static override aliases = ["ag2"];
  static override description = "AgentBoard2 — opensessions-style tmux TUI sidebar";

  static override examples = [
    {
      description: "Install agentboard2 into tmux",
      command: "<%= config.bin %> agentboard2 setup",
    },
    {
      description: "Uninstall from tmux",
      command: "<%= config.bin %> agentboard2 uninstall",
    },
    {
      description: "Launch the server",
      command: "<%= config.bin %> agentboard2 server",
    },
    {
      description: "Launch the TUI directly",
      command: "<%= config.bin %> agentboard2 tui",
    },
  ];

  static override args = {
    subcommand: Args.string({
      description: "Subcommand: setup, uninstall, server, tui, keys",
      required: false,
      options: ["setup", "uninstall", "server", "tui", "start", "keys"],
    }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(Agentboard2);

    switch (args.subcommand) {
      case "setup":
        this.setup();
        break;
      case "uninstall":
        this.uninstall();
        break;
      case "server":
        this.startServer();
        break;
      case "tui":
        this.startTui();
        break;
      case "start":
        // For backwards compat, start = tui
        this.startTui();
        break;
      case "keys":
        this.showKeys();
        break;
      default:
        this.showKeys();
        break;
    }
  }

  private ensureDeps(): void {
    // Check bun is installed
    try {
      execSync("bun --version", { stdio: "pipe" });
    } catch {
      this.error("bun is required but not found. Install: https://bun.sh");
    }

    // Install deps if needed for runtime package
    const runtimeNodeModules = resolve(PLUGIN_DIR, "packages/runtime/node_modules");
    if (!existsSync(runtimeNodeModules)) {
      consola.info("Installing agentboard2 dependencies...");
      execSync("pnpm install", { cwd: PLUGIN_DIR, stdio: "inherit" });
    }
  }

  private setup(): void {
    this.ensureDeps();

    // Find tmux.conf
    const confPath = findTmuxConf();
    if (!confPath) {
      consola.warn("No tmux.conf found. Add this line manually:");
      consola.info(colors.cyan(`  ${RUN_SHELL_LINE}`));
      return;
    }

    // If it's a symlink, resolve to the real file for editing
    let editPath = confPath;
    try {
      editPath = realpathSync(confPath);
    } catch {
      // keep confPath
    }

    // Check if already installed
    const content = readFileSync(editPath, "utf8");
    if (content.includes("agentboard2.tmux")) {
      consola.success("Already installed in tmux.conf");
      this.reloadTmux();
      return;
    }

    // Add run-shell line before TPM init
    const tpmLine = "run '~/.config/tmux/plugins/tpm/tpm'";
    const altTpmLine = "run-shell '~/.tmux/plugins/tpm/tpm'";
    const insertLines = `\n${MARKER}\n${RUN_SHELL_LINE}\n`;

    let newContent: string;
    if (content.includes(tpmLine)) {
      newContent = content.replace(tpmLine, `${insertLines}\n${tpmLine}`);
    } else if (content.includes(altTpmLine)) {
      newContent = content.replace(altTpmLine, `${insertLines}\n${altTpmLine}`);
    } else {
      // No TPM found, append to end
      newContent = content + insertLines;
    }

    writeFileSync(editPath, newContent);
    consola.success(`Added agentboard2 to ${editPath}`);

    this.reloadTmux();
    this.showKeys();
  }

  private uninstall(): void {
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
    if (!content.includes("agentboard2")) {
      consola.info("agentboard2 not found in tmux.conf");
      return;
    }

    // Remove the marker line and run-shell line
    const newContent = content
      .split("\n")
      .filter((line) => !line.includes("agentboard2"))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n");

    writeFileSync(editPath, newContent);
    consola.success("Removed agentboard2 from tmux.conf");
    this.reloadTmux();
  }

  // Foreground command — blocks until server exits (Ctrl+C to stop)
  private startServer(): void {
    this.ensureDeps();

    const serverEntry = resolve(PLUGIN_DIR, "apps/server/src/main.ts");
    consola.info("Starting agentboard2 server (foreground, Ctrl+C to stop)...");

    execSync(`bun run ${serverEntry}`, {
      stdio: "inherit",
      cwd: PLUGIN_DIR,
      env: {
        ...process.env,
        AGENTBOARD2_DIR: PLUGIN_DIR,
      },
    });
  }

  // Foreground command — blocks until TUI exits
  private startTui(): void {
    this.ensureDeps();

    const tuiEntry = resolve(PLUGIN_DIR, "apps/tui/src/index.tsx");

    execSync(`bun run ${tuiEntry}`, {
      stdio: "inherit",
      cwd: resolve(PLUGIN_DIR, "apps/tui"),
      env: {
        ...process.env,
        AGENTBOARD2_DIR: PLUGIN_DIR,
      },
    });
  }

  private showKeys(): void {
    // Get tmux prefix and agentboard2 key from tmux
    let prefix = "C-a";
    let key = DEFAULT_KEY;
    try {
      prefix = execSync("tmux show-option -gv prefix", {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      const ab2Key = execSync(
        `tmux show-option -gv @agentboard2-key 2>/dev/null || echo ${DEFAULT_KEY}`,
        {
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        },
      ).trim();
      if (ab2Key) key = ab2Key;
    } catch {
      // use defaults
    }

    const { toggle, focus } = TMUX_BINDINGS;
    consola.box(
      [
        `${colors.bold("AgentBoard2 Keybindings")}\n`,
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

  private reloadTmux(): void {
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
}
