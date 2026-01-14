import stripAnsi from "strip-ansi";
import { x } from "tinyexec";

export const isGithubCliInstalled = async (): Promise<boolean> => {
  try {
    const proc = await x(`gh`, ["--version"]);
    return proc.stdout.indexOf("https://github.com/cli/cli") > 0;
  } catch (e) {
    return false;
  }
};

export interface Issue {
  labels: {
    name: string;
    color: string;
  }[];
  number: number;
  title: string;
  state: string;
}

export const getIssues = async ({
  assignedToMe,
  cwd,
}: {
  assignedToMe: boolean;
  cwd: string;
}): Promise<Issue[]> => {
  let issues: Issue[] = [];

  const flags = ["issue", "list", "--json", "labels,number,title,state"];

  if (assignedToMe) {
    flags.push("--assignee");
    flags.push("@me");
  }

  //console.log('Current working directory:', cwd.stdout.trim())

  const result = await x(`gh`, flags);
  // Setting NO_COLOR=1 didn't remove colors so had to use stripAnsi
  const stripped = stripAnsi(result.stdout);

  try {
    issues = JSON.parse(stripped);
  } catch {
    throw new Error(
      `Failed to parse GitHub CLI output as JSON. Raw output: ${stripped.slice(0, 200)}${stripped.length > 200 ? "..." : ""}`,
    );
  }

  return issues;
};
