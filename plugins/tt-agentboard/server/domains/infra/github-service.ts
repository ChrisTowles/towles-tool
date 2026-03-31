import { eventBus } from "../../shared/event-bus";
import { logger } from "../../utils/logger";
import { ptyExecShell as defaultPtyExecShell } from "./pty-exec";
import type { PtyExecShellFn } from "./pty-exec";

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  labels: string[];
  html_url: string;
}

interface CreatePrOptions {
  owner: string;
  repo: string;
  title: string;
  body: string;
  head: string;
  base: string;
}

interface LabelTransition {
  owner: string;
  repo: string;
  issueNumber: number;
  remove?: string[];
  add?: string[];
}

interface GhIssue {
  number: number;
  title: string;
  body: string;
  labels: { name: string }[];
  url: string;
}

export interface GitHubServiceDeps {
  exec: PtyExecShellFn;
  eventBus: typeof eventBus;
  logger: typeof logger;
}

export class GitHubService {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private deps: GitHubServiceDeps;

  constructor(deps: Partial<GitHubServiceDeps> = {}) {
    this.deps = { exec: defaultPtyExecShell, eventBus, logger, ...deps };
  }

  private async ghExec(args: string): Promise<string> {
    const result = await this.deps.exec(`gh ${args}`);
    return result.stdout.trim();
  }

  private async ghJson<T>(args: string): Promise<T> {
    const output = await this.ghExec(args);
    return JSON.parse(output) as T;
  }

  async getIssuesWithLabel(owner: string, repo: string, label: string): Promise<GitHubIssue[]> {
    const raw = await this.ghJson<GhIssue[]>(
      `issue list --repo ${owner}/${repo} --label "${label}" --json number,title,body,labels,url --state open --limit 100`,
    );
    return raw.map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body || null,
      labels: issue.labels.map((l) => l.name),
      html_url: issue.url,
    }));
  }

  async getOpenIssues(owner: string, repo: string): Promise<GitHubIssue[]> {
    const raw = await this.ghJson<GhIssue[]>(
      `issue list --repo ${owner}/${repo} --json number,title,body,labels,url --state open --limit 100`,
    );
    return raw.map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body || null,
      labels: issue.labels.map((l) => l.name),
      html_url: issue.url,
    }));
  }

  async isIssueClosed(owner: string, repo: string, issueNumber: number): Promise<boolean> {
    try {
      const result = await this.ghJson<{ state: string }>(
        `issue view ${issueNumber} --repo ${owner}/${repo} --json state`,
      );
      return result.state.toLowerCase() === "closed";
    } catch {
      return false;
    }
  }

  async createIssue(owner: string, repo: string, title: string, body: string, labels?: string[]) {
    const labelArgs = labels?.length ? labels.map((l) => `--label "${l}"`).join(" ") : "";
    // gh issue create returns the URL on stdout (no --json support)
    const url = await this.ghExec(
      `issue create --repo ${owner}/${repo} --title "${title.replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"')}" ${labelArgs}`,
    );
    const numMatch = url.match(/\/issues\/(\d+)/);
    return { number: numMatch ? Number(numMatch[1]) : 0, html_url: url };
  }

  async transitionLabels({ owner, repo, issueNumber, remove, add }: LabelTransition) {
    const editArgs: string[] = [];

    if (remove?.length) {
      for (const label of remove) {
        editArgs.push(`--remove-label "${label}"`);
      }
    }

    if (add?.length) {
      for (const label of add) {
        editArgs.push(`--add-label "${label}"`);
      }
    }

    if (editArgs.length === 0) return;

    try {
      await this.ghExec(`issue edit ${owner}/${repo}#${issueNumber} ${editArgs.join(" ")}`);
    } catch (error) {
      this.deps.logger.debug(`Label transition failed for issue #${issueNumber}: ${error}`);
    }
  }

  async createBranch(owner: string, repo: string, branchName: string, baseBranch: string = "main") {
    // Use gh api to get the base ref SHA, then create the branch
    const sha = await this.ghJson<{ object: { sha: string } }>(
      `api repos/${owner}/${repo}/git/ref/heads/${baseBranch} --jq .object.sha`,
    );

    // For branch creation, use the API directly
    await this.ghExec(
      `api repos/${owner}/${repo}/git/refs -f ref="refs/heads/${branchName}" -f sha="${typeof sha === "string" ? sha : sha.object.sha}"`,
    );

    return { branchName, sha: typeof sha === "string" ? sha : sha.object.sha };
  }

  async createPr({ owner, repo, title, body, head, base }: CreatePrOptions) {
    // gh pr create returns the URL on stdout (no --json support)
    const url = await this.ghExec(
      `pr create --repo ${owner}/${repo} --title "${title.replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"')}" --base ${base} --head ${head}`,
    );
    const numMatch = url.match(/\/pull\/(\d+)/);
    return { number: numMatch ? Number(numMatch[1]) : 0, html_url: url };
  }

  startPolling(
    repos: Array<{ owner: string; repo: string; repoId: number; triggerLabel: string }>,
    intervalMs: number = 30_000,
  ) {
    if (this.pollTimer) {
      this.stopPolling();
    }

    const poll = async () => {
      for (const { owner, repo, repoId, triggerLabel } of repos) {
        try {
          const issues = await this.getIssuesWithLabel(owner, repo, triggerLabel);
          for (const issue of issues) {
            this.deps.eventBus.emit("github:issue-found", {
              issueNumber: issue.number,
              repoId,
              title: issue.title,
              body: issue.body,
              labels: issue.labels,
            });
          }
        } catch (error) {
          this.deps.logger.error(`Failed to poll issues for ${owner}/${repo}:`, error);
        }
      }
    };

    // Poll immediately, then on interval
    poll();
    this.pollTimer = setInterval(poll, intervalMs);
    this.deps.logger.info(`GitHub polling started (interval: ${intervalMs}ms)`);
  }

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      this.deps.logger.info("GitHub polling stopped");
    }
  }
}

// Lazy singleton
let _instance: GitHubService | null = null;

export function getGitHubService(): GitHubService {
  if (!_instance) {
    _instance = new GitHubService();
  }
  return _instance;
}

let _ghAuthCache: boolean | null = null;

export async function isGitHubConfigured(): Promise<boolean> {
  if (_ghAuthCache !== null) return _ghAuthCache;
  try {
    await defaultPtyExecShell("gh auth status");
    _ghAuthCache = true;
  } catch {
    _ghAuthCache = false;
  }
  return _ghAuthCache;
}
