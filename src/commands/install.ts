import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { Flags } from "@oclif/core";
import pc from "picocolors";
import consola from "consola";
import { BaseCommand } from "./base.js";

const CLAUDE_SETTINGS_PATH = path.join(homedir(), ".claude", "settings.json");

interface ClaudeSettings {
  cleanupPeriodDays?: number;
  alwaysThinkingEnabled?: boolean;
  hooks?: Record<string, unknown[]>;
  [key: string]: unknown;
}

/**
 * Install and configure towles-tool with Claude Code
 */
export default class Install extends BaseCommand {
  static override description =
    "Configure Claude Code settings and optionally enable observability";

  static override examples = [
    {
      description: "Configure Claude Code settings",
      command: "<%= config.bin %> <%= command.id %>",
    },
    {
      description: "Include OTEL setup instructions",
      command: "<%= config.bin %> <%= command.id %> --observability",
    },
  ];

  static override flags = {
    ...BaseCommand.baseFlags,
    observability: Flags.boolean({
      char: "o",
      description: "Show OTEL setup instructions and configure SubagentStop hook",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Install);

    this.log(pc.bold("\n🔧 towles-tool install\n"));

    // Load or create Claude settings
    let claudeSettings: ClaudeSettings = {};
    if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
      try {
        const content = fs.readFileSync(CLAUDE_SETTINGS_PATH, "utf-8");
        claudeSettings = JSON.parse(content);
        this.log(pc.dim(`Found existing Claude settings at ${CLAUDE_SETTINGS_PATH}`));
      } catch {
        this.log(
          pc.yellow(`Warning: Could not parse ${CLAUDE_SETTINGS_PATH}, will create fresh settings`),
        );
      }
    } else {
      this.log(pc.dim(`No Claude settings file found, will create one`));
    }

    // Configure recommended settings
    let modified = false;

    // Prevent log deletion (set to ~274 years)
    if (claudeSettings.cleanupPeriodDays !== 99999) {
      claudeSettings.cleanupPeriodDays = 99999;
      modified = true;
      this.log(pc.green("✓ Set cleanupPeriodDays: 99999 (prevent log deletion)"));
    } else {
      this.log(pc.dim("✓ cleanupPeriodDays already set to 99999"));
    }

    // Enable thinking by default
    if (claudeSettings.alwaysThinkingEnabled !== true) {
      claudeSettings.alwaysThinkingEnabled = true;
      modified = true;
      this.log(pc.green("✓ Set alwaysThinkingEnabled: true"));
    } else {
      this.log(pc.dim("✓ alwaysThinkingEnabled already set to true"));
    }

    // Save settings if modified
    if (modified) {
      this.saveClaudeSettings(claudeSettings);
      this.log(pc.green(`\n✓ Saved Claude settings to ${CLAUDE_SETTINGS_PATH}`));
    }

    // Show observability setup if requested
    if (flags.observability) {
      this.log(pc.bold("\n📊 Observability Setup\n"));
      this.showOtelInstructions();
    }

    // Install Claude plugins
    this.log(pc.bold("\n📦 Claude Plugins\n"));
    await this.ensureClaudePlugins();

    this.log(pc.bold(pc.green("\n✅ Installation complete!\n")));
  }

  private async ensureClaudePlugins(): Promise<void> {
    const { x } = await import("tinyexec");

    const requiredPlugins = [
      {
        id: "tt@towles-tool",
        name: "tt-core",
        marketplaceUrl: "https://github.com/ChrisTowles/towles-tool",
        marketplace: "towles-tool",
      },
      {
        id: "code-simplifier@claude-plugins-official",
        name: "code-simplifier",
      },
    ];

    // Get installed plugins
    let installedIds = new Set<string>();
    try {
      const result = await x("claude", ["plugin", "list", "--json"]);
      const plugins: { id: string }[] = JSON.parse(result.stdout);
      installedIds = new Set(plugins.map((p) => p.id));
    } catch {
      this.log(pc.yellow("⚠ Could not list Claude plugins"));
    }

    // Ensure marketplaces are added first
    for (const plugin of requiredPlugins) {
      if (plugin.marketplaceUrl && !installedIds.has(plugin.id)) {
        try {
          await x("claude", ["plugin", "marketplace", "add", plugin.marketplaceUrl]);
          this.log(pc.dim(`  Added marketplace: ${plugin.marketplace}`));
        } catch {
          // marketplace may already be added
        }
      }
    }

    // Install missing plugins
    for (const plugin of requiredPlugins) {
      if (installedIds.has(plugin.id)) {
        this.log(pc.dim(`✓ ${plugin.name} already installed`));
        continue;
      }

      const answer = await consola.prompt(`Install ${plugin.name} plugin?`, {
        type: "confirm",
        initial: true,
      });

      if (answer) {
        const result = await x("claude", ["plugin", "install", plugin.id, "--scope", "user"]);
        if (result.exitCode === 0) {
          this.log(pc.green(`✓ ${plugin.name} installed`));
        } else {
          if (result.stdout) this.log(result.stdout);
          if (result.stderr) this.log(pc.dim(result.stderr));
          this.log(pc.yellow(`⚠ ${plugin.name} install exited with code ${result.exitCode}`));
        }
      } else {
        this.log(pc.dim(`  Skipped ${plugin.name}`));
      }
    }
  }

  private saveClaudeSettings(settings: ClaudeSettings): void {
    const dir = path.dirname(CLAUDE_SETTINGS_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2));
  }

  private showOtelInstructions(): void {
    this.log(pc.cyan("Add these environment variables to your shell profile:\n"));

    consola.box(`export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317`);

    this.log("");
    this.log(
      pc.dim("For more info, see: https://github.com/anthropics/claude-code-monitoring-guide"),
    );
    this.log("");
    this.log(pc.cyan("Quick cost analysis (no setup required):"));
    this.log(pc.dim("  npx ccusage@latest --breakdown"));
  }
}
