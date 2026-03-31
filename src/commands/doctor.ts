import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { defineCommand } from "citty";
import consola from "consola";
import { x } from "tinyexec";
import { colors } from "consola/utils";
import { debugArg } from "./shared.js";

interface CheckResult {
  name: string;
  version: string | null;
  ok: boolean;
  warning?: string;
}

async function checkCommand(
  name: string,
  args: string[],
  versionPattern: RegExp,
  optional = false,
): Promise<CheckResult> {
  try {
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

async function checkGhAuth(): Promise<{ ok: boolean }> {
  try {
    const result = await x("gh", ["auth", "status"]);
    return { ok: result.exitCode === 0 };
  } catch {
    consola.debug("GitHub CLI auth check failed");
    return { ok: false };
  }
}

function checkAgentBoard(): {
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

  const dbExists = existsSync(dbPath);
  results.push({
    name: "database",
    value: dbExists ? dbPath : "not found",
    ok: dbExists,
    hint: dbExists ? undefined : "Run: tt ag (starts server and creates DB automatically)",
  });

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

  results.push({
    name: "data dir",
    value: dataDir,
    ok: true,
  });

  return results;
}

async function checkClaudePlugins(): Promise<{ name: string; ok: boolean; installHint?: string }[]> {
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

export default defineCommand({
  meta: { name: "doctor", description: "Check system dependencies and environment" },
  args: { debug: debugArg },
  async run() {
    consola.info("Checking dependencies...\n");

    const checks: CheckResult[] = await Promise.all([
      checkCommand("git", ["--version"], /git version ([\d.]+)/),
      checkCommand("gh", ["--version"], /gh version ([\d.]+)/),
      checkCommand("node", ["--version"], /v?([\d.]+)/),
      checkCommand("bun", ["--version"], /([\d.]+)/),
      checkCommand("tsx", ["--version"], /([\d.]+)/),
      checkCommand("claude", ["--version"], /([\d.]+)/),
      checkCommand("tmux", ["-V"], /tmux ([\d.]+)/),
      checkCommand("ttyd", ["--version"], /ttyd version ([\d.]+)/, true),
    ]);

    for (const check of checks) {
      const icon = check.ok
        ? colors.green("✓")
        : check.warning
          ? colors.yellow("⚠")
          : colors.red("✗");
      const version = check.version ?? "not found";
      consola.log(`${icon} ${check.name}: ${version}`);
      if (check.warning) {
        consola.log(`  ${colors.yellow("⚠")} ${check.warning}`);
      }
    }

    consola.log("");
    const ghAuth = await checkGhAuth();
    const authIcon = ghAuth.ok ? colors.green("✓") : colors.yellow("⚠");
    consola.log(`${authIcon} gh auth: ${ghAuth.ok ? "authenticated" : "not authenticated"}`);
    if (!ghAuth.ok) {
      consola.log(`  ${colors.dim("Run: gh auth login")}`);
    }

    const nodeCheck = checks.find((c) => c.name === "node");
    if (nodeCheck?.version) {
      const major = Number.parseInt(nodeCheck.version.split(".")[0], 10);
      if (major < 18) {
        consola.log("");
        consola.log(`${colors.yellow("⚠")} Node.js 18+ recommended (found ${nodeCheck.version})`);
      }
    }

    consola.log("");
    const pluginChecks = await checkClaudePlugins();
    for (const check of pluginChecks) {
      const icon = check.ok ? colors.green("✓") : colors.red("✗");
      const status = check.ok ? "installed" : "not installed";
      consola.log(`${icon} claude plugin ${check.name}: ${status}`);
      if (!check.ok && check.installHint) {
        consola.log(`  ${colors.dim(check.installHint)}`);
      }
    }

    consola.log("");
    consola.log(colors.bold("AgentBoard:"));
    const agentboardChecks = checkAgentBoard();
    for (const check of agentboardChecks) {
      const icon = check.ok
        ? colors.green("✓")
        : check.warning
          ? colors.yellow("⚠")
          : colors.red("✗");
      consola.log(`${icon} ${check.name}: ${check.value}`);
      if (check.hint) {
        consola.log(`  ${colors.dim(check.hint)}`);
      }
    }

    const allOk =
      checks.every((c) => c.ok || !!c.warning) &&
      ghAuth.ok &&
      pluginChecks.every((c) => c.ok) &&
      agentboardChecks.every((c) => c.ok || !!c.warning);
    consola.log("");
    if (allOk) {
      consola.log(colors.green("All checks passed!"));
    } else {
      consola.log(colors.yellow("Some checks failed. See above for details."));
    }
  },
});
