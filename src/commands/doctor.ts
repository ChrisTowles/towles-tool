import { defineCommand } from "citty";
import consola from "consola";
import { colors } from "consola/utils";
import { debugArg } from "./shared.js";
import { runAllChecks, checkAgentBoard, checkClaudePlugins } from "./doctor/checks.js";
import { formatDoctorJson } from "./doctor/format.js";
import { loadHistory, saveHistory, diffRuns } from "./doctor/history.js";
import type { DiffEntry } from "./doctor/history.js";

function formatDiffEntry(entry: DiffEntry): string {
  switch (entry.change) {
    case "added":
      return `${colors.green("+")} ${entry.category}/${entry.name}: added${entry.newValue ? ` (${entry.newValue})` : ""}`;
    case "removed":
      return `${colors.red("-")} ${entry.category}/${entry.name}: removed${entry.oldValue ? ` (was ${entry.oldValue})` : ""}`;
    case "upgraded":
      return `${colors.green("↑")} ${entry.category}/${entry.name}: ${entry.oldValue} → ${entry.newValue}`;
    case "downgraded":
      return `${colors.yellow("↓")} ${entry.category}/${entry.name}: ${entry.oldValue} → ${entry.newValue}`;
    case "passed":
      return `${colors.green("✓")} ${entry.category}/${entry.name}: now passing`;
    case "failed":
      return `${colors.red("✗")} ${entry.category}/${entry.name}: now failing`;
    default:
      return `  ${entry.category}/${entry.name}: unchanged`;
  }
}

export default defineCommand({
  meta: { name: "doctor", description: "Check system dependencies and environment" },
  args: {
    debug: debugArg,
    track: {
      type: "boolean",
      description: "Save check results to history",
      default: false,
    },
    diff: {
      type: "boolean",
      description: "Compare current run against last tracked run",
      default: false,
    },
    format: {
      type: "string",
      description: "Output format: text (default) or json",
      default: "text",
    },
  },
  async run({ args }) {
    const isJson = args.format === "json";

    if (!isJson) {
      consola.info("Checking dependencies...\n");
    }

    const result = await runAllChecks();

    if (isJson) {
      console.log(formatDoctorJson(result));
      return;
    }

    for (const check of result.tools) {
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
    const authIcon = result.ghAuth ? colors.green("✓") : colors.yellow("⚠");
    consola.log(`${authIcon} gh auth: ${result.ghAuth ? "authenticated" : "not authenticated"}`);
    if (!result.ghAuth) {
      consola.log(`  ${colors.dim("Run: gh auth login")}`);
    }

    const nodeCheck = result.tools.find((c) => c.name === "node");
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
      result.tools.every((c) => c.ok || !!c.warning) &&
      result.ghAuth &&
      pluginChecks.every((c) => c.ok) &&
      agentboardChecks.every((c) => c.ok || !!c.warning);
    consola.log("");
    if (allOk) {
      consola.log(colors.green("All checks passed!"));
    } else {
      consola.log(colors.yellow("Some checks failed. See above for details."));
    }

    if (args.track) {
      saveHistory(result);
      consola.log(colors.dim("\nResults saved to history."));
    }

    if (args.diff) {
      const history = loadHistory();
      if (history.length === 0) {
        consola.log(colors.yellow("\nNo previous runs tracked. Use --track to save a run first."));
      } else {
        const previous = history[history.length - 1];
        const diffs = diffRuns(previous, result);
        consola.log(colors.bold(`\nChanges since last tracked run (${previous.timestamp}):`));
        if (diffs.length === 0) {
          consola.log(colors.dim("  No changes detected."));
        } else {
          for (const entry of diffs) {
            consola.log(`  ${formatDiffEntry(entry)}`);
          }
        }
      }
    }
  },
});
