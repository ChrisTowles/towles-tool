import * as fs from "node:fs";
import * as path from "node:path";
import { x } from "tinyexec";
import pc from "picocolors";
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
  ];

  async run(): Promise<void> {
    await this.parse(Doctor);

    this.log("Checking dependencies...\n");

    const checks: CheckResult[] = await Promise.all([
      this.checkCommand("git", ["--version"], /git version ([\d.]+)/),
      this.checkCommand("gh", ["--version"], /gh version ([\d.]+)/),
      this.checkCommand("node", ["--version"], /v?([\d.]+)/),
      this.checkCommand("bun", ["--version"], /([\d.]+)/),
    ]);

    // Display results
    for (const check of checks) {
      const icon = check.ok ? pc.green("✓") : pc.red("✗");
      const version = check.version ?? "not found";
      this.log(`${icon} ${check.name}: ${version}`);
      if (check.warning) {
        this.log(`  ${pc.yellow("⚠")} ${check.warning}`);
      }
    }

    // Check gh auth
    this.log("");
    const ghAuth = await this.checkGhAuth();
    const authIcon = ghAuth.ok ? pc.green("✓") : pc.yellow("⚠");
    this.log(`${authIcon} gh auth: ${ghAuth.ok ? "authenticated" : "not authenticated"}`);
    if (!ghAuth.ok) {
      this.log(`  ${pc.dim("Run: gh auth login")}`);
    }

    // Node version check
    const nodeCheck = checks.find((c) => c.name === "node");
    if (nodeCheck?.version) {
      const major = Number.parseInt(nodeCheck.version.split(".")[0], 10);
      if (major < 18) {
        this.log("");
        this.log(`${pc.yellow("⚠")} Node.js 18+ recommended (found ${nodeCheck.version})`);
      }
    }

    // Check ralph files in .gitignore
    this.log("");
    const gitignoreCheck = this.checkRalphGitignore();
    const gitignoreIcon = gitignoreCheck.ok ? pc.green("✓") : pc.yellow("⚠");
    this.log(
      `${gitignoreIcon} .gitignore: ${gitignoreCheck.ok ? "ralph-* excluded" : "ralph-* NOT excluded"}`,
    );
    if (!gitignoreCheck.ok) {
      this.log(`  ${pc.dim('Add "ralph-*" to .gitignore to exclude local ralph state files')}`);
    }

    // Summary
    const allOk = checks.every((c) => c.ok) && ghAuth.ok && gitignoreCheck.ok;
    this.log("");
    if (allOk) {
      this.log(pc.green("All checks passed!"));
    } else {
      this.log(pc.yellow("Some checks failed. See above for details."));
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
      return { name, version: null, ok: false };
    }
  }

  private async checkGhAuth(): Promise<{ ok: boolean }> {
    try {
      // tinyexec is safe - uses execFile internally, no shell injection risk
      const result = await x("gh", ["auth", "status"]);
      return { ok: result.exitCode === 0 };
    } catch {
      return { ok: false };
    }
  }

  private checkRalphGitignore(): { ok: boolean } {
    const gitignorePath = path.join(process.cwd(), ".gitignore");
    try {
      if (!fs.existsSync(gitignorePath)) {
        return { ok: false };
      }
      const content = fs.readFileSync(gitignorePath, "utf-8");
      // Check for ralph-* pattern or specific ralph files
      const hasRalphPattern = content.split("\n").some((line) => {
        const trimmed = line.trim();
        return (
          trimmed === "ralph-*" || trimmed === "ralph-*.json" || trimmed === "ralph-state.json"
        );
      });
      return { ok: hasRalphPattern };
    } catch {
      return { ok: false };
    }
  }
}
