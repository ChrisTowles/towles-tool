import { Flags } from "@oclif/core";
import consola from "consola";
import { colors } from "consola/utils";
import { Fzf } from "fzf";
import prompts from "prompts";
import type { Choice } from "prompts";

import { BaseCommand } from "../base.js";
import { buildIssueChoices, computeColumnLayout } from "../gh/branch.js";
import { STEP_NAMES, fetchIssue, initConfig, runPipeline } from "../../lib/auto-claude/index.js";
import type { StepName } from "../../lib/auto-claude/index.js";
import { getIssues, isGithubCliInstalled } from "../../utils/git/gh-cli-wrapper.js";
import { getTerminalColumns } from "../../utils/render.js";

export default class AutoClaudeList extends BaseCommand {
  static override description = "Interactively pick an auto-claude issue to process";

  static override examples = [
    {
      description: "Browse auto-claude labeled issues",
      command: "<%= config.bin %> auto-claude list",
    },
    {
      description: "Pick an issue and run until plan step",
      command: "<%= config.bin %> auto-claude list --until plan",
    },
  ];

  static override flags = {
    ...BaseCommand.baseFlags,
    until: Flags.string({
      char: "u",
      description: `Stop after this step (${STEP_NAMES.join(", ")})`,
      options: [...STEP_NAMES],
    }),
    label: Flags.string({
      description: "Trigger label (default: auto-claude)",
    }),
    "main-branch": Flags.string({
      description: "Override main branch detection",
    }),
    "scope-path": Flags.string({
      description: "Path within repo to scope work (default: .)",
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AutoClaudeList);

    const cfg = await initConfig({
      triggerLabel: flags.label,
      mainBranch: flags["main-branch"],
      scopePath: flags["scope-path"],
    });

    const cliInstalled = await isGithubCliInstalled();
    if (!cliInstalled) {
      this.error("GitHub CLI (gh) is not installed");
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
            this.exit(0);
          },
        },
      );

      if (result.issueNumber === "cancel") {
        consola.info(colors.dim("Canceled"));
        return;
      }

      const ctx = await fetchIssue(result.issueNumber);
      if (!ctx) {
        this.error(`Could not fetch issue #${result.issueNumber}`);
      }

      const untilStep = flags.until as StepName | undefined;
      await runPipeline(ctx, untilStep);
    } catch {
      this.exit(1);
    }
  }
}
