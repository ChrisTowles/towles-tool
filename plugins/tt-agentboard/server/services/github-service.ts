import { Octokit } from "octokit";
import { eventBus } from "../utils/event-bus";
import { logger } from "../utils/logger";

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

export class GitHubService {
  private octokit: Octokit;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(token?: string) {
    const ghToken = token ?? process.env.GITHUB_TOKEN;
    if (!ghToken) {
      throw new Error("GITHUB_TOKEN is required for GitHub integration");
    }
    this.octokit = new Octokit({ auth: ghToken });
  }

  async getIssuesWithLabel(owner: string, repo: string, label: string): Promise<GitHubIssue[]> {
    const { data } = await this.octokit.rest.issues.listForRepo({
      owner,
      repo,
      labels: label,
      state: "open",
      per_page: 100,
    });

    return data.map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body ?? null,
      labels: issue.labels
        .map((l) => (typeof l === "string" ? l : l.name))
        .filter((n): n is string => n != null),
      html_url: issue.html_url,
    }));
  }

  async createIssue(owner: string, repo: string, title: string, body: string, labels?: string[]) {
    const { data } = await this.octokit.rest.issues.create({
      owner,
      repo,
      title,
      body,
      labels,
    });
    return data;
  }

  async transitionLabels({ owner, repo, issueNumber, remove, add }: LabelTransition) {
    if (remove?.length) {
      for (const label of remove) {
        try {
          await this.octokit.rest.issues.removeLabel({
            owner,
            repo,
            issue_number: issueNumber,
            name: label,
          });
        } catch {
          logger.debug(`Label "${label}" not found on issue #${issueNumber}, skipping removal`);
        }
      }
    }

    if (add?.length) {
      await this.octokit.rest.issues.addLabels({
        owner,
        repo,
        issue_number: issueNumber,
        labels: add,
      });
    }
  }

  async createBranch(owner: string, repo: string, branchName: string, baseBranch: string = "main") {
    const { data: ref } = await this.octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${baseBranch}`,
    });
    const sha = ref.object.sha;

    await this.octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha,
    });

    return { branchName, sha };
  }

  async createPr({ owner, repo, title, body, head, base }: CreatePrOptions) {
    const { data } = await this.octokit.rest.pulls.create({
      owner,
      repo,
      title,
      body,
      head,
      base,
    });
    return data;
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
            eventBus.emit("github:issue-found", {
              issueNumber: issue.number,
              repoId,
              title: issue.title,
              body: issue.body,
              labels: issue.labels,
            });
          }
        } catch (error) {
          logger.error(`Failed to poll issues for ${owner}/${repo}:`, error);
        }
      }
    };

    // Poll immediately, then on interval
    poll();
    this.pollTimer = setInterval(poll, intervalMs);
    logger.info(`GitHub polling started (interval: ${intervalMs}ms)`);
  }

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      logger.info("GitHub polling stopped");
    }
  }
}

// Lazy singleton — created on first access so missing token doesn't crash startup
let _instance: GitHubService | null = null;

export function getGitHubService(): GitHubService {
  if (!_instance) {
    _instance = new GitHubService();
  }
  return _instance;
}
