import { slugify } from "@/lib/slug";

/** Stripped before humanizing, so the name reads as a sentence rather than
 * "Feat today we use…", and before comparing, so `chore/switch-to-x` and the
 * title "Switch to x" are the same words. */
const FOLDER_NAME_PREFIXES = new Set([
  "feat",
  "fix",
  "chore",
  "docs",
  "refactor",
  "test",
  "perf",
  "build",
  "ci",
  "style",
]);

function branchSlug(branch: string): string {
  return branch
    .toLowerCase()
    .trim()
    .replace(/[^0-9a-z_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/-+$/, "");
}

function stripTypePrefix(slug: string): string {
  const parts = slug.split("-").filter(Boolean);
  return parts.length > 1 && FOLDER_NAME_PREFIXES.has(parts[0]) ? parts.slice(1).join("-") : slug;
}

/** `tt task new` mints the branch *from* the task title, so a rendered title
 * usually says the branch over again. False means they genuinely diverged —
 * renamed task, branch switched by hand — the only case worth a line. */
export function branchRedundant(title: string, branch: string | null | undefined): boolean {
  if (!branch) return false;
  const slug = branchSlug(branch);
  const titleSlug = slugify(title);
  return titleSlug === slug || titleSlug === stripTypePrefix(slug);
}

/** Render-time-only fallback for a folder with no bound task title. */
export function humanizeFolderName(folderName: string): string {
  const parts = folderName.split("-").filter(Boolean);
  if (parts.length > 1 && FOLDER_NAME_PREFIXES.has(parts[0].toLowerCase())) {
    parts.shift();
  }
  if (parts.length === 0) return folderName;
  const words = parts.join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
