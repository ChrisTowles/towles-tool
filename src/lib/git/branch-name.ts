export function createBranchNameFromIssue(issue: { number: number; title: string }): string {
  const slug = issue.title
    .toLowerCase()
    .trim()
    .replaceAll(" ", "-")
    .replace(/[^0-9a-zA-Z_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/-+$/, "");

  return `feature/${issue.number}-${slug}`;
}
