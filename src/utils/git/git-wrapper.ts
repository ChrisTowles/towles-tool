import { exec } from "tinyexec";

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
