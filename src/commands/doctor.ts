import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import consola from "consola";
import { x } from "tinyexec";
import { colors } from "consola/utils";
import { BaseCommand } from "./base.js";

interface CheckResult {
  name: string;
  version: string | null;
  ok: boolean;
  warning?: string;
}

/**
 * Check system dependencies and environment
 */
export default class Doctor extends BaseCommand {
  static override description = "Check system dependencies and environment";

  static override examples = [
    { description: "Check system dependencies", command: "<%= config.bin %> <%= command.id %>" },
    { description: "Verify environment after setup", command: "<%= config.bin %> doctor" },
  ];

  async run(): Promise<void> {
    await this.parse(Doctor);

    this.log("Checking dependencies...\n");

    const checks: CheckResult[] = await Promise.all([
      this.checkCommand("git", ["--version"], /git version ([\d.]+)/),
      this.checkCommand("gh", ["--version"], /gh version ([\d.]+)/),
      this.checkCommand("node", ["--version"], /v?([\d.]+)/),
      this.checkCommand("bun", ["--version"], /([\d.]+)/),
      this.checkCommand("pnpm", ["--version"], /([\d.]+)/),
      this.checkCommand("claude", ["--version"], /([\d.]+)/),
      this.checkCommand("tmux", ["-V"], /tmux ([\d.]+)/),
      this.checkCommand("ttyd", ["--version"], /ttyd version ([\d.]+)/, true),
    ]);

    // Display results
    for (const check of checks) {
      const icon = check.ok
        ? colors.green("✓")
        : check.warning
          ? colors.yellow("⚠")
          : colors.red("✗");
      const version = check.version ?? "not found";
      this.log(`${icon} ${check.name}: ${version}`);
      if (check.warning) {
        this.log(`  ${colors.yellow("⚠")} ${check.warning}`);
      }
    }

    // Check gh auth
    this.log("");
    const ghAuth = await this.checkGhAuth();
    const authIcon = ghAuth.ok ? colors.green("✓") : colors.yellow("⚠");
    this.log(`${authIcon} gh auth: ${ghAuth.ok ? "authenticated" : "not authenticated"}`);
    if (!ghAuth.ok) {
      this.log(`  ${colors.dim("Run: gh auth login")}`);
    }

    // Node version check
    const nodeCheck = checks.find((c) => c.name === "node");
    if (nodeCheck?.version) {
      const major = Number.parseInt(nodeCheck.version.split(".")[0], 10);
      if (major < 18) {
        this.log("");
        this.log(`${colors.yellow("⚠")} Node.js 18+ recommended (found ${nodeCheck.version})`);
      }
    }

    // Claude plugin checks
    this.log("");
    const pluginChecks = await this.checkClaudePlugins();
    for (const check of pluginChecks) {
      const icon = check.ok ? colors.green("✓") : colors.red("✗");
      const status = check.ok ? "installed" : "not installed";
      this.log(`${icon} claude plugin ${check.name}: ${status}`);
      if (!check.ok && check.installHint) {
        this.log(`  ${colors.dim(check.installHint)}`);
      }
    }

    // AgentBoard checks
    this.log("");
    this.log(colors.bold("AgentBoard:"));
    const agentboardChecks = this.checkAgentBoard();
    for (const check of agentboardChecks) {
      const icon = check.ok
        ? colors.green("✓")
        : check.warning
          ? colors.yellow("⚠")
          : colors.red("✗");
      this.log(`${icon} ${check.name}: ${check.value}`);
      if (check.hint) {
        this.log(`  ${colors.dim(check.hint)}`);
      }
    }

    // Summary
    const allOk =
      checks.every((c) => c.ok || !!c.warning) &&
      ghAuth.ok &&
      pluginChecks.every((c) => c.ok) &&
      agentboardChecks.every((c) => c.ok || !!c.warning);
    this.log("");
    if (allOk) {
      this.log(colors.green("All checks passed!"));
    } else {
      this.log(colors.yellow("Some checks failed. See above for details."));
    }
  }

  private async checkCommand(
    name: string,
    args: string[],
    versionPattern: RegExp,
    optional = false,
  ): Promise<CheckResult> {
    try {
      // tinyexec is safe - uses execFile internally, no shell injection risk
      const result = await x(name, args);
      const output = result.stdout + result.stderr;
      const match = output.match(versionPattern);
      return {
        name,
        version: match?.[1] ?? output.trim().slice(0, 20),
        ok: true,
      };
    } catch {
      consola.debug(`Tool check failed for "${name}"`);
      return {
        name,
        version: null,
        ok: optional,
        warning: optional ? "optional, not installed" : undefined,
      };
    }
  }

  private async checkGhAuth(): Promise<{ ok: boolean }> {
    try {
      // tinyexec is safe - uses execFile internally, no shell injection risk
      const result = await x("gh", ["auth", "status"]);
      return { ok: result.exitCode === 0 };
    } catch {
      consola.debug("GitHub CLI auth check failed");
      return { ok: false };
    }
  }

  private checkAgentBoard(): {
    name: string;
    value: string;
    ok: boolean;
    warning?: string;
    hint?: string;
  }[] {
    const results: { name: string; value: string; ok: boolean; warning?: string; hint?: string }[] =
      [];

    const defaultDataDir = resolve(
      process.env.XDG_CONFIG_HOME ?? resolve(process.env.HOME ?? "~", ".config"),
      "towles-tool",
      "agentboard",
    );
    const dataDir = process.env.AGENTBOARD_DATA_DIR ?? defaultDataDir;
    const dbPath = join(dataDir, "agentboard.db");
    const configPath = join(dataDir, "config.json");

    // DB exists
    const dbExists = existsSync(dbPath);
    results.push({
      name: "database",
      value: dbExists ? dbPath : "not found",
      ok: dbExists,
      hint: dbExists ? undefined : "Run: tt ag (starts server and creates DB automatically)",
    });

    // Config exists with repoPaths
    let repoPaths: string[] = [];
    if (existsSync(configPath)) {
      try {
        const config = JSON.parse(readFileSync(configPath, "utf-8"));
        repoPaths = config.repoPaths ?? [];
      } catch {
        // Corrupted config
      }
    }

    results.push({
      name: "scan paths",
      value: repoPaths.length > 0 ? repoPaths.join(", ") : "none configured",
      ok: repoPaths.length > 0,
      warning: repoPaths.length === 0 ? "no scan paths" : undefined,
      hint:
        repoPaths.length === 0
          ? "Run: tt ag → open Workspaces → run the onboarding wizard"
          : undefined,
    });

    // Data directory
    results.push({
      name: "data dir",
      value: dataDir,
      ok: true,
    });

    return results;
  }

  private async checkClaudePlugins(): Promise<
    { name: string; ok: boolean; installHint?: string }[]
  > {
    const requiredPlugins = [
      {
        id: "code-simplifier@claude-plugins-official",
        name: "code-simplifier",
        installCmd: "claude plugin install code-simplifier@claude-plugins-official --scope user",
      },
    ];

    try {
      const result = await x("claude", ["plugin", "list", "--json"]);
      const plugins: { id: string }[] = JSON.parse(result.stdout);
      const installedIds = new Set(plugins.map((p) => p.id));

      return requiredPlugins.map((p) => ({
        name: p.name,
        ok: installedIds.has(p.id),
        installHint: installedIds.has(p.id) ? undefined : `Run: ${p.installCmd}`,
      }));
    } catch {
      consola.debug("Failed to list Claude plugins");
      return requiredPlugins.map((p) => ({
        name: p.name,
        ok: false,
        installHint: `Run: ${p.installCmd}`,
      }));
    }
  }
}
