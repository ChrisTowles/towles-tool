import { execSafe as defaultExecSafe } from "../../utils/git/exec.js";

// ── Label helpers ──

export const LABELS = {
  inProgress: "auto-claude-in-progress",
  review: "auto-claude-review",
  failed: "auto-claude-failed",
  success: "auto-claude-success",
} as const;

export type ExecSafeFn = (cmd: string, args: string[]) => Promise<{ stdout: string; ok: boolean }>;

export async function ensureLabelsExist(
  repo: string,
  exec: ExecSafeFn = defaultExecSafe,
): Promise<void> {
  await Promise.all(
    Object.values(LABELS).map((label) =>
      exec("gh", ["label", "create", label, "--repo", repo, "--force"]),
    ),
  );
}

export async function setLabel(
  repo: string,
  issueNumber: number,
  label: string,
  exec: ExecSafeFn = defaultExecSafe,
): Promise<void> {
  await exec("gh", ["issue", "edit", String(issueNumber), "--repo", repo, "--add-label", label]);
}

export async function removeLabel(
  repo: string,
  issueNumber: number,
  label: string,
  exec: ExecSafeFn = defaultExecSafe,
): Promise<void> {
  await exec("gh", ["issue", "edit", String(issueNumber), "--repo", repo, "--remove-label", label]);
}
