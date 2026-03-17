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
    ]);

    // Display results
    for (const check of checks) {
      const icon = check.ok ? colors.green("✓") : colors.red("✗");
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

    // Summary
    const allOk = checks.every((c) => c.ok) && ghAuth.ok && pluginChecks.every((c) => c.ok);
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
      return { name, version: null, ok: false };
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
