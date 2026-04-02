export function createBranchNameFromIssue(issue: { number: number; title: string }): string {
  let slug = issue.title.toLowerCase();
  slug = slug.trim();
  slug = slug.replaceAll(" ", "-");
  slug = slug.replace(/[^0-9a-zA-Z_-]/g, "-");
  slug = slug.replace(/-+/g, "-");
  slug = slug.replace(/-+$/, "");

  return `feature/${issue.number}-${slug}`;
}
