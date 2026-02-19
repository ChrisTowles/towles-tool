import { exec, x } from "tinyexec";

export const isGitDirectory = async (): Promise<boolean> => {
  try {
    const result = await exec(`git`, ["status"]);
    return result.stdout.includes("On branch");
  } catch (e) {
    return false;
  }
};

export const createBranch = async ({ branchName }: { branchName: string }): Promise<string> => {
  const result = await exec(`git`, ["checkout", "-b", branchName]);
  return result.stdout;
};

export const getLocalBranches = async (cwd: string): Promise<string[]> => {
  const result = await x("git", ["branch", "--format=%(refname:short)"], {
    nodeOptions: { cwd },
  });
  return result.stdout
    .split("\n")
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
};

export const getCurrentBranch = async (cwd: string): Promise<string> => {
  const result = await x("git", ["branch", "--show-current"], {
    nodeOptions: { cwd },
  });
  return result.stdout.trim();
};

export const getMergedBranches = async (cwd: string, base: string): Promise<string[]> => {
  const result = await x("git", ["branch", "--merged", base], {
    nodeOptions: { cwd },
  });
  return result.stdout
    .split("\n")
    .map((b) => b.trim().replace(/^\* /, ""))
    .filter((b) => b.length > 0);
};

export const getGoneBranches = async (cwd: string): Promise<string[]> => {
  const result = await x("git", ["branch", "-vv"], {
    nodeOptions: { cwd },
  });
  const gone: string[] = [];
  for (const line of result.stdout.split("\n")) {
    const match = line.match(/^\*?\s+(\S+)\s+\S+\s+\[.+: gone\]/);
    if (match) {
      gone.push(match[1]);
    }
  }
  return gone;
};

export const deleteBranch = async (cwd: string, branch: string, force: boolean): Promise<void> => {
  await x("git", ["branch", force ? "-D" : "-d", branch], {
    nodeOptions: { cwd },
  });
};
