import { Flags } from "@oclif/core";
import { colors } from "consola/utils";
import consola from "consola";
import { BaseCommand } from "./base.js";
import {
  CLAUDE_SETTINGS_PATH,
  loadClaudeSettings,
  applyRecommendedSettings,
  saveClaudeSettings,
} from "../lib/install/claude-settings.js";

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

    this.log(colors.bold("\n🔧 towles-tool install\n"));

    // Load or create Claude settings
    const existing = loadClaudeSettings(CLAUDE_SETTINGS_PATH);
    if (Object.keys(existing).length > 0) {
      this.log(colors.dim(`Found existing Claude settings at ${CLAUDE_SETTINGS_PATH}`));
    } else {
      this.log(colors.dim(`No Claude settings file found, will create one`));
    }

    // Apply recommended settings
    const { settings, changes } = applyRecommendedSettings(existing);

    for (const change of changes) {
      this.log(colors.green(`✓ ${change}`));
    }

    // Report already-correct settings
    if (!changes.some((c) => c.includes("cleanupPeriodDays"))) {
      this.log(colors.dim("✓ cleanupPeriodDays already set to 99999"));
    }
    if (!changes.some((c) => c.includes("alwaysThinkingEnabled"))) {
      this.log(colors.dim("✓ alwaysThinkingEnabled already set to true"));
    }

    // Save settings if anything changed
    if (changes.length > 0) {
      saveClaudeSettings(CLAUDE_SETTINGS_PATH, settings);
      this.log(colors.green(`\n✓ Saved Claude settings to ${CLAUDE_SETTINGS_PATH}`));
    }

    // Show observability setup if requested
    if (flags.observability) {
      this.log(colors.bold("\n📊 Observability Setup\n"));
      this.showOtelInstructions();
    }

    // Install Claude plugins
    this.log(colors.bold("\n📦 Claude Plugins\n"));
    await this.ensureClaudePlugins();

    this.log(colors.bold(colors.green("\n✅ Installation complete!\n")));
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
      this.log(colors.yellow("⚠ Could not list Claude plugins"));
    }

    // Ensure marketplaces are added first
    for (const plugin of requiredPlugins) {
      if (plugin.marketplaceUrl && !installedIds.has(plugin.id)) {
        try {
          await x("claude", ["plugin", "marketplace", "add", plugin.marketplaceUrl]);
          this.log(colors.dim(`  Added marketplace: ${plugin.marketplace}`));
        } catch {
          // marketplace may already be added
        }
      }
    }

    // Install missing plugins
    for (const plugin of requiredPlugins) {
      if (installedIds.has(plugin.id)) {
        this.log(colors.dim(`✓ ${plugin.name} already installed`));
        continue;
      }

      const answer = await consola.prompt(`Install ${plugin.name} plugin?`, {
        type: "confirm",
        initial: true,
      });

      if (answer) {
        const result = await x("claude", ["plugin", "install", plugin.id, "--scope", "user"]);
        if (result.exitCode === 0) {
          this.log(colors.green(`✓ ${plugin.name} installed`));
        } else {
          if (result.stdout) this.log(result.stdout);
          if (result.stderr) this.log(colors.dim(result.stderr));
          this.log(colors.yellow(`⚠ ${plugin.name} install exited with code ${result.exitCode}`));
        }
      } else {
        this.log(colors.dim(`  Skipped ${plugin.name}`));
      }
    }
  }

  private showOtelInstructions(): void {
    this.log(colors.cyan("Add these environment variables to your shell profile:\n"));

    consola.box(`export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317`);

    this.log("");
    this.log(
      colors.dim("For more info, see: https://github.com/anthropics/claude-code-monitoring-guide"),
    );
    this.log("");
    this.log(colors.cyan("Quick cost analysis (no setup required):"));
    this.log(colors.dim("  npx ccusage@latest --breakdown"));
  }
}
