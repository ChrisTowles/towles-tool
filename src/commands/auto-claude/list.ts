import { defineCommand } from "citty";
import consola from "consola";
import { colors } from "consola/utils";
import { Fzf } from "fzf";
import prompts from "prompts";
import type { Choice } from "prompts";

import { debugArg } from "../shared.js";
import { buildIssueChoices, computeColumnLayout } from "../gh/branch.js";
import { STEP_NAMES, runPipeline } from "./pipeline.js";
import { fetchIssue } from "./steps/fetch-issues.js";
import { initConfig } from "./config.js";
import type { StepName } from "./prompt-templates/index.js";
import { getIssues, getTerminalColumns, isGithubCliInstalled } from "@towles/shared";

export default defineCommand({
  meta: { name: "list", description: "Interactively pick an auto-claude issue to process" },
  args: {
    debug: debugArg,
    until: {
      type: "string" as const,
      alias: "u",
      description: `Stop after this step (${STEP_NAMES.join(", ")})`,
    },
    label: {
      type: "string" as const,
      description: "Trigger label (default: auto-claude)",
    },
    "main-branch": {
      type: "string" as const,
      description: "Override main branch detection",
    },
    "scope-path": {
      type: "string" as const,
      description: "Path within repo to scope work (default: .)",
    },
  },
  async run({ args }) {
    const cfg = await initConfig({
      triggerLabel: args.label,
      mainBranch: args["main-branch"],
      scopePath: args["scope-path"],
    });

    const cliInstalled = await isGithubCliInstalled();
    if (!cliInstalled) {
      consola.error("GitHub CLI (gh) is not installed");
      process.exit(1);
    }

    const issues = await getIssues({ cwd: process.cwd(), label: cfg.triggerLabel });
    if (issues.length === 0) {
      consola.info(`No open issues with '${cfg.triggerLabel}' label`);
      return;
    }

    consola.info(colors.green(`${issues.length} issue(s) with '${cfg.triggerLabel}' label`));

    const layout = computeColumnLayout(issues, getTerminalColumns());
    const choices = buildIssueChoices(issues, layout);

    const fzf = new Fzf(choices, {
      selector: (item) => `${item.value} ${item.description}`,
      casing: "case-insensitive",
    });

    try {
      const result = await prompts(
        {
          name: "issueNumber",
          message: "Pick an issue to process:",
          type: "autocomplete",
          choices,
          async suggest(input: string, choices: Choice[]) {
            const results = fzf.find(input);
            return results.map((r) => choices.find((c) => c.value === r.item.value));
          },
        },
        {
          onCancel: () => {
            consola.info(colors.dim("Canceled"));
            process.exit(0);
          },
        },
      );

      if (result.issueNumber === "cancel") {
        consola.info(colors.dim("Canceled"));
        return;
      }

      const ctx = await fetchIssue(result.issueNumber);
      if (!ctx) {
        consola.error(`Could not fetch issue #${result.issueNumber}`);
        process.exit(1);
      }

      const untilStep = args.until as StepName | undefined;
      await runPipeline(ctx, untilStep);
    } catch (e) {
      consola.error(e);
      process.exit(1);
    }
  },
});
