import { execSync } from "node:child_process";
import { eventBus } from "../../utils/event-bus";
import { logger } from "../../utils/logger";

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
  execSync: typeof execSync;
  eventBus: typeof eventBus;
  logger: typeof logger;
}

export class GitHubService {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private deps: GitHubServiceDeps;

  constructor(deps: Partial<GitHubServiceDeps> = {}) {
    this.deps = { execSync, eventBus, logger, ...deps };
  }

  private ghExec(args: string): string {
    return this.deps.execSync(`gh ${args}`, { encoding: "utf-8" }).trim();
  }

  private ghJson<T>(args: string): T {
    const output = this.ghExec(args);
    return JSON.parse(output) as T;
  }

  async getIssuesWithLabel(owner: string, repo: string, label: string): Promise<GitHubIssue[]> {
    const raw = this.ghJson<GhIssue[]>(
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
    const raw = this.ghJson<GhIssue[]>(
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

  async createIssue(owner: string, repo: string, title: string, body: string, labels?: string[]) {
    const labelArgs = labels?.length ? labels.map((l) => `--label "${l}"`).join(" ") : "";
    // gh issue create returns the URL on stdout (no --json support)
    const url = this.ghExec(
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
      this.ghExec(`issue edit ${owner}/${repo}#${issueNumber} ${editArgs.join(" ")}`);
    } catch (error) {
      this.deps.logger.debug(`Label transition failed for issue #${issueNumber}: ${error}`);
    }
  }

  async createBranch(owner: string, repo: string, branchName: string, baseBranch: string = "main") {
    // Use gh api to get the base ref SHA, then create the branch
    const sha = this.ghJson<{ object: { sha: string } }>(
      `api repos/${owner}/${repo}/git/ref/heads/${baseBranch} --jq .object.sha`,
    );

    // For branch creation, use the API directly
    this.ghExec(
      `api repos/${owner}/${repo}/git/refs -f ref="refs/heads/${branchName}" -f sha="${typeof sha === "string" ? sha : sha.object.sha}"`,
    );

    return { branchName, sha: typeof sha === "string" ? sha : sha.object.sha };
  }

  async createPr({ owner, repo, title, body, head, base }: CreatePrOptions) {
    // gh pr create returns the URL on stdout (no --json support)
    const url = this.ghExec(
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

export function isGitHubConfigured(): boolean {
  if (_ghAuthCache !== null) return _ghAuthCache;
  try {
    execSync("gh auth status", { encoding: "utf-8", stdio: "pipe" });
    _ghAuthCache = true;
  } catch {
    _ghAuthCache = false;
  }
  return _ghAuthCache;
}
