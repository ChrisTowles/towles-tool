import { existsSync } from "node:fs";
import { join } from "node:path";

import consola from "consola";
import { colors } from "consola/utils";

import type { Issue } from "../../utils/git/gh-cli-wrapper.js";
import { getIssues, isGithubCliInstalled } from "../../utils/git/gh-cli-wrapper.js";
import { ARTIFACTS } from "../../lib/auto-claude/prompt-templates/index.js";
import { LABELS } from "../../lib/auto-claude/utils.js";
import { BaseCommand } from "../base.js";

/** All labels that indicate an issue is part of the auto-claude pipeline. */
const ALL_AC_LABELS = ["auto-claude", ...Object.values(LABELS)] as const;

/** Map a label to a color function for display. */
function colorForLabel(label: string): (text: string) => string {
  switch (label) {
    case LABELS.inProgress:
      return colors.yellow;
    case LABELS.success:
      return colors.green;
    case LABELS.failed:
      return colors.red;
    case LABELS.review:
      return colors.blue;
    default:
      return colors.dim;
  }
}

/** Friendly short name for display. */
function shortStatus(label: string): string {
  switch (label) {
    case LABELS.inProgress:
      return "in-progress";
    case LABELS.success:
      return "success";
    case LABELS.failed:
      return "failed";
    case LABELS.review:
      return "review";
    default:
      return "queued";
  }
}

interface ArtifactStatus {
  name: string;
  exists: boolean;
}

/** Check which pipeline artifacts exist locally for an issue. */
export function checkArtifacts(issueNumber: number, cwd: string): ArtifactStatus[] {
  const issueDir = join(cwd, `.auto-claude/issue-${issueNumber}`);
  return [
    { name: "plan.md", exists: existsSync(join(issueDir, ARTIFACTS.plan)) },
    {
      name: "completed-summary.md",
      exists: existsSync(join(issueDir, ARTIFACTS.completedSummary)),
    },
    {
      name: "simplify-summary.md",
      exists: existsSync(join(issueDir, ARTIFACTS.simplifySummary)),
    },
    { name: "review.md", exists: existsSync(join(issueDir, ARTIFACTS.review)) },
  ];
}

/** Find the most specific auto-claude label on an issue. */
export function findAcLabel(issue: Issue): string {
  const labelNames = issue.labels.map((l) => l.name);
  // Prefer the most specific status label; fall back to generic "auto-claude"
  for (const label of Object.values(LABELS)) {
    if (labelNames.includes(label)) return label;
  }
  return "auto-claude";
}

/** Format a single issue for display. */
export function formatIssueStatus(
  issue: Issue,
  artifacts: ArtifactStatus[],
): string {
  const label = findAcLabel(issue);
  const colorFn = colorForLabel(label);
  const status = shortStatus(label);
  const statusTag = colorFn(`[${status}]`);

  const parts: string[] = [
    `#${issue.number} ${issue.title} ${statusTag}`,
  ];

  const completedSteps = artifacts.filter((a) => a.exists).map((a) => a.name);
  if (completedSteps.length > 0) {
    parts.push(colors.dim(`  artifacts: ${completedSteps.join(", ")}`));
  }

  return parts.join("\n");
}

/** Fetch issues across all auto-claude labels, deduplicating by issue number. */
export async function fetchAllAcIssues(cwd: string): Promise<Issue[]> {
  const issueMap = new Map<number, Issue>();

  const results = await Promise.all(
    ALL_AC_LABELS.map((label) => getIssues({ cwd, label })),
  );

  for (const issues of results) {
    for (const issue of issues) {
      if (!issueMap.has(issue.number)) {
        issueMap.set(issue.number, issue);
      }
    }
  }

  // Sort by issue number ascending
  return [...issueMap.values()].sort((a, b) => a.number - b.number);
}

export default class AutoClaudeStatus extends BaseCommand {
  static override description = "Show pipeline status for auto-claude issues";

  static override aliases = ["ac:status"];

  static override examples = [
    {
      description: "Show status of all auto-claude issues",
      command: "<%= config.bin %> auto-claude status",
    },
  ];

  async run(): Promise<void> {
    const cliInstalled = await isGithubCliInstalled();
    if (!cliInstalled) {
      this.error("GitHub CLI (gh) is not installed");
    }

    const cwd = process.cwd();
    const issues = await fetchAllAcIssues(cwd);

    if (issues.length === 0) {
      consola.info("No auto-claude issues found");
      return;
    }

    consola.info(colors.bold(`Auto-Claude Pipeline Status (${issues.length} issue(s))`));
    consola.log("");

    for (const issue of issues) {
      const artifacts = checkArtifacts(issue.number, cwd);
      consola.log(formatIssueStatus(issue, artifacts));
    }
  }
}
