import { existsSync } from "node:fs";
import { join } from "node:path";

import { defineCommand } from "citty";
import consola from "consola";
import { colors } from "consola/utils";

import type { Issue } from "@towles/shared";
import { getIssues, isGithubCliInstalled } from "@towles/shared";
import { ARTIFACTS } from "./prompt-templates/index.js";
import { LABELS } from "./labels.js";
import { debugArg } from "../shared.js";

/** All labels that indicate an issue is part of the auto-claude pipeline. */
const ALL_AC_LABELS = ["auto-claude", ...Object.values(LABELS)] as const;

/** Display config per label: short name + color function. */
const LABEL_DISPLAY: Record<string, { status: string; color: (t: string) => string }> = {
  [LABELS.inProgress]: { status: "in-progress", color: colors.yellow },
  [LABELS.success]: { status: "success", color: colors.green },
  [LABELS.failed]: { status: "failed", color: colors.red },
  [LABELS.review]: { status: "review", color: colors.blue },
};

const DEFAULT_DISPLAY = { status: "queued", color: colors.dim };

interface ArtifactStatus {
  name: string;
  exists: boolean;
}

/** Pipeline artifacts to check, in pipeline order. */
const CHECKED_ARTIFACTS = [
  ARTIFACTS.plan,
  ARTIFACTS.completedSummary,
  ARTIFACTS.simplifySummary,
  ARTIFACTS.review,
] as const;

/** Check which pipeline artifacts exist locally for an issue. */
export function checkArtifacts(issueNumber: number, cwd: string): ArtifactStatus[] {
  const issueDir = join(cwd, `.auto-claude/issue-${issueNumber}`);
  return CHECKED_ARTIFACTS.map((name) => ({ name, exists: existsSync(join(issueDir, name)) }));
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
export function formatIssueStatus(issue: Issue, artifacts: ArtifactStatus[]): string {
  const label = findAcLabel(issue);
  const { status, color } = LABEL_DISPLAY[label] ?? DEFAULT_DISPLAY;
  const statusTag = color(`[${status}]`);

  const parts: string[] = [`#${issue.number} ${issue.title} ${statusTag}`];

  const completedSteps = artifacts.filter((a) => a.exists).map((a) => a.name);
  if (completedSteps.length > 0) {
    parts.push(colors.dim(`  artifacts: ${completedSteps.join(", ")}`));
  }

  return parts.join("\n");
}

/** Fetch issues across all auto-claude labels, deduplicating by issue number. */
export async function fetchAllAcIssues(cwd: string): Promise<Issue[]> {
  const issueMap = new Map<number, Issue>();

  const results = await Promise.all(ALL_AC_LABELS.map((label) => getIssues({ cwd, label })));

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

export default defineCommand({
  meta: { name: "status", description: "Show pipeline status for auto-claude issues" },
  args: { debug: debugArg },
  async run() {
    const cliInstalled = await isGithubCliInstalled();
    if (!cliInstalled) {
      consola.error("GitHub CLI (gh) is not installed");
      process.exit(1);
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
  },
});
