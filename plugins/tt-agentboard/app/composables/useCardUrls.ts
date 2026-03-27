import type { Card } from "~/stores/cards";

export function useCardUrls(card: Ref<Card> | ComputedRef<Card>) {
  function buildGithubUrl(path: string) {
    const c = toValue(card);
    if (c.repo?.githubUrl) return `${c.repo.githubUrl}/${path}`;
    if (c.repo?.org && c.repo?.name)
      return `https://github.com/${c.repo.org}/${c.repo.name}/${path}`;
    return null;
  }

  const branchUrl = computed(() => {
    const c = toValue(card);
    if (!c.branch) return null;
    return buildGithubUrl(`tree/${c.branch}`);
  });

  const issueUrl = computed(() => {
    const c = toValue(card);
    if (!c.githubIssueNumber) return null;
    return buildGithubUrl(`issues/${c.githubIssueNumber}`);
  });

  const prUrl = computed(() => {
    const c = toValue(card);
    if (!c.githubPrNumber) return null;
    return buildGithubUrl(`pull/${c.githubPrNumber}`);
  });

  return { branchUrl, issueUrl, prUrl };
}
