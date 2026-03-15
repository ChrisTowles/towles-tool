import { rmSync } from "node:fs";
import { join } from "node:path";

import { Flags } from "@oclif/core";
import consola from "consola";
import { colors } from "consola/utils";
import prompts from "prompts";

import { BaseCommand } from "../base.js";
import { initConfig } from "../../lib/auto-claude/index.js";
import { LABELS, removeLabel, setLabel } from "../../lib/auto-claude/utils.js";
import { getIssues, isGithubCliInstalled } from "../../utils/git/gh-cli-wrapper.js";
import type { Issue } from "../../utils/git/gh-cli-wrapper.js";

export interface RetryOptions {
  issueNumber?: number;
  clean: boolean;
}

/**
 * Core retry logic: swap labels on failed issues to re-trigger the pipeline.
 * Extracted for testability.
 */
export async function retryIssues(
  repo: string,
  triggerLabel: string,
  failedIssues: Issue[],
  selected: Issue[],
  clean: boolean,
): Promise<number> {
  for (const issue of selected) {
    consola.info(`Retrying issue #${issue.number}: ${issue.title}`);

    await removeLabel(repo, issue.number, LABELS.failed);
    consola.success(`  Removed '${LABELS.failed}' label`);

    await setLabel(repo, issue.number, triggerLabel);
    consola.success(`  Added '${triggerLabel}' label`);

    if (clean) {
      const artifactDir = join(process.cwd(), `.auto-claude/issue-${issue.number}`);
      try {
        rmSync(artifactDir, { recursive: true, force: true });
        consola.success(`  Cleaned artifacts: ${artifactDir}`);
      } catch {
        consola.warn(`  Could not clean artifacts: ${artifactDir}`);
      }
    }
  }

  return selected.length;
}

export default class AutoClaudeRetry extends BaseCommand {
  static override description = "Retry failed auto-claude issues by swapping labels";

  static override examples = [
    {
      description: "Interactively pick failed issues to retry",
      command: "<%= config.bin %> auto-claude retry",
    },
    {
      description: "Retry a specific issue",
      command: "<%= config.bin %> auto-claude retry --issue 42",
    },
    {
      description: "Retry and clean local artifacts",
      command: "<%= config.bin %> auto-claude retry --issue 42 --clean",
    },
  ];

  static override flags = {
    ...BaseCommand.baseFlags,
    issue: Flags.integer({
      char: "i",
      description: "Issue number to retry",
    }),
    clean: Flags.boolean({
      description: "Delete local .auto-claude/issue-{N}/ artifacts",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AutoClaudeRetry);

    const cfg = await initConfig();

    const cliInstalled = await isGithubCliInstalled();
    if (!cliInstalled) {
      this.error("GitHub CLI (gh) is not installed");
    }

    const failedIssues = await getIssues({ cwd: process.cwd(), label: LABELS.failed });

    let selected: Issue[];

    if (flags.issue) {
      const match = failedIssues.find((i) => i.number === flags.issue);
      if (!match) {
        this.error(`Issue #${flags.issue} not found with '${LABELS.failed}' label`);
      }
      selected = [match];
    } else {
      if (failedIssues.length === 0) {
        consola.info(`No open issues with '${LABELS.failed}' label`);
        return;
      }

      consola.info(colors.yellow(`${failedIssues.length} failed issue(s) found`));

      const choices = failedIssues.map((issue) => ({
        title: `#${issue.number} ${issue.title}`,
        value: issue.number,
      }));

      const result = await prompts(
        {
          name: "selected",
          message: "Select issues to retry:",
          type: "multiselect",
          choices,
          instructions: false,
          hint: "- Space to select, Enter to confirm",
        },
        {
          onCancel: () => {
            consola.info(colors.dim("Canceled"));
            this.exit(0);
          },
        },
      );

      if (!result.selected || result.selected.length === 0) {
        consola.info(colors.dim("No issues selected"));
        return;
      }

      selected = failedIssues.filter((i) => result.selected.includes(i.number));
    }

    const count = await retryIssues(cfg.repo, cfg.triggerLabel, failedIssues, selected, flags.clean);
    consola.box(`Retried ${count} issue(s)`);
  }
}
