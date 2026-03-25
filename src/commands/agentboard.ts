import { Args, Flags } from "@oclif/core";
import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { networkInterfaces } from "node:os";
import consola from "consola";
import { BaseCommand } from "./base.js";

function getLocalIp(): string {
  const nets = networkInterfaces();
  for (const ifaces of Object.values(nets)) {
    if (!ifaces) continue;
    for (const iface of ifaces) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "localhost";
}

export default class Agentboard extends BaseCommand {
  static override aliases = ["ag"];
  static override description = "Start AgentBoard — agentic workflow orchestration IDE";

  static override examples = [
    {
      description: "Start AgentBoard on default port",
      command: "<%= config.bin %> agentboard",
    },
    {
      description: "Start on a custom port",
      command: "<%= config.bin %> ag --port 3000",
    },
    {
      description: "Start without opening browser",
      command: "<%= config.bin %> ag --no-open",
    },
    {
      description: "Attach to a running card tmux session",
      command: "<%= config.bin %> ag attach 42",
    },
  ];

  static override flags = {
    port: Flags.string({
      char: "p",
      description: "Port to serve on",
      default: "4200",
    }),
    open: Flags.boolean({
      description: "Open browser after starting",
      default: true,
      allowNo: true,
    }),
    "data-dir": Flags.string({
      char: "d",
      description: "Directory for AgentBoard data (SQLite DB, artifacts)",
      env: "AGENTBOARD_DATA_DIR",
    }),
  };

  static override args = {
    subcommand: Args.string({
      description: "Subcommand (attach, reset)",
      required: false,
    }),
    cardId: Args.string({
      description: "Card ID for attach subcommand",
      required: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Agentboard);

    if (args.subcommand === "attach") {
      if (!args.cardId) {
        this.error("Card ID is required for attach subcommand");
      }
      execSync(`tmux attach-session -t card-${args.cardId}`, {
        stdio: "inherit",
      });
      return;
    }

    if (args.subcommand === "reset") {
      const defaultDataDir = resolve(
        process.env.XDG_CONFIG_HOME ?? resolve(process.env.HOME ?? "~", ".config"),
        "towles-tool",
        "agentboard",
      );
      const dataDir = flags["data-dir"] ? resolve(flags["data-dir"]) : defaultDataDir;
      const dbPath = join(dataDir, "agentboard.db");
      const walPath = `${dbPath}-wal`;
      const shmPath = `${dbPath}-shm`;

      if (!existsSync(dbPath)) {
        consola.info("No database found — nothing to reset.");
        return;
      }

      consola.warn(`This will delete: ${dbPath}`);
      for (const f of [dbPath, walPath, shmPath]) {
        if (existsSync(f)) {
          const { unlinkSync } = await import("node:fs");
          unlinkSync(f);
        }
      }
      consola.success("Database reset. Start AgentBoard to create a fresh DB.");
      return;
    }

    const agentboardDir = resolve(import.meta.dirname, "../../plugins/tt-agentboard");
    const port = flags.port;
    const defaultDataDir = resolve(
      process.env.XDG_CONFIG_HOME ?? resolve(process.env.HOME ?? "~", ".config"),
      "towles-tool",
      "agentboard",
    );
    const dataDir = flags["data-dir"] ? resolve(flags["data-dir"]) : defaultDataDir;
    const localIp = getLocalIp();
    const dbPath = join(dataDir, "agentboard.db");
    const isFirstRun = !existsSync(dbPath);

    consola.box(
      `AgentBoard\n\n  Local:   http://localhost:${port}\n  Network: http://${localIp}:${port}\n  Data:    ${dataDir}`,
    );

    if (isFirstRun) {
      consola.info("First run detected — a new database will be created at startup.");
      consola.info(
        "Setup checklist:\n" +
          "  1. Ensure tmux is installed (sudo apt install tmux / brew install tmux)\n" +
          "  2. Set GITHUB_TOKEN for GitHub features (optional)\n" +
          "  3. Open the board → Workspaces → Add a workspace slot\n" +
          "  4. Create your first card and drag it to In Progress",
      );
    }

    const proc = spawn("pnpm", ["dev", "--port", port], {
      cwd: agentboardDir,
      stdio: "inherit",
      env: { ...process.env, NUXT_DEV_HOST: "0.0.0.0", AGENTBOARD_DATA_DIR: dataDir },
    });

    if (flags.open) {
      setTimeout(() => {
        try {
          execSync(`xdg-open http://localhost:${port}`, { stdio: "ignore" });
        } catch {
          consola.debug("Could not open browser automatically");
        }
      }, 2000);
    }

    proc.on("exit", (code) => process.exit(code ?? 0));
  }
}
