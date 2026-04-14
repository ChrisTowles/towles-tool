import { gh } from "@towles/shared";
import { getConfig } from "../config.js";
import { logger } from "../logger.js";
import { buildIssueContext } from "../utils.js";
import type { IssueContext } from "../utils.js";

interface GhIssue {
  number: number;
  title: string;
  body: string;
  labels: { name: string }[];
}

export async function fetchIssues(limit?: number): Promise<IssueContext[]> {
  const cfg = getConfig();

  logger.info(`Scanning ${cfg.repo} for issues labeled "${cfg.triggerLabel}"...`);

  let issues: GhIssue[];
  try {
    issues = await gh<GhIssue[]>([
      "issue",
      "list",
      "--repo",
      cfg.repo,
      "--label",
      cfg.triggerLabel,
      "--state",
      "open",
      "--json",
      "number,title,body,labels",
    ]);
  } catch (e) {
    logger.warn(`Could not fetch issues from ${cfg.repo}: ${e}`);
    return [];
  }

  if (issues.length === 0) {
    logger.info("No issues found.");
    return [];
  }

  logger.info(`Found ${issues.length} issue(s).`);

  const selected = limit != null ? issues.slice(0, limit) : issues;
  return selected.map((issue) => buildIssueContext(issue, cfg.repo, cfg.scopePath));
}

export async function fetchIssue(issueNumber: number): Promise<IssueContext | undefined> {
  const cfg = getConfig();

  try {
    const issue = await gh<GhIssue>([
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      cfg.repo,
      "--json",
      "number,title,body,labels",
    ]);
    return buildIssueContext(issue, cfg.repo, cfg.scopePath);
  } catch {
    logger.debug(`Could not fetch issue #${issueNumber} from ${cfg.repo}`);
    return undefined;
  }
}
