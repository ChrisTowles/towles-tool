import { execSafe } from "./shell.js";

// ── Label helpers ──

export const LABELS = {
  inProgress: "auto-claude-in-progress",
  review: "auto-claude-review",
  failed: "auto-claude-failed",
  success: "auto-claude-success",
} as const;

export async function ensureLabelsExist(repo: string): Promise<void> {
  await Promise.all(
    Object.values(LABELS).map((label) =>
      execSafe("gh", ["label", "create", label, "--repo", repo, "--force"]),
    ),
  );
}

export async function setLabel(repo: string, issueNumber: number, label: string): Promise<void> {
  await execSafe("gh", [
    "issue",
    "edit",
    String(issueNumber),
    "--repo",
    repo,
    "--add-label",
    label,
  ]);
}

export async function removeLabel(repo: string, issueNumber: number, label: string): Promise<void> {
  await execSafe("gh", [
    "issue",
    "edit",
    String(issueNumber),
    "--repo",
    repo,
    "--remove-label",
    label,
  ]);
}
