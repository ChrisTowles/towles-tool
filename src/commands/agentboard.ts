import { Args, Flags } from "@oclif/core";
import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { networkInterfaces } from "node:os";
import consola from "consola";
import { colors } from "consola/utils";
import prompts from "prompts";
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
    {
      description: "Selectively clear database (interactive)",
      command: "<%= config.bin %> ag reset",
    },
    {
      description: "Delete entire database without prompting",
      command: "<%= config.bin %> ag reset --all",
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
    lan: Flags.boolean({
      description: "Listen on all interfaces (0.0.0.0) for LAN access. Default: localhost only.",
      default: false,
    }),
    all: Flags.boolean({
      description: "Reset entire database without prompting (for tt ag reset --all)",
      default: false,
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

      if (!existsSync(dbPath)) {
        consola.info("No database found — nothing to reset.");
        return;
      }

      if (flags.all) {
        await this.resetEntireDatabase(dbPath);
        return;
      }

      await this.selectiveClear(dbPath);
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

    const lanMode = flags.lan;
    const host = lanMode ? "0.0.0.0" : "127.0.0.1";

    const lines = [`AgentBoard\n\n  Local:   http://localhost:${port}`];
    if (lanMode) {
      lines.push(`  Network: http://${localIp}:${port}`);
    } else {
      lines.push(`  Network: disabled (use --lan to enable)`);
    }
    lines.push(`  Data:    ${dataDir}`);
    consola.box(lines.join("\n"));

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
      env: {
        ...process.env,
        NUXT_DEV_HOST: host,
        AGENTBOARD_DATA_DIR: dataDir,
        AGENTBOARD_LAN: lanMode ? "1" : "0",
      },
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

  private async resetEntireDatabase(dbPath: string): Promise<void> {
    const walPath = `${dbPath}-wal`;
    const shmPath = `${dbPath}-shm`;
    consola.warn(`This will delete: ${dbPath}`);
    const { unlinkSync } = await import("node:fs");
    for (const f of [dbPath, walPath, shmPath]) {
      if (existsSync(f)) {
        unlinkSync(f);
      }
    }
    consola.success("Database reset. Start AgentBoard to create a fresh DB.");
  }

  private async selectiveClear(dbPath: string): Promise<void> {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const Database = require("better-sqlite3");
    const sqlite = new Database(dbPath) as {
      pragma(stmt: string): void;
      prepare(sql: string): {
        get(): unknown;
        run(): { changes: number };
      };
      close(): void;
    };
    sqlite.pragma("foreign_keys = ON");

    const counts = {
      doneCards: sqlite.prepare("SELECT COUNT(*) as c FROM cards WHERE column = 'done'").get() as {
        c: number;
      },
      failedCards: sqlite
        .prepare("SELECT COUNT(*) as c FROM cards WHERE status = 'failed'")
        .get() as { c: number },
      allCards: sqlite.prepare("SELECT COUNT(*) as c FROM cards").get() as { c: number },
      workflowRuns: sqlite.prepare("SELECT COUNT(*) as c FROM workflow_runs").get() as {
        c: number;
      },
      cardEvents: sqlite.prepare("SELECT COUNT(*) as c FROM card_events").get() as { c: number },
      agentLogs: sqlite.prepare("SELECT COUNT(*) as c FROM agent_logs").get() as { c: number },
    };

    const choices = [
      {
        title: `Completed cards ${colors.dim(`(${counts.doneCards.c} cards in "done" column + events/runs)`)}`,
        value: "done_cards",
        disabled: counts.doneCards.c === 0,
      },
      {
        title: `Failed cards ${colors.dim(`(${counts.failedCards.c} cards with "failed" status + events/runs)`)}`,
        value: "failed_cards",
        disabled: counts.failedCards.c === 0,
      },
      {
        title: `Execution history ${colors.dim(`(${counts.workflowRuns.c} workflow runs, step runs, ${counts.agentLogs.c} agent logs)`)}`,
        value: "execution_history",
        disabled: counts.workflowRuns.c === 0,
      },
      {
        title: `Event logs ${colors.dim(`(${counts.cardEvents.c} card events)`)}`,
        value: "event_logs",
        disabled: counts.cardEvents.c === 0,
      },
      {
        title: `All cards ${colors.dim(`(${counts.allCards.c} cards — keeps repos, boards, slots)`)}`,
        value: "all_cards",
        disabled: counts.allCards.c === 0,
      },
      {
        title: colors.red(`Everything (delete entire database)`),
        value: "everything",
      },
    ];

    const result = await prompts(
      {
        name: "selected",
        message: "What would you like to clear?",
        type: "multiselect",
        choices,
        instructions: false,
        hint: "- Space to select, Enter to confirm",
      },
      {
        onCancel: () => {
          consola.info(colors.dim("Canceled"));
          process.exit(0);
        },
      },
    );

    const selected: string[] = result.selected;
    if (!selected || selected.length === 0) {
      consola.info("Nothing selected.");
      sqlite.close();
      return;
    }

    if (selected.includes("everything")) {
      sqlite.close();
      await this.resetEntireDatabase(dbPath);
      return;
    }

    let totalDeleted = 0;

    if (selected.includes("done_cards")) {
      // Cascade deletes handle events, dependencies, workflow_runs, step_runs, agent_logs
      const deleted = sqlite.prepare("DELETE FROM cards WHERE column = 'done'").run();
      consola.success(`Cleared ${deleted.changes} completed card(s)`);
      totalDeleted += deleted.changes;
    }

    if (selected.includes("failed_cards")) {
      const deleted = sqlite.prepare("DELETE FROM cards WHERE status = 'failed'").run();
      consola.success(`Cleared ${deleted.changes} failed card(s)`);
      totalDeleted += deleted.changes;
    }

    if (selected.includes("execution_history")) {
      // agent_logs and step_runs cascade from workflow_runs
      const deleted = sqlite.prepare("DELETE FROM workflow_runs").run();
      consola.success(`Cleared ${deleted.changes} workflow run(s) and associated logs`);
      totalDeleted += deleted.changes;
    }

    if (selected.includes("event_logs")) {
      const deleted = sqlite.prepare("DELETE FROM card_events").run();
      consola.success(`Cleared ${deleted.changes} event log(s)`);
      totalDeleted += deleted.changes;
    }

    if (selected.includes("all_cards")) {
      const deleted = sqlite.prepare("DELETE FROM cards").run();
      consola.success(`Cleared ${deleted.changes} card(s)`);
      totalDeleted += deleted.changes;
    }

    sqlite.close();

    if (totalDeleted === 0) {
      consola.info("Nothing to clear.");
    } else {
      consola.success("Done.");
    }
  }
}
