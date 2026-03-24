import { Args, Flags } from "@oclif/core";
import { execSync, spawn } from "node:child_process";
import { resolve } from "node:path";
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
      description: "Subcommand (attach)",
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

    const agentboardDir = resolve(import.meta.dirname, "../../plugins/tt-agentboard");
    const port = flags.port;
    const defaultDataDir = resolve(
      process.env.XDG_CONFIG_HOME ?? resolve(process.env.HOME ?? "~", ".config"),
      "towles-tool",
      "agentboard",
    );
    const dataDir = flags["data-dir"] ? resolve(flags["data-dir"]) : defaultDataDir;
    const localIp = getLocalIp();

    consola.box(
      `AgentBoard\n\n  Local:   http://localhost:${port}\n  Network: http://${localIp}:${port}\n  Data:    ${dataDir}`,
    );

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
