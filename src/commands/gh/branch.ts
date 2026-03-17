import { Flags } from "@oclif/core";
import consola from "consola";
import prompts from "prompts";
import type { Choice } from "prompts";
import { colors } from "consola/utils";
import { Fzf } from "fzf";

import { BaseCommand } from "../base.js";
import type { Issue } from "../../utils/git/gh-cli-wrapper.js";
import { getIssues, isGithubCliInstalled } from "../../utils/git/gh-cli-wrapper.js";
import { git } from "../../utils/git/exec.js";
import { createBranchNameFromIssue } from "../../utils/git/branch-name.js";
import { getTerminalColumns, limitText, printWithHexColor } from "../../utils/render.js";

export interface ColumnLayout {
  longestNumber: number;
  longestLabels: number;
  descriptionLength: number;
}

export function computeColumnLayout(issues: Issue[], terminalColumns: number): ColumnLayout {
  const longestNumber = Math.max(...issues.map((i) => i.number.toString().length));
  const longestLabels = Math.max(
    ...issues.map((i) => i.labels.map((x) => x.name).join(", ").length),
  );
  const lineMaxLength = Math.min(terminalColumns, 130);
  const descriptionLength = lineMaxLength - longestNumber - longestLabels - 15;

  return { longestNumber, longestLabels, descriptionLength };
}

export function buildIssueChoices(issues: Issue[], layout: ColumnLayout): Choice[] {
  const choices: Choice[] = issues.map((i) => {
    const labelText = i.labels
      .map((l) => printWithHexColor({ msg: l.name, hex: l.color }))
      .join(", ");
    const labelTextNoColor = i.labels.map((l) => l.name).join(", ");
    const labelStartpad = layout.longestLabels - labelTextNoColor.length;
    return {
      title: i.number.toString(),
      value: i.number,
      description: `${limitText(i.title, layout.descriptionLength).padEnd(layout.descriptionLength)} ${"".padStart(labelStartpad)}${labelText}`,
    } as Choice;
  });
  choices.push({ title: "Cancel", value: "cancel" });
  return choices;
}

/**
 * Create a git branch from a GitHub issue
 */
export default class GhBranch extends BaseCommand {
  static override description = "Create a git branch from a GitHub issue";

  static override examples = [
    { description: "Browse all open issues", command: "<%= config.bin %> <%= command.id %>" },
    {
      description: "Only issues assigned to me",
      command: "<%= config.bin %> <%= command.id %> --assignedToMe",
    },
    { description: "Short flag for assigned", command: "<%= config.bin %> <%= command.id %> -a" },
  ];

  static override flags = {
    ...BaseCommand.baseFlags,
    assignedToMe: Flags.boolean({
      char: "a",
      description: "Only show issues assigned to me",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(GhBranch);

    // Check prerequisites
    const cliInstalled = await isGithubCliInstalled();
    if (!cliInstalled) {
      consola.log("Github CLI not installed");
      this.exit(1);
    }

    consola.log("Assigned to me:", flags.assignedToMe);

    const currentIssues = await getIssues({ assignedToMe: flags.assignedToMe, cwd: process.cwd() });
    if (currentIssues.length === 0) {
      consola.log(colors.yellow("No issues found, check assignments"));
      this.exit(1);
    } else {
      consola.log(colors.green(`${currentIssues.length} Issues found assigned to you`));
    }

    const layout = computeColumnLayout(currentIssues, getTerminalColumns());
    const choices = buildIssueChoices(currentIssues, layout);

    const fzf = new Fzf(choices, {
      selector: (item) => `${item.value} ${item.description}`,
      casing: "case-insensitive",
    });

    try {
      const result = await prompts(
        {
          name: "issueNumber",
          message: "Github issue to create branch for:",
          type: "autocomplete",
          choices,
          async suggest(input: string, choices: Choice[]) {
            consola.log(input);
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
        consola.log(colors.dim("Canceled"));
        this.exit(0);
      }

      const selectedIssue = currentIssues.find((i) => i.number === result.issueNumber)!;
      consola.log(
        `Selected issue ${colors.green(selectedIssue.number)} - ${colors.green(selectedIssue.title)}`,
      );

      const branchName = createBranchNameFromIssue(selectedIssue);
      await git(["checkout", "-b", branchName]);
    } catch {
      consola.debug("Branch checkout failed");
      this.exit(1);
    }
  }
}
