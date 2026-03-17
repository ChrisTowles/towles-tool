import consola from "consola";
import { getConfig } from "../config.js";
import { gh } from "../../../utils/git/gh-cli-wrapper.js";
import { buildIssueContext, log } from "../utils.js";
import type { IssueContext } from "../utils.js";

interface GhIssue {
  number: number;
  title: string;
  body: string;
  labels: { name: string }[];
}

export async function fetchIssues(limit?: number): Promise<IssueContext[]> {
  const cfg = getConfig();

  log(`Scanning ${cfg.repo} for issues labeled "${cfg.triggerLabel}"...`);

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
    log(`Warning: could not fetch issues from ${cfg.repo}: ${e}`);
    return [];
  }

  if (issues.length === 0) {
    log("No issues found.");
    return [];
  }

  log(`Found ${issues.length} issue(s).`);

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
    consola.debug(`Could not fetch issue #${issueNumber} from ${cfg.repo}`);
    return undefined;
  }
}
