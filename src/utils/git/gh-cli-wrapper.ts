import stripAnsi from "strip-ansi";
import { x } from "tinyexec";

export async function isGithubCliInstalled(): Promise<boolean> {
  try {
    const proc = await x("gh", ["--version"]);
    return proc.stdout.includes("https://github.com/cli/cli");
  } catch {
    return false;
  }
}

export interface Issue {
  labels: {
    name: string;
    color: string;
  }[];
  number: number;
  title: string;
  state: string;
}

export async function getIssues({
  assignedToMe,
  cwd,
  label,
}: {
  assignedToMe?: boolean;
  cwd: string;
  label?: string;
}): Promise<Issue[]> {
  const args = ["issue", "list", "--json", "labels,number,title,state"];

  if (assignedToMe) {
    args.push("--assignee", "@me");
  }

  if (label) {
    args.push("--label", label);
  }

  const result = await x("gh", args);
  // Setting NO_COLOR=1 didn't remove colors so had to use stripAnsi
  const stripped = stripAnsi(result.stdout);

  try {
    return JSON.parse(stripped) as Issue[];
  } catch {
    throw new Error(
      `Failed to parse GitHub CLI output as JSON. Raw output: ${stripped.slice(0, 200)}${stripped.length > 200 ? "..." : ""}`,
    );
  }
}
