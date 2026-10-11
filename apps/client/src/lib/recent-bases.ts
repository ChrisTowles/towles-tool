import type { BaseBranch } from "@/lib/schemas/task";

const REMEMBERED = 6;

/** The new-task form's one-click bases: the repo's default, then the bases
 * tasks were last started from — only those the repo still has. */
export function baseChips(
  branches: readonly BaseBranch[],
  recent: readonly string[],
  max = 4,
): BaseBranch[] {
  const byName = new Map(branches.map((b) => [b.name, b]));
  const names = [branches[0]?.name, ...recent].filter((n): n is string => n !== undefined);
  return [...new Set(names)]
    .map((n) => byName.get(n))
    .filter((b): b is BaseBranch => b !== undefined)
    .slice(0, max);
}

export function rememberBase(recent: readonly string[], name: string): string[] {
  return [name, ...recent.filter((n) => n !== name)].slice(0, REMEMBERED);
}

/** Anything unreadable is no history, never an error. */
export function parseRecentBases(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === "string") : [];
  } catch {
    return [];
  }
}
